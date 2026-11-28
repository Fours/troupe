import { describe, expect, it } from 'vitest';
import type { ShardStore } from '../../src/cluster/shard-store.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { persistentActor } from '../../src/persistence/actor.js';
import type { Persistence } from '../../src/persistence/types.js';
import type { EventEntry, History, HistoryEntry } from '../../src/rehearsal/history.js';
import { invariants, pastTheMargin, type Invariant } from '../../src/rehearsal/invariants.js';
import type { FaultPlan } from '../../src/rehearsal/plan.js';
import {
  scenarioWith,
  type ScenarioInternals,
  type ScenarioOptions,
  type SetupContext,
} from '../../src/rehearsal/scenario.js';
import type { ActorRef } from '../../src/types.js';

// Milestone 5, T5: each built-in invariant passes on a run built to pass it, and fails on one
// built to fail it, with a violation that says what, where and when. Where a scenario can provoke
// the failure, it's a real run: a store that grants held leases, an entity that acknowledges what
// it never wrote or reads a stale value, a transport that sends frames twice, or bounds too tight
// to meet. Where it can't, as for order per pair, which the contract network never breaks, it's a
// real run's history with two deliveries swapped.

type Deposited = { readonly ok: true; readonly balance: number };
type LedgerCmd =
  | { type: 'deposit'; amount: number; replyTo: ActorRef<Deposited> }
  | { type: 'balance'; replyTo: ActorRef<number> };

/** A ledger: deposits persist, balance reads. `forgets` acks without persisting; `stale` reads 0. */
function ledger(persistence: Persistence, id: string, bug?: 'forgets' | 'stale') {
  return persistentActor<LedgerCmd, { type: 'deposited'; amount: number }, { balance: number }>({
    id,
    persistence,
    initial: { balance: 0 },
    onCommand: (state, cmd, { persist, reply }) => {
      if (cmd.type === 'balance') return reply(cmd.replyTo, bug === 'stale' ? 0 : state.balance);
      if (bug === 'forgets') {
        return reply(cmd.replyTo, { ok: true, balance: state.balance + cmd.amount });
      }
      return persist({ type: 'deposited', amount: cmd.amount }).thenReply(
        cmd.replyTo,
        (s): Deposited => ({ ok: true, balance: s.balance }),
      );
    },
    onEvent: (s, e) => ({ balance: s.balance + e.amount }),
  });
}

const LEDGERS = ['a', 'b', 'c', 'd'];

const kept = invariants.acknowledgedWritesKept({
  write: 'deposit',
  kept: (write, journal) => {
    const { amount } = write.messages[0] as { amount: number };
    return journal.some(
      (e) =>
        e.persistenceId === write.entity.id && (e.event as { amount: number }).amount === amount,
    );
  },
});
const fresh = invariants.noStaleReads({
  read: 'balance',
  write: 'deposit',
  position: (reply) =>
    typeof reply === 'number' ? reply : (reply as { balance?: number } | null)?.balance,
});
const ALL: readonly Invariant[] = [
  invariants.oneLiveInstance(),
  kept,
  fresh,
  invariants.atMostOnce(),
  invariants.orderPerPair(),
  invariants.recovers({ withinMs: 15_000 }),
  invariants.failoverWithin(),
];

