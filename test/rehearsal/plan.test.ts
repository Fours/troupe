import { describe, expect, it } from 'vitest';
import { persistentActor } from '../../src/persistence/actor.js';
import type { Persistence } from '../../src/persistence/types.js';
import type { History } from '../../src/rehearsal/history.js';
import { endOf, kindOf, type FaultPlan } from '../../src/rehearsal/plan.js';
import { scenario, type ScenarioOptions } from '../../src/rehearsal/scenario.js';
import { stream } from '../../src/rehearsal/streams.js';
import type { ActorRef } from '../../src/types.js';

// Milestone 5, T5: fault plans (decision 0034). A seed draws one from its plan stream, the same
// every time, and every fault in it ends before the quiet tail. A plan given to a run is checked
// before anything starts. And since every concern draws from a stream of its own, taking a fault
// out of a plan changes nothing that happened before it, and none of the workload's operations.

type Cmd = { type: 'add'; n: number; replyTo: ActorRef<number> };

function counter(persistence: Persistence, id: string) {
  return persistentActor<Cmd, { n: number }, { total: number }>({
    id,
    persistence,
    initial: { total: 0 },
    onCommand: (_s, cmd, { persist }) =>
      persist({ n: cmd.n }).thenReply(cmd.replyTo, (s) => s.total),
    onEvent: (s, e) => ({ total: s.total + e.n }),
  });
}

const BASE: ScenarioOptions = {
  nodes: ['node-1', 'node-2', 'node-3'],
  spares: ['node-4'],
  clients: ['crowd'],
  durationMs: 30_000,
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
      shardCount: 8,
      host: !client,
      entity: (id) => counter(db.persistence(), id),
    }),
  workload: ({ op, chance, entity }) => {
    const n = chance.int(1, 100);
    op('add', entity<Cmd>('counter', chance.pick(['x', 'y', 'z'])), (ref) =>
      ref.ask<number>((replyTo) => ({ type: 'add', n, replyTo }), { timeoutMs: 2_000 }),
    );
  },
};

const ALL_FAULTS = { nodes: true, clocks: true, network: true, disks: true } as const;
const NODE_FAULTS = new Set(['kill', 'pause', 'leave', 'drift', 'cut']);

