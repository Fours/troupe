import { describe, expect, it } from 'vitest';
import type { Fault, History, HistoryEntry } from '@kylewillett/troupe/rehearsal';
import {
  draw,
  faultNodes,
  faultText,
  isDrawn,
  stateAt,
  trim,
  type Drawing,
} from '../../demo/src/rehearsal/domain/drawing.ts';
import { festival } from '../../demo/src/rehearsal/domain/festival.ts';
import { Runner } from '../../demo/src/rehearsal/domain/runner.ts';
import { FOUND } from './found.ts';

// Milestone 5, T8: the /rehearsal/ page draws a run from its history: a lane per node with its
// states, the shows' instances as bars, the faults, the moment it broke, and the log in plain words.

const RUN: HistoryEntry = {
  kind: 'run',
  time: 0,
  seed: 7,
  mode: 'contract',
  nodes: ['node-1', 'node-2'],
  spares: ['node-3'],
  clients: ['crowd'],
  durationMs: 10_000,
  quietFrom: 8_000,
  leases: { ttlMs: 4_000, renewMs: 1_000, marginMs: 1_000 },
  plan: [],
};

const start = (time: number, node: string, inc = 0): HistoryEntry => ({
  kind: 'start',
  time,
  node,
  inc,
  uid: 100 + inc,
  driftPpm: 0,
});

const event = (
  time: number,
  node: string,
  e: Record<string, string | number | boolean>,
  inc = 0,
): HistoryEntry => ({
  kind: 'event',
  time,
  node,
  inc,
  event: { at: time, seq: 1, type: String(e.type), ...e },
});

const spawned = (time: number, node: string, shard: number, show: string, inc = 0) =>
  event(
    time,
    node,
    { type: 'spawned', path: `/system/sharding/show/${String(shard)}/${show}` },
    inc,
  );

const fault = (time: number, index: number, phase: 'begin' | 'end', f: Fault): HistoryEntry => ({
  kind: 'fault',
  time,
  index,
  phase,
  fault: f,
});

const PAUSE: Fault = { at: 2_000, pause: 'node-2', ms: 1_000 };
const KILL: Fault = { at: 4_000, kill: 'node-1', restartAfterMs: 2_000 };
const SLOW: Fault = { at: 1_000, disk: 'slow', latencyMs: [100, 300], ms: 500 };
const PARTITION: Fault = { at: 5_000, partition: [['node-2'], ['crowd']], ms: 1_000 };
const DELAY: Fault = { at: 6_500, delay: 'node-2', peer: 'crowd', latencyMs: [5, 50], ms: 500 };

