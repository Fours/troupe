import { describe, expect, it } from 'vitest';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { seededRandom } from '../../src/testkit/random.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { account, type AccountCmd, type Receipt } from '../helpers/account.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { FAST, createTestCluster, type TestCluster } from '../helpers/cluster.js';

// Milestone 4, T6: the invariant, in process (decision 0030). At most one live instance per entity
// id. Three nodes on one ManualScheduler sell to a handful of persistent accounts while, at random,
// a node is killed and restarted, cut off from the others while it still runs (so they down it),
// or cut off from the shard store. Every entity's spawned and stopped events, from every
// incarnation of every node, give its live intervals in virtual time, and no two for one id may
// overlap. Every deposit that was acknowledged must be in the journal.

const SEEDS = Number(process.env.SEEDS ?? 200);
const ACCOUNTS = ['a', 'b', 'c', 'd', 'e', 'f'];
const RUN_MS = 20_000;
const ENTITY = /^\/system\/sharding\/account\/\d+\/([^/]+)$/;

interface Interval {
  readonly node: string;
  readonly from: number;
  to: number;
}

/** One run of the scenario from `seed`. */
async function run(seed: number): Promise<{
  intervals: Map<string, Interval[]>;
  acked: Map<string, number[]>;
  journal: Map<string, number[]>;
  failures: SystemEvent[];
  kills: number;
  partitions: number;
  cuts: number;
  story: string[];
}> {
  const partitioned = new Set<string>();
  const c: TestCluster = await createTestCluster({
    ...FAST,
    seed,
    wrap: (name, t) => isolatable(t, () => partitioned.has(name)),
  });
  const persistence = inMemoryPersistence({ clock: () => c.scheduler.now() });
  const chance = seededRandom(seed * 104_729);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(chance() * items.length)] as T;

  const types = new Map<number, (id: string) => ActorRef<AccountCmd>>();
  const init = (i: number): void => {
    const node = c.node(i);
    const type = node.cluster?.sharding.init<AccountCmd, unknown>({
      type: 'account',
      shardCount: 8,
      entity: (id) => account(persistence, { id }),
    });
    if (type === undefined) throw new Error('no cluster');
    types.set(i, (id) => type.ref(id));
  };
  await c.advance(2_000);
  for (const i of [0, 1, 2]) init(i);

  const acked = new Map<string, number[]>();
  const live = new Set([0, 1, 2]);
  // One disruption at a time: a node that's dead, partitioned from the others, or cut from the
  // store, and when it began.
  let trouble:
    { kind: 'dead' | 'partition' | 'cut'; index: number; at: number; ms: number } | undefined;
  let amount = 0;
  let kills = 0;
  let partitions = 0;
  let cuts = 0;
  const kill = (index: number): void => {
    c.kill(index);
    live.delete(index);
    trouble = { kind: 'dead', index, at: c.scheduler.now(), ms: 3_000 };
  };
  while (c.scheduler.now() < RUN_MS) {
    const roll = chance();
    const now = c.scheduler.now();
    if (trouble === undefined && roll < 0.06) {
      const index = pick([...live]);
      const ms = 1_000 + Math.floor(chance() * 4_000);
      if (roll < 0.02) {
        kill(index);
        kills++;
      } else if (roll < 0.04) {
        partitioned.add(c.node(index).name);
        trouble = { kind: 'partition', index, at: now, ms };
        partitions++;
      } else {
        c.node(index).setReachesStore(false);
        trouble = { kind: 'cut', index, at: now, ms };
        cuts++;
      }
    } else if (trouble !== undefined && now - trouble.at > trouble.ms) {
      const { kind, index } = trouble;
      trouble = undefined;
      if (kind === 'dead') {
        await c.restart(index);
        init(index);
        live.add(index);
      } else if (kind === 'partition') {
        partitioned.delete(c.node(index).name);
        // Downed while it was away, it learns so and leaves. Then it can only come back as a
        // new incarnation: kill what's left of it, and restart it later.
        await c.advance(1_000);
        const node = c.node(index);
        const { uid } = node.remoting.self;
        if (node.events.some((e) => e.type === 'memberDown' && e.uid === uid)) kill(index);
      } else {
        c.node(index).setReachesStore(true);
      }
    } else {
      const from = pick([...live]);
      const id = pick(ACCOUNTS);
      const by = ++amount;
      const ref = types.get(from)?.(id);
      ref
        ?.ask<Receipt>((replyTo) => ({ type: 'deposit', amount: by, replyTo }), {
          timeoutMs: 2_000,
        })
        .then(
          (receipt) => {
            if (receipt.ok) acked.set(id, [...(acked.get(id) ?? []), by]);
          },
          () => {},
        );
    }
    await c.advance(50 + Math.floor(chance() * 150));
  }
  await c.advance(5_000);

  const intervals = new Map<string, Interval[]>();
  const failures: SystemEvent[] = [];
  for (const n of c.incarnations) {
    const open = new Map<string, Interval>();
    for (const e of n.events) {
      if (e.type === 'failed') failures.push(e);
      if (e.type !== 'spawned' && e.type !== 'stopped') continue;
      const id = ENTITY.exec(e.path)?.[1];
      if (id === undefined) continue;
      if (e.type === 'spawned') {
        const interval = {
          node: `${n.name}#${String(n.remoting.self.uid)}`,
          from: e.at,
          to: Infinity,
        };
        open.set(id, interval);
        intervals.set(id, [...(intervals.get(id) ?? []), interval]);
      } else {
        const interval = open.get(id);
        if (interval !== undefined) interval.to = e.at;
        open.delete(id);
      }
    }
  }
  const story = c.incarnations.flatMap((n) =>
    n.events.map((e) => `${n.name} ${String(e.at)} ${JSON.stringify(e, refPaths)}`),
  );
  const journal = new Map<string, number[]>();
  for (const id of ACCOUNTS) {
    const events = await persistence.journal.read(id, 1, 10_000);
    journal.set(
      id,
      events.map((e) => (e.event as { amount: number }).amount),
    );
  }
  await c.shutdown();
  return { intervals, acked, journal, failures, kills, partitions, cuts, story };
}