/** Three nodes and a crowd that deposits and reads, with whatever bug and invariants a test asks for. */
function bank(
  opts: {
    bug?: 'forgets' | 'stale';
    invariants?: readonly Invariant[];
    leases?: { ttlMs: number; renewMs: number; marginMs: number };
    downAfterMs?: number;
    extra?: Partial<ScenarioOptions>;
  } = {},
  internals: ScenarioInternals = {},
) {
  return scenarioWith(
    {
      nodes: ['node-1', 'node-2', 'node-3'],
      clients: ['crowd'],
      durationMs: 30_000,
      quietMs: 15_000,
      cluster: {
        heartbeatMs: 200,
        unreachableAfterMs: 1_000,
        downAfterMs: opts.downAfterMs ?? 1_000,
        seedTimeoutMs: 500,
        leases: opts.leases ?? { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
      },
      setup: ({ cluster, db, client }) =>
        cluster.sharding.init<LedgerCmd, unknown>({
          type: 'ledger',
          shardCount: 8,
          host: !client,
          entity: (id) => ledger(db.persistence(), id, opts.bug),
        }),
      workload: ({ op, chance, entity }) => {
        const e = entity<LedgerCmd>('ledger', chance.pick(LEDGERS));
        if (chance.next() < 0.6) {
          const amount = chance.int(1, 1_000_000_000);
          op('deposit', e, (ref) =>
            ref.ask<Deposited>((replyTo) => ({ type: 'deposit', amount, replyTo }), {
              timeoutMs: 2_000,
            }),
          );
        } else {
          op('balance', e, (ref) =>
            ref.ask<number>((replyTo) => ({ type: 'balance', replyTo }), { timeoutMs: 2_000 }),
          );
        }
      },
      invariants: opts.invariants ?? ALL,
      ...opts.extra,
    },
    internals,
  );
}

const KILL: FaultPlan = [{ at: 5_000, kill: 'node-2', restartAfterMs: 3_000 }];

/** A store that grants every lease, held or not. */
function grantsHeldLeases(store: ShardStore): ShardStore {
  return {
    ...store,
    acquire: async (lease, holder, ttlMs) => {
      const result = await store.acquire(lease, holder, ttlMs);
      return result.acquired ? result : { acquired: true, token: 1_000_000 };
    },
  };
}

/** A transport whose connections send every frame twice: duplicates below remoting. */
function twice(transport: Transport): Transport {
  const wrap = (c: Connection): Connection => ({
    ...c,
    send: (frame) => {
      c.send(frame);
      c.send(frame);
    },
    onFrame: (l) => {
      c.onFrame(l);
    },
    onClose: (l) => {
      c.onClose(l);
    },
    close: () => {
      c.close();
    },
  });
  return {
    address: transport.address,
    listen: (onConnection, onRefused) =>
      transport.listen((c) => {
        onConnection(wrap(c));
      }, onRefused),
    connect: (address) => wrap(transport.connect(address)),
    close: () => transport.close(),
  };
}

describe('the built-in invariants', () => {
  it('all pass on a run with no faults, and on one with a kill and its restart', async () => {
    const s = bank();
    for (const plan of [[], KILL]) {
      const run = await s.run({ seed: 1, plan });
      expect(run.violations).toEqual([]);
      expect(run.expected).toEqual([]);
      // The runs did something worth checking.
      expect(
        run.history.filter((e) => e.kind === 'complete' && e.outcome === 'ok').length,
      ).toBeGreaterThan(100);
    }
  });

  it('oneLiveInstance: fails when the store grants a lease that is still held', async () => {
    const s = bank({ invariants: [invariants.oneLiveInstance()] }, { wrapStore: grantsHeldLeases });
    // node-1 is cut off from the others, which down it and take its shards, while it still holds
    // them, since it still reaches the database.
    const plan: FaultPlan = [
      { at: 3_000, partition: [['node-1'], ['node-2', 'node-3', 'crowd']], ms: 5_000 },
    ];
    const { violations } = await s.run({ seed: 1, plan });
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      expect(v.invariant).toBe('oneLiveInstance');
      expect(v.entity).toMatch(/^ledger\/[a-d]$/);
      expect(v.nodes).toHaveLength(2);
      expect(v.nodes?.[0]).not.toBe(v.nodes?.[1]);
      expect(v.until).toBeGreaterThan(v.time);
      expect(v.message).toBe(
        `${String(v.entity)} ran on ${String(v.nodes?.[0])} and ${String(v.nodes?.[1])} from ${v.time.toLocaleString('en-US')} to ${(v.until ?? 0).toLocaleString('en-US')}`,
      );
    }
    // Without the bug, the same plan passes.
    expect(
      (await bank({ invariants: [invariants.oneLiveInstance()] }).run({ seed: 1, plan }))
        .violations,
    ).toEqual([]);
  });

  it('oneLiveInstance: ends an instance at its node’s lost lease, which the journal fences after', () => {
    // node-1's instance is stuck on an append whose reply never came when its lease runs out at
    // 200. node-2 starts the entity at 300, and node-1's stops only at 500, once the append times
    // out. From the lost lease on it takes nothing new, so that isn't two live instances.
    const event = (time: number, node: string, e: Record<string, unknown>): HistoryEntry => ({
      kind: 'event',
      time,
      node,
      inc: 0,
      event: { at: time, ...e } as EventEntry['event'],
    });
    const path = '/system/sharding/t/0/x';
    const history = (lost: boolean): History => [
      {
        kind: 'run',
        time: 0,
        seed: 1,
        mode: 'contract',
        nodes: ['node-1', 'node-2'],
        spares: [],
        clients: [],
        durationMs: 1_000,
        quietFrom: 1_000,
        leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
        plan: [],
      },
      { kind: 'start', time: 0, node: 'node-1', inc: 0, uid: 1, driftPpm: 0 },
      { kind: 'start', time: 0, node: 'node-2', inc: 0, uid: 2, driftPpm: 0 },
      event(100, 'node-1', { type: 'spawned', path }),
      ...(lost
        ? [
            event(200, 'node-1', {
              type: 'shardReleased',
              entityType: 't',
              shard: 0,
              node: 'node-1#1',
              token: 1,
              reason: 'leaseLost',
            }),
          ]
        : []),
      event(300, 'node-2', { type: 'spawned', path }),
      event(500, 'node-1', { type: 'stopped', path }),
    ];
    const check = invariants.oneLiveInstance();
    expect(check.check(history(true))).toEqual([]);
    expect(check.check(history(false))).toEqual([
      {
        invariant: 'oneLiveInstance',
        message: 't/x ran on node-1#1 and node-2#2 from 300 to 500',
        time: 300,
        until: 500,
        nodes: ['node-1#1', 'node-2#2'],
        entity: 't/x',
      },
    ]);
  });

  it('acknowledgedWritesKept: fails for a deposit acknowledged and never written', async () => {
    const { violations } = await bank({ bug: 'forgets', invariants: [kept] }).run({
      seed: 1,
      plan: [],
    });
    expect(violations.length).toBeGreaterThan(10);
    const [v] = violations;
    expect(v?.invariant).toBe('acknowledgedWritesKept');
    expect(v?.entity).toMatch(/^ledger\/[a-d]$/);
    expect(v?.nodes).toEqual(['crowd']);
    expect(v?.message).toMatch(
      /^ledger\/[a-d] acknowledged deposit \d+ from crowd at [\d,]+, and the journal doesn't have it$/,
    );
  });

  it('acknowledgedWritesKept: counts only the replies that acknowledged a write', async () => {
    const run = await bank({ bug: 'forgets', invariants: [] }).run({ seed: 1, plan: [] });
    const refusals = invariants.acknowledgedWritesKept({
      write: 'deposit',
      kept: () => false,
      acknowledged: () => false,
    });
    expect(refusals.check(run.history)).toEqual([]);
  });

  it('acknowledgedWritesKept: fails for a journal stream with a gap', async () => {
    const run = await bank().run({ seed: 1, plan: [] });
    expect(kept.check(run.history)).toEqual([]);
    // Take the second event of one stream out of the journal.
    const history = run.history.map((e): HistoryEntry => {
      if (e.kind !== 'journal') return e;
      const victim = e.events.find((x) => x.seq === 2);
      return { ...e, events: e.events.filter((x) => x !== victim) };
    });
    const [v] = invariants.acknowledgedWritesKept().check(history);
    expect(v?.message).toMatch(/^[a-d]'s journal goes 1, 3: event 2 isn't there$/);
    expect(v?.time).toBe(30_000);
  });

  it('noStaleReads: fails for a read that misses a deposit completed before it began', async () => {
    const { violations } = await bank({ bug: 'stale', invariants: [fresh] }).run({
      seed: 1,
      plan: [],
    });
    expect(violations.length).toBeGreaterThan(10);
    const [v] = violations;
    expect(v?.invariant).toBe('noStaleReads');
    expect(v?.message).toMatch(
      /^ledger\/[a-d]'s balance from crowd at [\d,]+ saw 0, but a deposit that completed at [\d,]+ had reached \d+$/,
    );
    expect(v?.until).toBeGreaterThanOrEqual(v?.time ?? Infinity);
  });

  it('atMostOnce: fails when frames arrive twice', async () => {
    const s = bank(
      { invariants: [invariants.atMostOnce()] },
      {
        wrapTransport: (t, node) => (node === 'crowd' ? twice(t) : t),
      },
    );
    const { violations } = await s.run({ seed: 1, plan: [] });
    expect(violations.length).toBeGreaterThan(10);
    const [v] = violations;
    expect(v?.message).toMatch(
      /^ledger\/[a-d] got (deposit|balance) \d+'s message 2 times, at [\d,]+ on node-\d#\d+ the last, and it was sent 1$/,
    );
    expect(v?.nodes?.[0]).toMatch(/^node-\d#\d+$/);
  });

  it('orderPerPair: fails when two messages from one client are delivered out of order', async () => {
    const order = invariants.orderPerPair();
    const run = await bank().run({ seed: 1, plan: [] });
    expect(order.check(run.history)).toEqual([]);
    const history = swapDeliveries(run.history);
    const [v] = order.check(history);
    expect(v?.invariant).toBe('orderPerPair');
    expect(v?.message).toMatch(
      /^crowd to ledger\/[a-d]: (deposit|balance) \d+, sent at [\d,]+, was delivered on node-\d#\d+ at [\d,]+, before (deposit|balance) \d+, sent earlier at [\d,]+$/,
    );
    expect(v?.nodes?.[0]).toBe('crowd');
  });

  it('recovers: fails when the cluster has had too little time to recover', async () => {
    const tight = invariants.recovers({ withinMs: 1 });
    const run = await bank({ invariants: [tight] }).run({ seed: 1, plan: KILL });
    // Restarted at 8,000, node-2 isn't in the others' tables 1 ms later.
    const tables = run.violations.filter((v) => v.message.includes(' up, where '));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0]?.time).toBe(8_001);
    expect(tables[0]?.message).toMatch(
      /^at 8,001, (node-\d|crowd)#\d+ had .* up, where .*node-2#\d+.* were running$/,
    );
    expect(invariants.recovers({ withinMs: 15_000 }).check(run.history)).toEqual([]);
  });

  it('failoverWithin: fails when a killed node’s entities take longer than the bound', async () => {
    // node-2 runs two of the four ledgers, and a lease outlives a second.
    const run = await bank({ invariants: [invariants.failoverWithin({ withinMs: 1_000 })] }).run({
      seed: 1,
      plan: KILL,
    });
    expect(run.violations.length).toBeGreaterThan(0);
    const [v] = run.violations;
    expect(v?.message).toMatch(
      /^ledger\/[a-d], on node-2#\d+ when it was killed at 5,000, wasn't running anywhere else by 6,000$/,
    );
    expect(v?.time).toBe(5_000);
    expect(v?.until).toBe(6_000);
    expect(invariants.failoverWithin().check(run.history)).toEqual([]);
  });

  it('failoverWithin: checks no kill while the cluster may still be settling from another fault', async () => {
    // Traced in the hunt (chaos seed 28,596): a partition made two nodes restart, and a kill came
    // as they rejoined, before the crowd had heard of them. Another fault under way, or ended
    // within a bound before the kill, can stretch failover by design.
    const s = bank({ invariants: [invariants.failoverWithin({ withinMs: 1_000 })] });
    const before = (endsAt: number): FaultPlan => [
      { at: 1_000, disk: 'slow', node: 'node-3', latencyMs: [1, 2], ms: endsAt - 1_000 },
      ...KILL,
    ];
    expect((await s.run({ seed: 1, plan: before(4_600) })).violations).toEqual([]);
    expect((await s.run({ seed: 1, plan: before(3_800) })).violations.length).toBeGreaterThan(0);
  });

  it('failoverWithin: fails when a killed node’s entities run again but don’t answer', async () => {
    // Downing slower than the lease, and a region that routes to a holder it can't reach
    // (planted, T6): node-2's ledgers start elsewhere once its lease runs out, but the crowd's
    // asks still go to node-2, and wait there until it's downed.
    const slowDowning = {
      heartbeatMs: 200,
      unreachableAfterMs: 1_000,
      downAfterMs: 20_000,
      seedTimeoutMs: 500,
      leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
    };
    const opts = {
      invariants: [invariants.failoverWithin()],
      extra: {
        cluster: slowDowning,
        // Remembered, so a shard whose lease ran out starts again on its new owner unasked.
        setup: ({ cluster, db, client }: SetupContext) =>
          cluster.sharding.init<LedgerCmd, unknown>({
            type: 'ledger',
            shardCount: 8,
            host: !client,
            remember: true,
            entity: (id) => ledger(db.persistence(), id),
          }),
      },
    };
    // Down for good, as far as the run goes, so its restart can't heal the routing first.
    const plan: FaultPlan = [{ at: 5_000, kill: 'node-2', restartAfterMs: 10_000 }];
    const run = await bank(opts, { plant: 'routes-unreachable' }).run({ seed: 1, plan });
    expect(run.violations.length).toBeGreaterThan(0);
    for (const v of run.violations) {
      expect(v.message).toMatch(
        /^ledger\/[a-d], on node-2#\d+ when it was killed at 5,000, ran again on node-\d#\d+ from [\d,]+, and none of the \d+ operations begun on it by 9,400 answered$/,
      );
      expect(v.nodes).toHaveLength(2);
      expect(v.until).toBe(9_500);
    }
    // Routed around the holder, as decision 0031 has it, they answer.
    const fixed = await bank(opts).run({ seed: 1, plan });
    expect(fixed.violations).toEqual([]);
  });

  it('checks nothing a run cut short ended before: failover’s bound and recovery’s time', async () => {
    const s = bank({ invariants: [invariants.failoverWithin({ withinMs: 1_000 })] });
    // The whole run fails a 1 s bound, as above. Cut before the bound is up, it can't say yet.
    expect((await s.run({ seed: 1, plan: KILL })).violations.length).toBeGreaterThan(0);
    const cut = await s.run({ seed: 1, plan: KILL, untilMs: 5_500 });
    expect(cut.violations).toEqual([]);
    expect(cut.history[0]).toMatchObject({ kind: 'run', untilMs: 5_500 });
    // A cluster still recovering when the run was cut hasn't failed to recover.
    const recovering = await bank({ invariants: [invariants.recovers({ withinMs: 15_000 })] }).run({
      seed: 1,
      plan: KILL,
      untilMs: 8_001,
    });
    expect(recovering.violations).toEqual([]);
    const strict = invariants.recovers({ withinMs: 1 });
    expect(strict.check(recovering.history).length).toBeGreaterThan(0);
  });

  it('adds up the jumps and the drift within one TTL when it judges a run past the margin', () => {
    const past = (plan: FaultPlan, driftPpm = 0): boolean =>
      pastTheMargin([
        {
          kind: 'run',
          time: 0,
          seed: 1,
          mode: 'contract',
          nodes: ['node-1'],
          spares: [],
          clients: [],
          durationMs: 60_000,
          quietFrom: 40_000,
          leases: { ttlMs: 4_000, renewMs: 1_000, marginMs: 1_000 },
          plan,
        },
        { kind: 'start', time: 0, node: 'node-1', inc: 0, uid: 1, driftPpm },
      ]);
    expect(past([])).toBe(false);
    expect(past([{ at: 7_905, jump: 1_001 }])).toBe(true);
    expect(past([{ at: 7_905, jump: 991 }])).toBe(false);
    // Found by the hunt (contract seed 1,002 on the heavy mix): two jumps 86 ms apart, each
    // inside the margin, outran it together, and the overlap was reported as a violation.
    expect(
      past([
        { at: 7_905, jump: 991 },
        { at: 7_991, jump: 566 },
      ]),
    ).toBe(true);
    // A TTL apart, the lease has been renewed between them.
    expect(
      past([
        { at: 7_905, jump: 991 },
        { at: 11_905, jump: 566 },
      ]),
    ).toBe(false);
    // 900 ms of jump and 30,000 ppm over 4 s, 120 ms: 1,020 ms in all.
    expect(past([{ at: 7_905, jump: 900 }], 30_000)).toBe(true);
    expect(past([], 250_000)).toBe(false);
    expect(past([], 250_001)).toBe(true);
  });

  it('reports drift past the lease margin as expected, not as a violation, while the journal holds', async () => {
    // A 10 s lease with a 100 ms margin, and node-1's clock running 10% slow, cut off from the
    // others and the database: by its clock its lease lasts a second past the store's expiry, so
    // the others start its ledgers while it still runs them. Decision 0029 doesn't promise
    // against that, and the journal's sequence check must hold. Downing waits a minute here:
    // alone on its side of the partition, node-1 would otherwise down itself first (0042).
    const s = bank({
      leases: { ttlMs: 10_000, renewMs: 1_000, marginMs: 100 },
      downAfterMs: 60_000,
      extra: { durationMs: 60_000, quietMs: 20_000 },
      invariants: [invariants.oneLiveInstance(), kept, fresh],
    });
    const plan: FaultPlan = [
      { at: 5_000, drift: 'node-1', ppm: -100_000, ms: 30_000 },
      { at: 5_000, partition: [['node-1'], ['node-2', 'node-3', 'crowd']], ms: 30_000 },
      { at: 5_000, cut: 'node-1', ms: 30_000 },
    ];
    const run = await s.run({ seed: 1, plan });
    expect(run.violations).toEqual([]);
    expect(run.expected.length).toBeGreaterThan(0);
    for (const v of run.expected) {
      expect(v.invariant).toBe('oneLiveInstance');
      expect(v.nodes?.some((n) => n.startsWith('node-1#'))).toBe(true);
    }
    // The same overlaps, without the journal invariants to vouch for them, are violations.
    const unvouched = await bank({
      leases: { ttlMs: 10_000, renewMs: 1_000, marginMs: 100 },
      downAfterMs: 60_000,
      extra: { durationMs: 60_000, quietMs: 20_000 },
      invariants: [invariants.oneLiveInstance()],
    }).run({ seed: 1, plan });
    expect(unvouched.violations).toEqual(run.expected);
  });

  it('checks options where they are passed in', () => {
    expect(() => invariants.recovers({ withinMs: 0 })).toThrow(TypeError);
    expect(() => invariants.failoverWithin({ withinMs: -1 })).toThrow(TypeError);
    expect(() => invariants.noStaleReads({ read: [], write: 'w', position: () => 0 })).toThrow(
      TypeError,
    );
    expect(() => invariants.noStaleReads({ read: 'r', write: 'w', position: 1 as never })).toThrow(
      TypeError,
    );
    expect(() => invariants.acknowledgedWritesKept({ write: 'w' })).toThrow(/go together/);
    expect(() =>
      invariants.acknowledgedWritesKept({ write: 'w', kept: () => true, acknowledged: 1 as never }),
    ).toThrow(/acknowledged must be a function/);
    // Order and at-most-once rest on the Transport contract, so chaos mode can't check them.
    expect(() =>
      bank({ invariants: [invariants.atMostOnce()], extra: { faults: { network: 'chaos' } } }),
    ).toThrow(/atMostOnce can't be checked with the network in chaos mode/);
    expect(() =>
      bank({ invariants: [invariants.orderPerPair()], extra: { faults: { network: 'chaos' } } }),
    ).toThrow(/orderPerPair/);
    expect(() => bank({ invariants: [{ name: 'x' } as never] })).toThrow(/check function/);
  });
});

/**
 * The history with the messages of two deliveries swapped: two messages the crowd sent one after
 * the other to one ledger, delivered to one instance, now arrive in the other order.
 */
function swapDeliveries(history: History): History {
  // Well after the start, once every shard has settled where it'll stay.
  const delivered = history.flatMap((e, i) =>
    e.kind === 'event' && e.event.type === 'delivered' && e.time > 10_000 ? [{ e, i }] : [],
  );
  for (let a = 0; a + 1 < delivered.length; a++) {
    const first = delivered[a];
    if (first === undefined) continue;
    const second = delivered
      .slice(a + 1)
      .find((d) => d.e.event.path === first.e.event.path && d.e.node === first.e.node);
    if (second === undefined) continue;
    const out = [...history];
    const swap = (d: { e: EventEntry; i: number }, message: unknown): void => {
      out[d.i] = { ...d.e, event: { ...d.e.event, message: message as never } };
    };
    swap(first, second.e.event.message);
    swap(second, first.e.event.message);
    return out;
  }
  throw new Error('no two deliveries to swap');
}
