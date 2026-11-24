import { describe, expect, it } from 'vitest';
import { persistentActor } from '../../src/persistence/actor.js';
import type { Persistence } from '../../src/persistence/types.js';
import {
  entityOf,
  refPlace,
  runOf,
  text,
  toJson,
  type History,
} from '../../src/rehearsal/history.js';
import { ms } from '../../src/rehearsal/invariants.js';
import { scenario, type ScenarioOptions } from '../../src/rehearsal/scenario.js';
import type { ActorRef } from '../../src/types.js';

// Milestone 5, T5: a run's history. It's JSON, in simulation time, and the same byte for byte
// from the same seed and plan: what a failure prints, what replay reproduces, and what the site
// draws.

type Cmd =
  | { type: 'add'; n: number; replyTo: ActorRef<number> }
  | { type: 'boom'; replyTo: ActorRef<number> };

function counter(persistence: Persistence, id: string) {
  return persistentActor<Cmd, { n: number }, { total: number }>({
    id,
    persistence,
    initial: { total: 0 },
    onCommand: (_s, cmd, { persist }) => {
      if (cmd.type === 'boom') throw new RangeError('boom');
      return persist({ n: cmd.n }).thenReply(cmd.replyTo, (s) => s.total);
    },
    onEvent: (s, e) => ({ total: s.total + e.n }),
  });
}

const OPTIONS: ScenarioOptions = {
  nodes: ['node-1', 'node-2'],
  clients: ['crowd'],
  durationMs: 12_000,
  cluster: {
    heartbeatMs: 200,
    unreachableAfterMs: 1_000,
    downAfterMs: 1_000,
    seedTimeoutMs: 500,
    leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
  },
  setup: ({ cluster, db, client }) =>
    cluster.sharding.init<Cmd, unknown>({
      type: 'counter',
      shardCount: 4,
      host: !client,
      entity: (id) => counter(db.persistence(), id),
    }),
  workload: ({ op, chance, entity }) => {
    const e = entity<Cmd>('counter', chance.pick(['x', 'y']));
    if (chance.next() < 0.05) {
      op('boom', e, (ref) =>
        ref.ask<number>((replyTo) => ({ type: 'boom', replyTo }), { timeoutMs: 1_000 }),
      );
      return;
    }
    const n = chance.int(1, 100);
    op('add', e, (ref) =>
      ref.ask<number>((replyTo) => ({ type: 'add', n, replyTo }), { timeoutMs: 1_000 }),
    );
  },
  faults: { nodes: true, network: true, disks: true, clocks: true, perMinute: 30 },
};

describe('a run’s history', () => {
  it('is JSON, in simulation time, starting with the run and ending with the journal', async () => {
    const run = await scenario(OPTIONS).run({ seed: 2 });
    const { history } = run;
    expect(JSON.parse(JSON.stringify(history))).toEqual(history);
    expect(runOf(history)).toMatchObject({
      kind: 'run',
      seed: 2,
      mode: 'contract',
      nodes: ['node-1', 'node-2'],
      clients: ['crowd'],
      durationMs: 12_000,
      quietFrom: 8_000,
      leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
      plan: run.plan,
    });
    expect(history.at(-1)).toMatchObject({ kind: 'journal', time: 12_000 });
    for (let i = 1; i < history.length; i++) {
      expect(history[i]?.time).toBeGreaterThanOrEqual(history[i - 1]?.time ?? 0);
    }
    const kinds = new Set(history.map((e) => e.kind));
    for (const kind of ['start', 'event', 'fault', 'invoke', 'send', 'complete', 'db', 'journal']) {
      expect(kinds, kind).toContain(kind);
    }
  });

  it('records operations, their messages and replies, with refs that read the same on every node', async () => {
    const { history } = await scenario({ ...OPTIONS, faults: {} }).run({ seed: 1 });
    const start = history.find((e) => e.kind === 'start' && e.node === 'crowd');
    if (start?.kind !== 'start') throw new Error('no crowd');
    const crowd = `crowd#${String(start.uid)}`;
    const send = history.find((e) => e.kind === 'send');
    if (send?.kind !== 'send') throw new Error('no send');
    const replyTo = (send.message as { replyTo: string }).replyTo;
    expect(replyTo).toMatch(new RegExp(`^ref ${crowd}/temp/`));
    // The entity got that very message, with its replyTo naming the crowd's temp ref the same way.
    const delivered = history.find(
      (e) =>
        e.kind === 'event' &&
        e.event.type === 'delivered' &&
        JSON.stringify(e.event.message) === JSON.stringify(send.message),
    );
    expect(delivered).toMatchObject({
      kind: 'event',
      event: { path: expect.stringMatching(/^\/system\/sharding\/counter\/\d\/[xy]$/) as unknown },
    });
    // Only entities' message events are kept.
    for (const e of history) {
      if (e.kind === 'event' && e.event.type === 'delivered') {
        expect(entityOf(text(e.event.path))).toBeDefined();
      }
      if (e.kind === 'event') expect(e.event.type).not.toBe('processed');
    }
    const ok = history.find((e) => e.kind === 'complete' && e.outcome === 'ok');
    expect(ok).toMatchObject({ kind: 'complete', reply: expect.any(Number) as unknown });
    // A failure is recorded with its error as JSON.
    const failed = history.find((e) => e.kind === 'event' && e.event.type === 'failed');
    expect(failed).toMatchObject({
      kind: 'event',
      event: { error: { error: 'RangeError', message: 'boom' } },
    });
    // Its ask times out, and its outcome is unknown.
    const unknown = history.find((e) => e.kind === 'complete' && e.outcome === 'unknown');
    expect(unknown).toMatchObject({
      error: expect.stringMatching(/^AskTimeoutError: /) as unknown,
    });
    // Appends and lease calls, with what became of them.
    expect(history.find((e) => e.kind === 'db' && e.op === 'journal.append')).toMatchObject({
      target: expect.stringMatching(/^[xy]@\d+\+1$/) as unknown,
      applied: true,
      ok: true,
      reply: 'delivered',
    });
    expect(history.find((e) => e.kind === 'db' && e.op === 'shards.acquire')).toMatchObject({
      target: expect.stringMatching(/^counter\/\d$/) as unknown,
    });
  });

  it('is byte for byte the same from one seed and plan, in both network modes', async () => {
    for (const network of ['contract', 'chaos'] as const) {
      const s = scenario({ ...OPTIONS, faults: { ...OPTIONS.faults, network } });
      for (const seed of [1, 2, 3]) {
        const first = await s.run({ seed });
        const second = await s.run({ seed });
        const third = await s.run({ seed, plan: first.plan });
        const text = JSON.stringify(first.history);
        expect(JSON.stringify(second.history), `${network} ${String(seed)}`).toBe(text);
        expect(JSON.stringify(third.history)).toBe(text);
        expect(second.violations).toEqual(first.violations);
      }
      // Different seeds give different runs.
      const a = await s.run({ seed: 1 });
      const b = await s.run({ seed: 2 });
      expect(JSON.stringify(b.history)).not.toBe(JSON.stringify(a.history));
    }
  });

  it('records what each fault did and when, and every node’s incarnations', async () => {
    const plan = [
      { at: 2_000, kill: 'node-2', restartAfterMs: 1_500 },
      { at: 4_000, pause: 'node-1', ms: 500 },
    ];
    const { history } = await scenario({ ...OPTIONS, faults: {} }).run({ seed: 1, plan });
    const lines = history
      .filter(
        (e): e is Extract<History[number], { kind: 'fault' | 'start' | 'stop' }> =>
          e.kind === 'fault' || e.kind === 'start' || e.kind === 'stop',
      )
      .map((e) =>
        e.kind === 'fault'
          ? `${String(e.time)} fault ${String(e.index)} ${e.phase}`
          : `${String(e.time)} ${e.kind} ${e.node} ${String(e.inc)}`,
      );
    expect(lines).toEqual([
      '0 start node-1 0',
      '0 start node-2 0',
      '0 start crowd 0',
      '2000 fault 0 begin',
      '2000 stop node-2 0',
      '3500 start node-2 1',
      '3500 fault 0 end',
      '4000 fault 1 begin',
      '4500 fault 1 end',
    ]);
    // Nothing of a killed incarnation is recorded after it stopped.
    expect(
      history.some(
        (e) => e.kind === 'event' && e.node === 'node-2' && e.inc === 0 && e.time > 2_000,
      ),
    ).toBe(false);
  });
});