describe('fault plans', () => {
  it('draws the same plan from a seed every time, and another from another seed', () => {
    const s = scenario({ ...BASE, faults: ALL_FAULTS });
    expect(s.plan(7)).toEqual(s.plan(7));
    expect(scenario({ ...BASE, faults: ALL_FAULTS }).plan(7)).toEqual(s.plan(7));
    expect(s.plan(8)).not.toEqual(s.plan(7));
    expect(s.plan(7).length).toBeGreaterThan(0);
  });

  it('ends every fault before the quiet tail, keeps to the kinds and the limit at once, and is JSON', () => {
    const quietFrom = 20_000;
    const kinds = new Map<string, number>();
    for (const network of ['contract', 'chaos'] as const) {
      const s = scenario({ ...BASE, faults: { ...ALL_FAULTS, network, perMinute: 30 } });
      for (let seed = 1; seed <= 300; seed++) {
        const plan = s.plan(seed);
        expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
        let at = 0;
        for (const [i, fault] of plan.entries()) {
          const kind = kindOf(fault);
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
          expect(fault.at, `seed ${String(seed)}`).toBeGreaterThanOrEqual(at);
          at = fault.at;
          expect(endOf(fault), `seed ${String(seed)} fault ${String(i)}`).toBeLessThanOrEqual(
            quietFrom,
          );
          // Never more than two under way at once.
          const under = plan.filter((f) => f.at <= fault.at && endOf(f) > fault.at);
          expect(under.length).toBeLessThanOrEqual(2);
          if (network === 'contract') expect(['lose', 'duplicate']).not.toContain(kind);
          if ('reorder' in fault && fault.within === true) expect(network).toBe('chaos');
          // Node faults land on hosts, never the crowd.
          if (NODE_FAULTS.has(kind)) expect(JSON.stringify(fault)).not.toContain('crowd');
        }
        // A spare joins at most once.
        expect(plan.filter((f) => 'join' in f).length).toBeLessThanOrEqual(1);
      }
    }
    // Every kind turned up.
    for (const kind of [
      'kill',
      'pause',
      'leave',
      'join',
      'partition',
      'reset',
      'delay',
      'reorder',
      'lose',
      'duplicate',
      'slow',
      'hang',
      'error',
      'lostReplies',
      'cut',
      'jump',
      'drift',
    ]) {
      expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(0);
    }
  });

  it('draws only the kinds `only` names, and nothing with no faults asked for', () => {
    const s = scenario({ ...BASE, faults: { only: ['kill', 'join'], perMinute: 30 } });
    for (let seed = 1; seed <= 50; seed++) {
      for (const fault of s.plan(seed)) expect(['kill', 'join']).toContain(kindOf(fault));
    }
    expect(scenario(BASE).plan(1)).toEqual([]);
  });

  it('throws for a plan that can’t be run, before the run starts', async () => {
    const s = scenario(BASE);
    const bad: [unknown, RegExp][] = [
      ['not a plan', /plan must be a list of faults/],
      [
        [{ at: 1_000 }],
        /plan\[0\] must name one kind of fault, such as kill or partition, got none/,
      ],
      [[{ at: 1_000, kill: 'node-1', pause: 'node-2', ms: 1 }], /got kill and pause/],
      [[{ at: 1_000, explode: 'node-1' }], /got none/],
      [[{ at: 1_000, kill: 'node-9', restartAfterMs: 1_000 }], /plan\[0\]\.kill must be a host/],
      [[{ at: 1_000, kill: 'crowd', restartAfterMs: 1_000 }], /must be a host/],
      [[{ at: 1_000, kill: 'node-1' }], /restartAfterMs must be a positive integer/],
      [[{ at: 1_000, kill: 'node-1', restartAfterMs: 1_000, why: 'x' }], /unknown option "why"/],
      [[{ at: -1, pause: 'node-1', ms: 1 }], /plan\[0\]\.at must be a non-negative integer/],
      [
        [
          { at: 2_000, pause: 'node-1', ms: 1 },
          { at: 1_000, pause: 'node-2', ms: 1 },
        ],
        /plan\[1\]\.at must be no earlier than the fault before it, 2000/,
      ],
      [
        [{ at: 19_000, pause: 'node-1', ms: 2_000 }],
        /must end by 20000, when the quiet tail begins/,
      ],
      [[{ at: 1_000, join: 'node-1' }], /plan\[0\]\.join must be a spare/],
      [[{ at: 1_000, partition: [['node-1'], ['node-1']], ms: 1 }], /names node-1 more than once/],
      [
        [{ at: 1_000, partition: [['node-1'], []], ms: 1 }],
        /partition\[1\] must be a non-empty list/,
      ],
      [[{ at: 1_000, reset: ['node-1', 'node-1'] }], /two different nodes/],
      [[{ at: 1_000, lose: 'node-1', rate: 0.5, ms: 1 }], /lose needs the network in chaos mode/],
      [
        [{ at: 1_000, reorder: 'node-1', windowMs: 5, within: true, ms: 1 }],
        /reordering within a connection needs the network in chaos mode/,
      ],
      [
        [{ at: 1_000, disk: 'melt', ms: 1 }],
        /disk must be "slow", "hang", "error" or "lostReplies"/,
      ],
      [[{ at: 1_000, disk: 'hang', rate: 0.5, ms: 1 }], /unknown option "rate"/],
      [
        [{ at: 1_000, disk: 'error', rate: 2, ms: 1 }],
        /rate must be a number above 0 and at most 1/,
      ],
      [[{ at: 1_000, delay: 'node-1', peer: 'node-1', latencyMs: [1, 2], ms: 1 }], /another node/],
      [[{ at: 1_000, drift: 'node-1', ppm: 200_000, ms: 1 }], /ppm must be at most 100000/],
      [[{ at: 1_000, jump: 0 }], /jump must be a positive integer/],
    ];
    for (const [plan, error] of bad) {
      await expect(
        s.run({ seed: 1, plan: plan as FaultPlan }),
        JSON.stringify(plan),
      ).rejects.toThrow(error);
    }
    await expect(s.run({ seed: 1.5 })).rejects.toThrow(/seed must be a safe integer/);
    await expect(s.run({ seed: 1, extra: true } as never)).rejects.toThrow(/unknown option/);
  });

  it('copies a plan it’s given with its keys in one order', async () => {
    const s = scenario({ ...BASE, durationMs: 3_000 });
    const run = await s.run({
      seed: 1,
      plan: [{ ms: 500, partition: [['node-1'], ['node-2']], at: 100 }],
    });
    expect(JSON.stringify(run.plan)).toBe(
      '[{"at":100,"partition":[["node-1"],["node-2"]],"ms":500}]',
    );
  });

  it('checks a scenario’s options when it’s made', () => {
    const bad: [Partial<ScenarioOptions> & Record<string, unknown>, RegExp][] = [
      [{ nodes: [] }, /nodes must be a list of node names, not empty/],
      [{ clients: ['node-1'] }, /node-1 is named more than once/],
      [{ durationMs: 0 }, /durationMs must be a positive integer/],
      [{ quietMs: 40_000 }, /quietMs must be at most durationMs/],
      [{ setup: 1 as never }, /setup must be a function/],
      [{ workload: 1 as never }, /workload must be a function/],
      [{ everyMs: [0, 5] }, /everyMs must start at 1 ms or more/],
      [{ driftPpm: 200_000 }, /driftPpm must be at most 100,000/],
      [{ faults: { nodes: 'yes' as never } }, /faults.nodes must be a boolean/],
      [{ faults: { network: 'flaky' as never } }, /faults.network must be/],
      [{ faults: { only: ['lose'] } }, /lose needs faults.network "chaos"/],
      [{ faults: { only: ['quake' as never] } }, /no fault kind "quake"/],
      [{ faults: { perMinute: 0 } }, /perMinute must be a number above 0/],
      [{ faults: { lastingMs: [0, 10] } }, /lastingMs must start at 1 ms or more/],
      [
        { cluster: { leases: { ttlMs: 1_000, renewMs: 900, marginMs: 500 } } },
        /renewMs must be less/,
      ],
      [{ surprise: true }, /unknown option "surprise"/],
    ];
    for (const [change, error] of bad) {
      expect(() => scenario({ ...BASE, ...change }), String(error)).toThrow(error);
    }
    expect(() => scenario({ ...BASE, spares: [], faults: { only: ['join'] } })).toThrow(
      /join needs spares/,
    );
  });
});

