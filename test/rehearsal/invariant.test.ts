import { describe, expect, it } from 'vitest';
import { text } from '../../src/rehearsal/history.js';
import { invariants, type Invariant, type Violation } from '../../src/rehearsal/invariants.js';
import { grantsHeldLeases } from '../../src/rehearsal/plants.js';
import type { Run } from '../../src/rehearsal/scenario.js';
import { scenarioWith, type ScenarioInternals } from '../../src/rehearsal/scenario.js';
import { account, type AccountCmd, type Receipt } from '../helpers/account.js';

// Milestone 4's invariant scenario (T6 and T7 there), on Rehearsal (milestone 5, T5). It replaces
// test/cluster/invariant.test.ts, which drove the same faults by hand from the test cluster. Three
// nodes and a fourth that joins once sell to a handful of persistent accounts, which passivate
// when idle, while a drawn plan kills and restarts nodes, partitions them, cuts them off from the
// database, and has them leave gracefully and come back, one fault at a time. Each clock drifts
// within ±200 ppm, and every journal and shard store call takes simulation time. No two
// instances of an account may be live at once, every acknowledged deposit must be in the journal,
// and no actor fails except one the database cut off, or one whose process was killed.

const SEEDS = Number(process.env.SEEDS ?? 1_000);
const ACCOUNTS = ['a', 'b', 'c', 'd', 'e', 'f'];

/**
 * No actor fails, except a persistent actor whose journal call failed because its node was cut
 * off from the database or killed, which stops it, as decision 0013 has it. An invariant of this
 * scenario's own: anything with a name and a check is one.
 */
const noFailures: Invariant = {
  name: 'noFailures',
  check: (history) =>
    history.flatMap((e): Violation[] => {
      if (e.kind !== 'event' || e.event.type !== 'failed') return [];
      const error = e.event.error as { message?: unknown } | null;
      const message = typeof error?.message === 'string' ? error.message : '';
      if (
        /cannot reach the database|connection to the database was lost|database client has closed/.test(
          message,
        )
      ) {
        return [];
      }
      return [
        {
          invariant: 'noFailures',
          message: `${text(e.event.path)} on ${e.node} failed at ${String(e.time)}: ${message}`,
          time: e.time,
          nodes: [e.node],
        },
      ];
    }),
};

/** The scenario, with a shard store wrapped as `internals` says, to plant a bug. */
function accounts(internals: ScenarioInternals = {}) {
  return scenarioWith(
    {
      nodes: ['node-1', 'node-2', 'node-3'],
      spares: ['node-4'],
      clients: ['crowd'],
      durationMs: 25_000,
      quietMs: 5_000,
      cluster: {
        heartbeatMs: 200,
        unreachableAfterMs: 1_000,
        downAfterMs: 1_000,
        seedTimeoutMs: 500,
        leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
      },
      setup: ({ cluster, db, client }) =>
        cluster.sharding.init<AccountCmd, unknown>({
          type: 'account',
          shardCount: 8,
          host: !client,
          passivation: { idleMs: 1_000 },
          entity: (id) => account(db.persistence(), { id }),
        }),
      workload: ({ op, chance, entity }) => {
        const amount = chance.int(1, 1_000_000_000);
        op('deposit', entity<AccountCmd>('account', chance.pick(ACCOUNTS)), (ref) =>
          ref.ask<Receipt>((replyTo) => ({ type: 'deposit', amount, replyTo }), {
            timeoutMs: 2_000,
          }),
        );
      },
      faults: {
        only: ['kill', 'partition', 'cut', 'leave', 'join'],
        perMinute: 20,
        concurrent: 1,
        lastingMs: [1_000, 5_000],
      },
      invariants: [
        invariants.oneLiveInstance(),
        invariants.acknowledgedWritesKept({
          write: 'deposit',
          kept: (write, journal) => {
            const { amount } = write.messages[0] as { amount: number };
            return journal.some(
              (e) =>
                e.persistenceId === write.entity.id &&
                (e.event as { amount?: unknown }).amount === amount,
            );
          },
        }),
        noFailures,
      ],
    },
    internals,
  );
}

/** What happened over a run, for the totals that show the runs did what they're for. */
function tally(runs: readonly Run[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (key: string, n = 1): void => {
    out[key] = (out[key] ?? 0) + n;
  };
  for (const run of runs) {
    for (const fault of run.plan) add(Object.keys(fault)[1] ?? '?');
    for (const e of run.history) {
      if (e.kind === 'complete' && e.outcome === 'ok') add('acks');
      if (e.kind !== 'event') continue;
      if (e.event.type === 'spawned' && text(e.event.path).startsWith('/system/sharding/')) {
        add('incarnations');
      }
      if (
        e.event.type === 'shardReleased' &&
        (e.event.reason === 'handoff' || e.event.reason === 'leaving')
      ) {
        add('handoffs');
      }
      if (e.event.type === 'failed') add('cutOffFailures');
    }
  }
  return out;
}

describe('the invariant, in process, on Rehearsal', () => {
  it(`holds over ${String(SEEDS)} seeds of three nodes and a fourth that joins, with kills, partitions, cuts, leaves and passivation`, async () => {
    const s = accounts();
    const runs: Run[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const run = await s.run({ seed });
      expect(run.violations, `seed ${String(seed)}`).toEqual([]);
      // Kept only for the totals: the histories themselves are large.
      runs.push({
        ...run,
        history: run.history.filter((e) => e.kind !== 'send' && e.kind !== 'invoke'),
      });
    }
    const t = tally(runs);
    // The runs did what they're for: nodes died, were cut off and partitioned, left and joined,
    // entities moved and passivated, and deposits were made.
    for (const kind of ['kill', 'partition', 'cut', 'leave', 'join']) {
      expect(t[kind] ?? 0, kind).toBeGreaterThan(SEEDS / 4);
    }
    expect(t.handoffs ?? 0).toBeGreaterThan(SEEDS);
    expect(t.incarnations ?? 0).toBeGreaterThan(SEEDS * ACCOUNTS.length);
    expect(t.acks ?? 0).toBeGreaterThan(SEEDS * 20);
    expect(t.cutOffFailures ?? 0).toBeGreaterThan(0);
  }, 600_000);

  it('catches a store that grants leases that are still held, as the old test did', async () => {
    const s = accounts({ wrapStore: grantsHeldLeases });
    let found: Violation | undefined;
    let seed = 0;
    while (found === undefined && seed < 200) {
      seed++;
      const run = await s.run({ seed });
      found = run.violations.find((v) => v.invariant === 'oneLiveInstance');
    }
    expect(found, 'within 200 seeds').toBeDefined();
    expect(found?.message).toMatch(
      /^account\/[a-f] ran on node-\d#\d+ and node-\d#\d+ from [\d,]+ to /,
    );
    expect(found?.nodes).toHaveLength(2);
  }, 120_000);
});
