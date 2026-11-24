import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { desiredOwner, shardOf } from '../../src/cluster/placement.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { FAST, createTestCluster, type TestCluster, type TestNode } from '../helpers/cluster.js';

// Milestone 5, T1 (decision 0033): three nodes on the in-memory network, each on its own clock,
// driven by Rehearsal's run loop, do what they do on one shared clock.

interface Count {
  readonly id: string;
  readonly count: number;
  readonly node: string;
}
type CounterMsg =
  | { readonly type: 'add'; readonly by: number }
  | { readonly type: 'get'; readonly replyTo: ActorRef<Count> };

const SHARDS = 16;
const IDS = Array.from({ length: 30 }, (_, i) => `show-${String(i)}`);

function clusterOf(n: TestNode) {
  const c = n.cluster;
  if (c === undefined) throw new Error(`${n.name} has no cluster`);
  return c;
}

/** Asks, moving time on until the reply comes. */
async function ask<R>(c: TestCluster, run: () => Promise<R>): Promise<R> {
  const promise = run();
  const state = { settled: false };
  const done = (): void => {
    state.settled = true;
  };
  promise.then(done, done);
  for (let waited = 0; !state.settled && waited < 5_000; waited += 50) await c.advance(50);
  return promise;
}

/** Three nodes join, shard a counter, count to each id from every node, and read it back. */
async function scenario(seed: number, clocks: { driftPpm: number } | undefined) {
  const c = await createTestCluster({
    ...FAST,
    seed,
    // Every delivery, so the story checks the order of everything.
    messages: true,
    ...(clocks === undefined ? {} : { clocks }),
  });
  try {
    await c.advance(2_000);
    for (const n of c.nodes) await clusterOf(n).whenUp;
    const types = c.nodes.map((n) =>
      clusterOf(n).sharding.init({
        type: 'counter',
        shardCount: SHARDS,
        entity: (id) =>
          actor<CounterMsg, number>({
            initial: 0,
            receive(count, msg) {
              if (msg.type === 'add') return count + msg.by;
              msg.replyTo.tell({ id, count, node: n.name });
              return count;
            },
          }),
      }),
    );
    for (const t of types) for (const id of IDS) t.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(3_000);
    const counts: Count[] = [];
    for (const id of IDS) {
      for (const t of types) {
        counts.push(
          await ask(c, () => t.ref(id).ask<Count>((replyTo) => ({ type: 'get', replyTo }))),
        );
      }
    }
    const members = c.nodes.map((n) =>
      clusterOf(n)
        .members()
        .map((m) => `${m.address} ${m.status} ${String(m.reachable)}`),
    );
    const holders = c.nodes.flatMap((n) =>
      n.events
        .filter(
          (e): e is Extract<SystemEvent, { type: 'shardAcquired' }> => e.type === 'shardAcquired',
        )
        .map((e) => ({ shard: e.shard, address: n.address })),
    );
    const story = c.incarnations.flatMap((n) =>
      n.events.map((e, i) => `${n.name} ${String(n.times[i])} ${JSON.stringify(e, refPaths)}`),
    );
    const readings = c.nodes.map((n) => n.clock?.now() ?? c.scheduler.now());
    return { counts, members, holders, story, readings, addresses: c.nodes.map((n) => n.address) };
  } finally {
    await c.shutdown();
  }
}

/** Refs as their paths, so a story compares across runs. */
function refPaths(_key: string, value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'tell' in value
    ? `ref ${(value as ActorRef<never>).path}`
    : value;
}

describe('three nodes, each on its own clock', () => {
  it.each([
    ['one shared clock', undefined],
    ['clocks 200 ppm apart', { driftPpm: 200 }],
    ['clocks 20,000 ppm apart', { driftPpm: 20_000 }],
  ])('converge and shard, on %s', async (_name, clocks) => {
    const result = await scenario(3, clocks);
    // Every node sees all three up and reachable.
    for (const view of result.members) {
      expect(view).toEqual(['node-1 up true', 'node-2 up true', 'node-3 up true']);
    }
    // Each id has one entity, which counted every node's add, wherever it was asked from.
    for (const id of IDS) {
      const replies = result.counts.filter((r) => r.id === id);
      expect(replies.map((r) => r.count)).toEqual([3, 3, 3]);
      expect(new Set(replies.map((r) => r.node)).size).toBe(1);
    }
    // Each shard in use is held once, by its desired owner.
    expect(new Set(result.holders.map((h) => h.shard)).size).toBe(result.holders.length);
    expect(result.holders.length).toBe(new Set(IDS.map((id) => shardOf(id, SHARDS))).size);
    for (const { shard, address } of result.holders) {
      expect(desiredOwner(`counter/${String(shard)}`, result.addresses)).toBe(address);
    }
    if (clocks === undefined) {
      expect(new Set(result.readings).size).toBe(1);
    } else {
      // The clocks did drift apart.
      expect(new Set(result.readings).size).toBeGreaterThan(1);
    }
  });

  it('tells the same story, event for event and at the same simulation times, from one seed', async () => {
    const first = await scenario(11, { driftPpm: 20_000 });
    const second = await scenario(11, { driftPpm: 20_000 });
    expect(first.story.length).toBeGreaterThan(1_000);
    expect(second.story).toEqual(first.story);
    expect(second.readings).toEqual(first.readings);
    // Another seed draws other clocks.
    const other = await scenario(12, { driftPpm: 20_000 });
    expect(other.readings).not.toEqual(first.readings);
  });

  it('can’t run on TCP', async () => {
    await expect(createTestCluster({ network: 'tcp', clocks: {} })).rejects.toThrow(
      /clocks need an in-process network/,
    );
  });
});
