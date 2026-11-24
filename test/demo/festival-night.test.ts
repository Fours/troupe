import type { SystemEvent } from '@kylewillett/troupe';
import { encode, type Frame } from '@kylewillett/troupe/backstage';
import { afterEach, describe, expect, it } from 'vitest';
import { showId, type ShowEvent } from '../../demo/src/domain/shows.ts';
import {
  CROWD,
  festivalNight,
  LEASES,
  MEMBERSHIP,
  type FestivalEvent,
  type FestivalNight,
  type FestivalNightOptions,
} from '../../demo/src/festival/domain/festival-night.ts';
import { SHOW_IDS } from '../../demo/src/festival/domain/lineup.ts';
import { Narrator } from '../../demo/src/festival/domain/narrate.ts';
import { nodeClient } from '../../demo/src/festival/domain/node-client.ts';
import { ENTITY_PATH, Stage } from '../../demo/src/festival/domain/stage.ts';
import { answered, nextTurn } from './helpers.ts';

// Milestone 4, T9: festival night, the site's /cluster/ page, on three in-memory nodes and a
// crowd's node on one ManualScheduler. Kill node fails its shows over, Restart node and Add a node
// move shows to the node, Leave gracefully loses no ask, and a seed tells the same story every
// time, event for event, on every node.

/** Long enough for every show to open and settle on its desired node. */
const SETTLED_MS = 15_000;

/** A kill's failover: the lease runs out, then the shard starts on its next message or remembered. */
const FAILOVER_MS = LEASES.ttlMs + 2_000;

interface Run {
  readonly night: FestivalNight;
  readonly stage: Stage;
  /** Everything a listener heard, in order. */
  readonly heard: FestivalEvent[];
  /** Every event of every incarnation, a killed one's included, by `<address>:<incarnation>`. */
  readonly all: Map<string, SystemEvent[]>;
}

const open: FestivalNight[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((n) => n.dispose()));
});

function run(opts: Omit<FestivalNightOptions, 'yieldToEventLoop'> = {}): Run {
  const night = festivalNight({ yieldToEventLoop: nextTurn, ...opts });
  open.push(night);
  const stage = new Stage(night);
  const heard: FestivalEvent[] = [];
  night.subscribe((e) => {
    heard.push(e);
    stage.apply(e);
  });
  const all = new Map<string, SystemEvent[]>();
  night.onNode((node) => {
    const events: SystemEvent[] = [];
    all.set(`${node.address}:${String(node.incarnation)}`, events);
    node.system.events.subscribe((e) => events.push(e));
  });
  return { night, stage, heard, all };
}

const events = (r: Run): SystemEvent[] =>
  r.heard.flatMap((e) => (e.kind === 'event' ? [e.event] : []));

/** Every event heard from `address`, of `type`. */
function on<T extends SystemEvent['type']>(r: Run, address: string, type: T) {
  return r.heard.flatMap((e) =>
    e.kind === 'event' && e.node.address === address && e.event.type === type
      ? [e.event as Extract<SystemEvent, { type: T }>]
      : [],
  );
}

/** Which node runs each show, by the map. */
function where(r: Run): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of r.stage.view().nodes) {
    for (const s of node.shows) if (!s.stranded) out[s.id] = node.address;
  }
  return out;
}

const showsOn = (r: Run, address: string) =>
  r.stage
    .view()
    .nodes.find((n) => n.address === address)
    ?.shows.map((s) => s.id) ?? [];

/** Customers who gave up waiting: a failed ask, delivered to them as a failed `Result`. */
function gaveUp(r: Run, from = 0): number {
  return r.heard.filter(
    (e) =>
      e.kind === 'event' &&
      e.node.address === CROWD &&
      e.event.type === 'delivered' &&
      e.event.at >= from &&
      /^\/user\/crowd\/customer-/.test(e.event.path) &&
      (e.event.message as { ok?: boolean }).ok === false,
  ).length;
}