/** Refs as their paths, so a story compares across runs. */
function refPaths(_key: string, value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'tell' in value
    ? `ref ${(value as ActorRef<never>).path}`
    : value;
}

describe('the invariant, in process', () => {
  it('is deterministic: two runs of one seed tell the same story, event for event', async () => {
    const first = await run(7);
    const second = await run(7);
    expect(first.kills + first.partitions + first.cuts).toBeGreaterThan(0);
    expect(second.story).toEqual(first.story);
  });

  it(`holds over ${String(SEEDS)} seeds of three nodes with kills, restarts and partitions`, async () => {
    let kills = 0;
    let partitions = 0;
    let cuts = 0;
    let incarnations = 0;
    let acks = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const result = await run(seed);
      kills += result.kills;
      partitions += result.partitions;
      cuts += result.cuts;
      for (const [id, list] of result.intervals) {
        incarnations += list.length;
        const sorted = [...list].sort((a, b) => a.from - b.from);
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1] as Interval;
          const next = sorted[i] as Interval;
          expect(
            next.from >= prev.to,
            `seed ${String(seed)}: ${id} on ${next.node} from ${String(next.from)} overlaps ${prev.node} until ${String(prev.to)}`,
          ).toBe(true);
        }
      }
      for (const [id, amounts] of result.acked) {
        acks += amounts.length;
        const stored = new Set(result.journal.get(id));
        for (const a of amounts)
          expect(stored.has(a), `seed ${String(seed)}: ${id} lost ${String(a)}`).toBe(true);
      }
      expect(result.failures, `seed ${String(seed)}`).toEqual([]);
    }
    // The runs did what they're for: nodes died or were cut off, entities moved, and sales were
    // made.
    expect(kills).toBeGreaterThan(SEEDS / 4);
    expect(partitions).toBeGreaterThan(SEEDS / 4);
    expect(cuts).toBeGreaterThan(SEEDS / 4);
    expect(incarnations).toBeGreaterThan(SEEDS * ACCOUNTS.length);
    expect(acks).toBeGreaterThan(SEEDS * 20);
  }, 120_000);
});

/** Wraps a transport so that, while `isolated()`, no frame gets in or out. */
function isolatable(inner: Transport, isolated: () => boolean): Transport {
  const wrap = (c: Connection): Connection => ({
    send: (frame) => {
      if (!isolated()) c.send(frame);
    },
    onFrame: (listener) => {
      c.onFrame((frame) => {
        if (!isolated()) listener(frame);
      });
    },
    onClose: (listener) => {
      c.onClose(listener);
    },
    close: () => {
      c.close();
    },
  });
  return {
    address: inner.address,
    listen: (onConnection, onRefused) =>
      inner.listen((c) => {
        onConnection(wrap(c));
      }, onRefused),
    connect: (address) => wrap(inner.connect(address)),
    close: () => inner.close(),
  };
}