describe('streams', () => {
  it('are seeded from the seed and their name, so each concern draws on its own', () => {
    const draws = (seed: number, name: string): number[] => {
      const r = stream(seed, name);
      return [r(), r(), r()];
    };
    expect(draws(1, 'plan')).toEqual(draws(1, 'plan'));
    expect(draws(1, 'plan')).not.toEqual(draws(1, 'workload crowd'));
    expect(draws(1, 'plan')).not.toEqual(draws(2, 'plan'));
  });

  it('keep the workload and everything before a fault the same when the fault is taken out', async () => {
    const s = scenario({ ...BASE, faults: { ...ALL_FAULTS, perMinute: 20 } });
    const seed = 3;
    const plan = s.plan(seed);
    expect(plan.length).toBeGreaterThanOrEqual(4);
    const full = (await s.run({ seed, plan })).history;
    const invocations = (h: History) =>
      h.filter((e) => e.kind === 'invoke').map((e) => JSON.stringify(e));
    const before = (h: History, t: number) =>
      h.filter((e) => e.kind !== 'run' && e.time < t).map((e) => JSON.stringify(e));
    for (const [i, fault] of plan.entries()) {
      const without = plan.filter((_, j) => j !== i);
      const history = (await s.run({ seed, plan: without })).history;
      // The workload drew the same operations, at the same times, from the same stream.
      expect(invocations(history), `without fault ${String(i)}`).toEqual(invocations(full));
      // Up to the fault's time, nothing differs: no event, call, start or completion.
      expect(before(history, fault.at), `without fault ${String(i)}`).toEqual(
        before(full, fault.at),
      );
      // And the fault did change what came after it.
      expect(JSON.stringify(history)).not.toBe(JSON.stringify(full));
    }
  });
});