/** Seats per show in acknowledged sales: a confirm the show answered `ok`. */
function acknowledged(r: Run): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events(r)) {
    if (e.type !== 'delivered') continue;
    const m = e.message as {
      ok?: boolean;
      value?: { kind?: string; ok?: boolean; show?: string; seats?: number };
    };
    const v = m.value;
    if (m.ok === true && v?.kind === 'confirm' && v.ok === true && v.show !== undefined) {
      out[v.show] = (out[v.show] ?? 0) + (v.seats ?? 0);
    }
  }
  return out;
}

/** Seats per show in `confirmed` events in the journal. */
async function journaled(night: FestivalNight): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of SHOW_IDS) {
    const stored = await night.persistence.journal.read(showId(id), 1, 100_000);
    out[id] = stored
      .map((s) => s.event as ShowEvent)
      .flatMap((e) => (e.type === 'confirmed' ? [e.seats] : []))
      .reduce((sum, seats) => sum + seats, 0);
  }
  return out;
}

/**
 * Every live interval of every show, on every incarnation, killed ones included, from their own
 * events: no two may overlap (milestone 4, "The invariant").
 */
function overlaps(r: Run): string[] {
  const intervals = new Map<string, { node: string; from: number; to: number }[]>();
  for (const [node, list] of r.all) {
    const open = new Map<string, number>();
    for (const e of list) {
      if (e.type !== 'spawned' && e.type !== 'stopped') continue;
      const id = ENTITY_PATH.exec(e.path)?.[2];
      if (id === undefined) continue;
      if (e.type === 'spawned') open.set(id, e.at);
      else {
        const from = open.get(id) ?? 0;
        open.delete(id);
        intervals.set(id, [...(intervals.get(id) ?? []), { node, from, to: e.at }]);
      }
    }
    for (const [id, from] of open) {
      intervals.set(id, [...(intervals.get(id) ?? []), { node, from, to: Infinity }]);
    }
  }
  const problems: string[] = [];
  for (const [id, list] of intervals) {
    const sorted = [...list].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (a !== undefined && b !== undefined && b.from < a.to) {
        problems.push(
          `${id}: ${a.node} ${String(a.from)}-${String(a.to)} and ${b.node} from ${String(b.from)}`,
        );
      }
    }
  }
  return problems;
}