/** Two hosts and a crowd: node-2 freezes, node-1 is killed and restarts, hamlet moves twice. */
const HISTORY: History = [
  RUN,
  start(0, 'node-1'),
  start(0, 'node-2'),
  start(0, 'crowd'),
  event(0, 'node-1', { type: 'spawned', path: '/system/sharding' }),
  spawned(1_000, 'node-1', 3, 'hamlet'),
  spawned(1_000, 'node-2', 4, 'lear'),
  fault(1_000, 0, 'begin', SLOW),
  fault(1_500, 0, 'end', SLOW),
  fault(2_000, 1, 'begin', PAUSE),
  fault(3_000, 1, 'end', PAUSE),
  {
    kind: 'invoke',
    time: 3_500,
    op: 0,
    client: 'crowd',
    name: 'buy',
    entity: { type: 'show', id: 'hamlet' },
  },
  { kind: 'send', time: 3_500, op: 0, client: 'crowd', message: { type: 'hold' } },
  {
    kind: 'db',
    time: 3_600,
    node: 'node-1',
    op: 'append',
    target: 'show-hamlet',
    applied: true,
    ok: true,
    reply: 'delivered',
  },
  event(3_600, 'node-1', { type: 'persisted', path: '/system/sharding/show/3/hamlet' }),
  { kind: 'complete', time: 3_700, op: 0, outcome: 'ok', reply: { ok: true } },
  fault(4_000, 2, 'begin', KILL),
  { kind: 'stop', time: 4_000, node: 'node-1', inc: 0, why: 'killed' },
  event(4_500, 'node-2', { type: 'reachability', address: 'node-1', uid: 100, reachable: false }),
  event(4_500, 'crowd', { type: 'reachability', address: 'node-1', uid: 100, reachable: false }),
  fault(5_000, 3, 'begin', PARTITION),
  event(5_000, 'node-2', { type: 'memberDown', address: 'node-1', uid: 100 }),
  event(5_001, 'crowd', { type: 'memberDown', address: 'node-1', uid: 100 }),
  spawned(5_500, 'node-2', 3, 'hamlet'),
  event(5_510, 'node-2', {
    type: 'recovered',
    path: '/system/sharding/show/3/hamlet',
    lastSeq: 2,
  }),
  fault(6_000, 3, 'end', PARTITION),
  fault(6_000, 2, 'end', KILL),
  start(6_000, 'node-1', 1),
  event(6_100, 'node-2', { type: 'memberUp', address: 'node-1', uid: 101 }),
  fault(6_500, 4, 'begin', DELAY),
  fault(7_000, 4, 'end', DELAY),
  event(7_000, 'node-2', {
    type: 'shardReleased',
    entityType: 'show',
    shard: 3,
    reason: 'leaseLost',
  }),
  event(7_000, 'node-2', {
    type: 'shardReleased',
    entityType: 'show',
    shard: 4,
    reason: 'leaseLost',
  }),
  { kind: 'journal', time: 10_000, events: [] },
];

const drawing = draw(HISTORY, {
  invariant: 'oneLiveInstance',
  message: 'show/hamlet ran on node-1#100 and node-2#100 from 5,500 to 6,000',
  time: 5_500,
  until: 6_000,
  nodes: ['node-1#100', 'node-2#100'],
  entity: 'show/hamlet',
});

const lane = (d: Drawing, node: string) => {
  const found = d.lanes.find((l) => l.node === node);
  if (found === undefined) throw new Error(`no lane for ${node}`);
  return found;
};