describe('a node’s process', () => {
  it('exits once it has been downed, and its process manager starts it again', async () => {
    // For 3 s nothing node-2 sends gets through, though it still hears the others: they down it
    // after 2 s and tell it so, and it exits, and is back as a new incarnation restartAfterMs
    // later.
    const plan = [
      { at: 2_000, partition: [['node-2'], ['node-1', 'crowd']] as const, oneWay: true, ms: 3_000 },
    ];
    const { history } = await scenario({ ...OPTIONS, faults: {}, restartAfterMs: 1_000 }).run({
      seed: 1,
      plan: plan as never,
    });
    const stop = history.find((e) => e.kind === 'stop');
    expect(stop).toMatchObject({ kind: 'stop', node: 'node-2', inc: 0, why: 'exited' });
    const downed = history.find(
      (e) =>
        e.kind === 'event' &&
        e.node === 'node-2' &&
        e.event.type === 'memberDown' &&
        e.event.address === 'node-2',
    );
    expect(downed?.time).toBe(stop?.time);
    expect(
      history.find((e) => e.kind === 'start' && e.node === 'node-2' && e.inc === 1)?.time,
    ).toBe((stop?.time ?? 0) + 1_000);
  });
});

describe('history helpers', () => {
  it('writes refs, errors and values JSON can’t hold', () => {
    const ref = { path: '/user/a', tell: () => {}, ask: () => Promise.resolve() };
    expect(toJson({ to: ref, n: 1 }, 'node-1#7')).toEqual({ to: 'ref node-1#7/user/a', n: 1 });
    expect(refPlace('troupe://c@node-2#9/temp/$3', 'node-1#7')).toBe('node-2#9/temp/$3');
    expect(refPlace('/sharding/show/hamlet', 'node-1#7')).toBe('/sharding/show/hamlet');
    expect(toJson(new TypeError('bad'), '')).toEqual({ error: 'TypeError', message: 'bad' });
    expect(toJson([NaN, Infinity, undefined, () => 1, 2n], '')).toEqual([
      'NaN',
      'Infinity',
      null,
      '<function>',
      '<bigint>',
    ]);
    expect(toJson({ a: undefined, f: () => 1, b: 2 }, '')).toEqual({ b: 2 });
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(JSON.stringify(toJson(deep, ''))).toContain('<deep>');
  });

  it('reads entities from paths, and the run entry first', () => {
    expect(entityOf('/system/sharding/show/3/hamlet')).toEqual({
      type: 'show',
      shard: 3,
      id: 'hamlet',
    });
    expect(entityOf('/system/sharding/show/3')).toBeUndefined();
    expect(() => runOf([])).toThrow(/starts with its run entry/);
    expect(ms(31_204)).toBe('31,204');
    expect(ms(1_234_567)).toBe('1,234,567');
    expect(ms(12)).toBe('12');
    expect(ms(Infinity)).toBe('Infinity');
  });
});