describe('festival night', () => {
  it('opens all twelve shows, spread over the three nodes', async () => {
    const r = run();
    await r.night.started;
    await r.night.clock.advance(SETTLED_MS);
    const placed = where(r);
    expect(Object.keys(placed).sort()).toEqual([...SHOW_IDS].sort());
    for (const address of ['node-1', 'node-2', 'node-3']) {
      expect(showsOn(r, address).length, address).toBeGreaterThan(0);
    }
    expect(r.night.hosts().map((n) => [n.address, n.state])).toEqual([
      ['node-1', 'up'],
      ['node-2', 'up'],
      ['node-3', 'up'],
    ]);
    expect(r.night.crowd.state).toBe('up');
  });

  it('Kill node fails its shows over to the others, with every acknowledged sale', async () => {
    const r = run();
    await r.night.clock.advance(SETTLED_MS);
    const before = where(r);
    const victims = SHOW_IDS.filter((id) => before[id] === 'node-2');
    expect(victims.length).toBeGreaterThan(0);

    await r.night.kill('node-2');
    const killedAt = r.night.clock.now();
    expect(r.night.node('node-2')?.state).toBe('killed');
    // At once, its shows are stranded on it: nobody else may run them while its leases last.
    expect(
      r.stage
        .view()
        .nodes.find((n) => n.address === 'node-2')
        ?.shows.every((s) => s.stranded),
    ).toBe(true);
    await r.night.clock.advance(LEASES.ttlMs - 1_100);
    for (const id of victims) expect(where(r)[id]).toBeUndefined();

    await r.night.clock.advance(FAILOVER_MS);
    const after = where(r);
    for (const id of victims) expect(['node-1', 'node-3']).toContain(after[id]);
    expect(showsOn(r, 'node-2')).toEqual([]);
    // Within the lease's time, and no sooner: the lease is what failover waits for (0031).
    const acquired = [...on(r, 'node-1', 'shardAcquired'), ...on(r, 'node-3', 'shardAcquired')]
      .filter((e) => e.at > killedAt)
      .map((e) => e.at - killedAt);
    expect(Math.min(...acquired)).toBeGreaterThanOrEqual(LEASES.ttlMs - LEASES.renewMs);
    expect(Math.max(...acquired)).toBeLessThanOrEqual(FAILOVER_MS);
    // The others noticed, as the crowd's node tells it.
    expect(on(r, CROWD, 'memberDown').map((e) => e.address)).toEqual(['node-2']);

    // Every show answers again, and every acknowledged sale is in the journal.
    for (const id of SHOW_IDS) {
      const reply = await answered(r.night.clock, r.night.status(id));
      expect(reply.ok, id).toBe(true);
    }
    const journal = await journaled(r.night);
    for (const [id, seats] of Object.entries(acknowledged(r))) {
      expect(journal[id], id).toBeGreaterThanOrEqual(seats);
    }
    expect(overlaps(r)).toEqual([]);
  });

  it('Restart node brings it back as a new incarnation, and its shows move back to it', async () => {
    const r = run();
    await r.night.clock.advance(SETTLED_MS);
    const mine = showsOn(r, 'node-2');
    const uid = r.night.node('node-2')?.cluster.self.uid;
    await r.night.kill('node-2');
    await r.night.clock.advance(FAILOVER_MS + 2_000);
    // A node that isn't killed or gone can't be restarted.
    await r.night.restart('node-1');
    expect(r.night.node('node-1')?.incarnation).toBe(1);

    await r.night.restart('node-2');
    const node = r.night.node('node-2');
    expect(node?.incarnation).toBe(2);
    expect(node?.cluster.self.uid).not.toBe(uid);
    await r.night.clock.advance(SETTLED_MS);
    expect(node?.state).toBe('up');
    // Placement depends only on the addresses, so it gets back what it had, by handoff.
    expect(showsOn(r, 'node-2').sort()).toEqual([...mine].sort());
    const handoffs = [...on(r, 'node-1', 'shardReleased'), ...on(r, 'node-3', 'shardReleased')]
      .filter((e) => e.at > SETTLED_MS)
      .map((e) => e.reason);
    expect(handoffs.length).toBeGreaterThan(0);
    expect(new Set(handoffs)).toEqual(new Set(['handoff']));
    expect(overlaps(r)).toEqual([]);
  });

  it('Add a node moves shows to it, up to five nodes', async () => {
    const r = run();
    await r.night.clock.advance(SETTLED_MS);
    await expect(r.night.add()).resolves.toBe('node-4');
    await r.night.clock.advance(SETTLED_MS);
    expect(showsOn(r, 'node-4').length).toBeGreaterThan(0);
    expect(on(r, 'node-4', 'shardAcquired').length).toBeGreaterThan(0);
    await expect(r.night.add()).resolves.toBe('node-5');
    await expect(r.night.add()).resolves.toBeUndefined();
    await r.night.clock.advance(SETTLED_MS);
    expect(r.night.hosts().map((n) => n.address)).toEqual([
      'node-1',
      'node-2',
      'node-3',
      'node-4',
      'node-5',
    ]);
    expect(Object.keys(where(r)).sort()).toEqual([...SHOW_IDS].sort());
    expect(gaveUp(r)).toBe(0);
    expect(overlaps(r)).toEqual([]);
  });

  it('Leave gracefully hands every show off with no lost ask', async () => {
    const r = run();
    await r.night.clock.advance(SETTLED_MS);
    expect(gaveUp(r)).toBe(0);
    const mine = showsOn(r, 'node-3');
    expect(mine.length).toBeGreaterThan(0);
    // A rush at the same time, so asks are in flight while it hands off.
    await r.night.rush();
    await r.night.leave('node-3');
    expect(r.night.node('node-3')?.state).toBe('leaving');
    await r.night.clock.advance(SETTLED_MS);
    expect(r.night.node('node-3')?.state).toBe('left');
    expect(showsOn(r, 'node-3')).toEqual([]);
    for (const id of mine) expect(['node-1', 'node-2']).toContain(where(r)[id]);
    // Released for the leave, never lost: nothing waited for a lease to run out.
    expect(new Set(on(r, 'node-3', 'shardReleased').map((e) => e.reason))).toEqual(
      new Set(['leaving']),
    );
    expect(gaveUp(r)).toBe(0);
    // And it can start again.
    await r.night.restart('node-3');
    await r.night.clock.advance(SETTLED_MS);
    expect(showsOn(r, 'node-3').sort()).toEqual([...mine].sort());
    expect(overlaps(r)).toEqual([]);
  });

  it('tells the same story from the same seed, event for event, on every node', async () => {
    const story = async (seed: number) => {
      const r = run({ seed });
      await r.night.clock.advance(SETTLED_MS);
      await r.night.kill('node-2');
      await r.night.clock.advance(3_000);
      await r.night.rush();
      await r.night.clock.advance(5_000);
      await r.night.restart('node-2');
      await r.night.add();
      await r.night.clock.advance(5_000);
      await r.night.leave('node-1');
      await r.night.clock.advance(8_000);
      // Every event of every incarnation, messages included on the crowd's node, as JSON.
      const out: Record<string, string> = {};
      for (const [node, list] of r.all) out[node] = JSON.stringify(list.map((e) => encode(e)));
      const crowd = r.heard.flatMap((e) =>
        e.kind === 'event' && e.node.address === CROWD ? [encode(e.event)] : [],
      );
      return { out, crowd: JSON.stringify(crowd), count: r.heard.length };
    };
    const first = await story(7);
    const second = await story(7);
    expect(Object.keys(first.out)).toEqual([
      'crowd:1',
      'node-1:1',
      'node-2:1',
      'node-3:1',
      'node-2:2',
      'node-4:1',
    ]);
    for (const node of Object.keys(first.out)) {
      expect(second.out[node], node).toBe(first.out[node]);
    }
    expect(second.crowd).toBe(first.crowd);
    expect(first.count).toBeGreaterThan(1_000);
    // Another seed tells another story.
    const other = await story(8);
    expect(other.crowd).not.toBe(first.crowd);
  });

  it('keeps one live instance per show through every button, over many seeds', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = run({ seed });
      await r.night.clock.advance(SETTLED_MS);
      await r.night.kill('node-3');
      await r.night.rush();
      await r.night.clock.advance(2_000);
      await r.night.restart('node-3');
      await r.night.clock.advance(1_000);
      await r.night.add();
      await r.night.leave('node-1');
      await r.night.clock.advance(3_000);
      await r.night.kill('node-2');
      await r.night.clock.advance(SETTLED_MS);
      expect(overlaps(r), `seed ${String(seed)}`).toEqual([]);
      const journal = await journaled(r.night);
      for (const [id, seats] of Object.entries(acknowledged(r))) {
        expect(journal[id], `seed ${String(seed)}: ${id}`).toBeGreaterThanOrEqual(seats);
      }
      expect(Object.keys(where(r)).sort(), `seed ${String(seed)}`).toEqual([...SHOW_IDS].sort());
      await r.night.dispose();
    }
  });

  it('uses the scaled-down timings, so a failover takes seconds', () => {
    expect(MEMBERSHIP.unreachableAfterMs + MEMBERSHIP.downAfterMs).toBeLessThanOrEqual(5_000);
    expect(LEASES.ttlMs).toBeLessThanOrEqual(5_000);
  });
});