describe('a run, drawn', () => {
  it('has a lane per node, hosts, then spares, then clients', () => {
    expect(drawing.lanes.map((l) => [l.node, l.role])).toEqual([
      ['node-1', 'host'],
      ['node-2', 'host'],
      ['node-3', 'spare'],
      ['crowd', 'client'],
    ]);
    expect(drawing.endMs).toBe(10_000);
    expect(drawing.seed).toBe(7);
  });

  it('says when each node was up, down, frozen or cut off, end to end', () => {
    expect(lane(drawing, 'node-1').spans).toEqual([
      { from: 0, to: 4_000, state: 'up' },
      { from: 4_000, to: 6_000, state: 'down' },
      { from: 6_000, to: 10_000, state: 'up' },
    ]);
    expect(lane(drawing, 'node-2').spans).toEqual([
      { from: 0, to: 2_000, state: 'up' },
      { from: 2_000, to: 3_000, state: 'paused' },
      { from: 3_000, to: 5_000, state: 'up' },
      { from: 5_000, to: 6_000, state: 'partitioned' },
      { from: 6_000, to: 10_000, state: 'up' },
    ]);
    expect(lane(drawing, 'node-3').spans).toEqual([{ from: 0, to: 10_000, state: 'down' }]);
    expect(stateAt(lane(drawing, 'crowd'), 5_500)).toBe('partitioned');
    expect(stateAt(lane(drawing, 'node-1'), 5_000)).toBe('down');
  });

  it("draws each show's instances on the node that ran them, ended by a kill or a lost lease", () => {
    expect(drawing.shows).toEqual(['hamlet', 'lear']);
    expect(drawing.bars.map((b) => [b.show, b.node, b.inc, b.from, b.to])).toEqual([
      ['hamlet', 'node-1', 0, 1_000, 4_000],
      ['lear', 'node-2', 0, 1_000, 7_000],
      ['hamlet', 'node-2', 0, 5_500, 7_000],
    ]);
  });

  it('marks the instances of the show that broke, live at the moment it broke', () => {
    expect(drawing.mark).toMatchObject({
      invariant: 'oneLiveInstance',
      time: 5_500,
      until: 6_000,
      nodes: ['node-1', 'node-2'],
      show: 'hamlet',
    });
    expect(drawing.mark?.sentence).toMatch(/Two copies of one show/);
    // node-1's hamlet had ended by then.
    expect(drawing.bars.filter((b) => b.marked).map((b) => b.node)).toEqual(['node-2']);
  });

  it('draws each fault where it happened, in plain words', () => {
    expect(drawing.faults.map((f) => [f.kind, f.from, f.to, f.place, f.nodes])).toEqual([
      ['slow', 1_000, 1_500, 'database', []],
      ['pause', 2_000, 3_000, 'nodes', ['node-2']],
      ['kill', 4_000, 6_000, 'nodes', ['node-1']],
      ['partition', 5_000, 6_000, 'nodes', ['node-2', 'crowd']],
      ['delay', 6_500, 7_000, 'nodes', ['node-2', 'crowd']],
    ]);
    expect(drawing.faults[0]?.text).toBe('the database is slow, 100 to 300 ms a call, for 0.5 s');
  });

  it('counts how the crowd’s requests ended', () => {
    expect(drawing.outcomes).toEqual({ ok: 1, failed: 0, unknown: 0 });
  });

  it('runs a fault still under way when the run ended to the end', () => {
    const cut = draw([
      { ...RUN, untilMs: 3_000 },
      start(0, 'node-1'),
      fault(2_000, 0, 'begin', PAUSE),
    ]);
    expect(cut.endMs).toBe(3_000);
    expect(cut.faults[0]).toMatchObject({ from: 2_000, to: 3_000 });
    expect(lane(cut, 'node-2').spans).toEqual([{ from: 0, to: 3_000, state: 'down' }]);
  });

  it("refuses a history that doesn't start with its run", () => {
    expect(() => draw(HISTORY.slice(1))).toThrow(TypeError);
  });
});

describe("the run's log", () => {
  const text = drawing.log.map((l) => `${String(l.time)} ${l.text}`);

  it('tells the run in plain words, in time order', () => {
    expect(text).toEqual([
      '0 node-1 and node-2 start, and form a cluster with the crowd’s node, which starts buying tickets.',
      '1000 The database is slow, 100 to 300 ms a call, for 0.5 s.',
      '1500 The database is back to normal.',
      '2000 node-2 freezes for 1 s.',
      '3000 node-2 wakes up, as if no time had passed.',
      '4000 node-1 is killed, and starts again 2 s later.',
      '4500 node-2 notices node-1 has gone quiet.',
      '5000 node-2 can’t reach crowd for 1 s.',
      '5000 The others decide node-1 is down.',
      '5500 It broke: Two copies of one show ran at once, each free to sell the same seats.',
      '5510 hamlet moves to node-2, and replays 2 events from its journal.',
      '6000 The partition heals.',
      '6000 node-1 starts again, as a new incarnation with an empty memory.',
      '6100 node-1 is up, and part of the cluster.',
      '6500 Messages between node-2 and crowd are slow, 5 to 50 ms, for 0.5 s.',
      '7000 The network is back to normal.',
      '7000 node-2’s leases on shards 3 and 4 ran out, so it stops the shows there.',
      '10000 The run ends. 1 of the crowd’s 1 requests were answered.',
    ]);
  });

  it('says where a run that broke was cut short', () => {
    const cut = draw([{ ...RUN, untilMs: 3_000 }], {
      invariant: 'recovers',
      message: 'at 3,000, shard show/16 was on node-2, and belongs on node-1',
      time: 2_999,
      entity: 'show/16',
    });
    expect(cut.mark?.show).toBeUndefined();
    expect(cut.log.at(-1)?.text).toMatch(/^The run stops here, once it has broken\./);
  });
});

describe('fault words', () => {
  const cases: [Fault, string, string[]][] = [
    [
      { at: 0, leave: 'node-1', rejoinAfterMs: 1 },
      'node-1 leaves, handing its shows to the others',
      ['node-1'],
    ],
    [{ at: 0, join: 'node-4' }, 'node-4 joins the cluster', ['node-4']],
    [
      { at: 0, partition: [['node-1'], ['node-2', 'crowd']], oneWay: true, ms: 2_500 },
      'node-1 can’t send to node-2 and crowd for 2.5 s',
      ['node-1', 'node-2', 'crowd'],
    ],
    [
      { at: 0, reset: ['node-1', 'node-2'] },
      'the connections between node-1 and node-2 drop',
      ['node-1', 'node-2'],
    ],
    [
      { at: 0, reorder: 'node-1', windowMs: 30, ms: 1_000 },
      'messages to and from node-1 arrive out of order for 1 s',
      ['node-1'],
    ],
    [
      { at: 0, lose: 'node-1', rate: 0.1, ms: 1_000 },
      '10% of messages to and from node-1 go missing for 1 s',
      ['node-1'],
    ],
    [
      { at: 0, duplicate: 'node-1', peer: 'node-2', rate: 0.25, ms: 1_000 },
      '25% of messages between node-1 and node-2 arrive twice for 1 s',
      ['node-1', 'node-2'],
    ],
    [
      { at: 0, disk: 'hang', node: 'node-2', ms: 3_000 },
      'the database, for node-2, stops answering for 3 s',
      ['node-2'],
    ],
    [{ at: 0, disk: 'error', rate: 0.5, ms: 1_000 }, 'the database fails 50% of calls for 1 s', []],
    [
      { at: 0, disk: 'lostReplies', rate: 0.2, ms: 1_000 },
      'the database loses 20% of its answers, after doing the work, for 1 s',
      [],
    ],
    [{ at: 0, cut: 'node-3', ms: 4_000 }, 'node-3 loses its database for 4 s', ['node-3']],
    [{ at: 0, jump: 1_500 }, 'the database’s clock jumps 1.5 s ahead', []],
    [
      { at: 0, drift: 'node-1', ppm: -200, ms: 1_000 },
      'node-1’s clock runs 200 parts per million slow for 1 s',
      ['node-1'],
    ],
  ];

  it.each(cases)('%j', (f, words, nodes) => {
    expect(faultText(f)).toBe(words);
    expect(faultNodes(f)).toEqual(nodes);
  });
});

describe('trimming a history for the page', () => {
  it('keeps only what the drawing reads', () => {
    const kept = trim(HISTORY);
    expect(kept.some((e) => e.kind === 'db' || e.kind === 'send' || e.kind === 'journal')).toBe(
      false,
    );
    // Not the sharding actor's spawn, nor a persisted event: only the shows'.
    expect(kept.filter((e) => e.kind === 'event').every(isDrawn)).toBe(true);
    expect(kept.some((e) => e.kind === 'event' && e.event.type === 'persisted')).toBe(false);
    expect(kept.some((e) => e.kind === 'event' && 'seq' in e.event)).toBe(false);
    expect(draw(kept, undefined)).toEqual(draw(HISTORY, undefined));
  });

  it('draws a real run the same, trimmed or whole', async () => {
    const run = await festival({ mode: 'contract' }).run({ seed: 3 });
    expect(draw(trim(run.history), run.violations[0])).toEqual(
      draw(run.history, run.violations[0]),
    );
  });
});

describe("the page's runner", () => {
  const runner = new Runner();

  it('finds nothing wrong with a seed of festival night', async () => {
    expect(await runner.check('contract', 1)).toBeUndefined();
  });

  it('draws a found bug’s plan as it runs on today’s code', async () => {
    const bug = FOUND[0];
    if (bug === undefined) throw new Error('no bugs found');
    const d = await runner.draw(bug.mode, bug.seed, bug.plan);
    expect(d.seed).toBe(bug.seed);
    expect(d.mark).toBeUndefined();
    expect(d.faults.map((f) => f.kind)).toEqual(['partition']);
    expect(d.endMs).toBe(60_000);
  });
});