describe("festival night's log", () => {
  it('tells a kill in words: the press, the silence, the failover and the comeback', async () => {
    const r = run();
    const narrator = new Narrator();
    const lines: string[] = [];
    r.night.subscribe((e) => {
      const line = narrator.line(e);
      if (line !== undefined) lines.push(line);
    });
    await r.night.clock.advance(SETTLED_MS);
    expect(lines).toEqual(
      expect.arrayContaining(['node-1 is up.', 'node-2 is up.', 'hamlet opens on node-1.']),
    );
    lines.length = 0;
    await r.night.kill('node-2');
    await r.night.clock.advance(FAILOVER_MS);
    await r.night.restart('node-2');
    await r.night.clock.advance(SETTLED_MS);
    await r.night.leave('node-3');
    await r.night.add();
    await r.night.rush();
    await r.night.clock.advance(SETTLED_MS);
    const text = lines.join('\n');
    expect(lines[0]).toBe(
      'You pull the plug on node-2. Its shows stop at once, and nobody tells the others.',
    );
    expect(text).toContain('node-2 has stopped answering.');
    expect(text).toContain("Nobody has heard from node-2: it's declared down.");
    expect(text).toMatch(/ fails? over to node-[13], \d\.\d s after node-2 went\./);
    expect(text).toMatch(/is back on node-[13], with all \d+ events? from the journal\./);
    expect(text).toContain('node-2 starts again, as a new incarnation with an empty memory.');
    expect(text).toContain('node-2 is up again.');
    expect(text).toMatch(/ moves? from node-[13] to node-2\./);
    expect(text).toContain('node-3 is leaving. It hands its shows to the others first.');
    expect(text).toContain('node-3 has left.');
    expect(text).toContain('node-4 joins the festival.');
    expect(text).toContain('A rush: 30 customers arrive at once.');
    expect(text).toMatch(/customer-\d+ bought \d seats? for [a-z-]+\./);
  });
});

describe("festival night's Backstage client", () => {
  it('follows the picked node, freezes when it is killed, and comes back with it', async () => {
    const r = run();
    const client = nodeClient(r.night, CROWD);
    const frames: Frame[] = [];
    client.connect((f) => frames.push(f));
    const hellos = () => frames.filter((f) => f.type === 'hello');
    // The crowd's node from the start: its hello came before anything spawned.
    expect(hellos()).toHaveLength(1);
    const first = hellos()[0];
    expect(first).toMatchObject({ system: CROWD });
    // Its region was there already, but none of its own actors.
    if (first?.type !== 'hello') throw new Error('no hello');
    expect(first.actors.map((a) => a.path)).toEqual(['/system/sharding/show']);
    await r.night.clock.advance(SETTLED_MS);
    expect(frames.some((f) => f.type === 'cluster')).toBe(true);

    client.pick('node-2');
    expect(client.picked).toBe('node-2');
    const hello = hellos().at(-1);
    expect(hello).toMatchObject({ system: 'node-2' });
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.cluster?.address).toBe('node-2');
    expect(hello.actors.some((a) => a.path.startsWith('/system/sharding/show/'))).toBe(true);
    await expect(
      client.request({ type: 'state', path: '/system/sharding/show' }),
    ).resolves.toMatchObject({ ok: true });

    await r.night.kill('node-2');
    const count = frames.length;
    await r.night.clock.advance(2_000);
    expect(frames).toHaveLength(count);
    await expect(client.request({ type: 'state', path: '/user/crowd' })).resolves.toMatchObject({
      ok: false,
      error: { name: 'ClosedError' },
    });

    await r.night.restart('node-2');
    const again = hellos().at(-1);
    expect(again).toMatchObject({ system: 'node-2' });
    if (again?.type !== 'hello') throw new Error('no hello');
    // Attached before the new incarnation joined, so it sees every spawn, its region's included.
    expect(again.actors).toEqual([]);
    await r.night.clock.advance(0);
    expect(
      frames.some(
        (f) =>
          f.type === 'event' &&
          f.event.type === 'spawned' &&
          f.event.path === '/system/sharding/show',
      ),
    ).toBe(true);
    await r.night.clock.advance(SETTLED_MS);
    const last = frames.filter((f) => f.type === 'cluster').at(-1);
    expect(last?.type === 'cluster' && last.cluster.uid).toBe(
      r.night.node('node-2')?.cluster.self.uid,
    );
    client.close();
    const closedAt = frames.length;
    await r.night.clock.advance(1_000);
    expect(frames).toHaveLength(closedAt);
  });
});
