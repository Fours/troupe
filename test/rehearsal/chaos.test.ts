import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import type { NetworkMode } from '../../src/rehearsal/network.js';
import type { ActorRef } from '../../src/types.js';
import { FAST, createTestCluster, type TestCluster, type TestNode } from '../helpers/cluster.js';

// Milestone 5, T2 (decision 0035): remoting, membership and sharding on the simulated network,
// under its faults: drawn latency, reordering across connections, and chaos mode's lost,
// reordered and repeated frames.

function clusterOf(n: TestNode) {
  const c = n.cluster;
  if (c === undefined) throw new Error(`${n.name} has no cluster`);
  return c;
}

function simulated(c: TestCluster) {
  const s = c.simulated;
  if (s === undefined) throw new Error('not on the simulated network');
  return s;
}

/** Each node's table, as `address status reachable`, its own row included. */
function tables(c: TestCluster): string[][] {
  return c.nodes.map((n) =>
    clusterOf(n)
      .members()
      .map((m) => `${m.address} ${m.status} ${m.reachable ? 'reachable' : 'unreachable'}`),
  );
}

const ALL_UP = ['node-1', 'node-2', 'node-3'].map((a) => `${a} up reachable`);

/** Records every message it gets. */
function collector(log: string[]) {
  return actor<string, null>({
    initial: null,
    receive: (s, msg) => {
      log.push(msg);
      return s;
    },
  });
}

describe('remoting on drawn latency', () => {
  it('keeps each sender’s order while frames from different nodes overtake each other', async () => {
    const c = await createTestCluster({
      network: 'simulated',
      simulated: { latencyMs: [1, 10] },
    });
    try {
      const [a, b, d] = [c.node(0), c.node(1), c.node(2)];
      const log: string[] = [];
      const inbox = a.system.spawn(collector(log), 'inbox');
      const refs = [b, d].map(
        (n) => n.remoting.ref(a.remoting.codec.uri(inbox.path)) as unknown as ActorRef<string>,
      );
      simulated(c).reorder({ node: a.name, windowMs: 30 });
      for (let i = 0; i < 500; i++) {
        for (const [n, ref] of refs.entries()) ref.tell(`${String(n)}:${String(i)}`);
        await c.advance(1);
      }
      await c.advance(200);
      expect(log).toHaveLength(1_000);
      for (const n of [0, 1]) {
        const seqs = log.filter((m) => m.startsWith(`${String(n)}:`)).map((m) => m.split(':')[1]);
        expect(seqs.map(Number)).toEqual(Array.from({ length: 500 }, (_, i) => i));
      }
      const sent = Array.from({ length: 500 }, (_, i) => [`0:${String(i)}`, `1:${String(i)}`]);
      expect(log).not.toEqual(sent.flat());
    } finally {
      await c.shutdown();
    }
  });
});

type CounterMsg =
  { readonly type: 'add' } | { readonly type: 'get'; readonly replyTo: ActorRef<number> };

describe('chaos mode', () => {
  it('loses, reorders and repeats frames, and remoting, membership and sharding never throw', async () => {
    const c = await createTestCluster({
      ...FAST,
      seed: 5,
      network: 'simulated',
      simulated: { mode: 'chaos', latencyMs: [1, 5] },
      clocks: {},
    });
    try {
      const net = simulated(c);
      await c.advance(2_000);
      for (const n of c.nodes) await clusterOf(n).whenUp;
      const types = c.nodes.map((n) =>
        clusterOf(n).sharding.init({
          type: 'counter',
          shardCount: 8,
          entity: () =>
            actor<CounterMsg, number>({
              initial: 0,
              receive(count, msg) {
                if (msg.type === 'add') return count + 1;
                msg.replyTo.tell(count);
                return count;
              },
            }),
        }),
      );
      for (const n of c.nodes) {
        net.lose({ node: n.name, rate: 0.1 });
        net.duplicate({ node: n.name, rate: 0.1 });
        net.reorder({ node: n.name, windowMs: 20, within: true });
      }
      let replies = 0;
      let timeouts = 0;
      for (let second = 0; second < 60; second++) {
        // A partition now and then, so connections and members come and go.
        const heal =
          second % 15 === 5
            ? net.partition(
                [c.node(second % 3).name],
                ['node-1', 'node-2', 'node-3'].filter((a) => a !== c.node(second % 3).name),
              )
            : undefined;
        for (const [i, t] of types.entries()) {
          for (let k = 0; k < 5; k++) t.ref(`id-${String((i + k) % 7)}`).tell({ type: 'add' });
          t.ref(`id-${String(i)}`)
            .ask<number>((replyTo) => ({ type: 'get', replyTo }), { timeoutMs: 800 })
            .then(
              () => replies++,
              () => timeouts++,
            );
        }
        // advance rejects if anything a task ran threw.
        await c.advance(heal === undefined ? 1_000 : 1_500);
        heal?.();
      }
      await c.advance(1_000);
      const counts = net.counts();
      expect(counts.lost).toBeGreaterThan(100);
      expect(counts.duplicated).toBeGreaterThan(100);
      expect(counts.overtaken).toBeGreaterThan(100);
      // Some asks got through, and the rest timed out: none was left hanging.
      expect(replies).toBeGreaterThan(0);
      expect(replies + timeouts).toBe(180);
      // Nothing the framework runs failed, and nothing logged an error.
      for (const n of c.incarnations) {
        expect(n.events.filter((e) => e.type === 'failed')).toEqual([]);
        expect(n.logs.filter((l) => l.level === 'error')).toEqual([]);
      }
    } finally {
      await c.shutdown();
    }
  });
});

describe('membership after a partition heals', () => {
  async function partitionAndHeal(mode: NetworkMode, resetAfterMs: number) {
    const c = await createTestCluster({
      ...FAST,
      seed: 11,
      network: 'simulated',
      simulated: { mode, resetAfterMs },
      clocks: { driftPpm: 2_000 },
    });
    try {
      const net = simulated(c);
      await c.advance(2_000);
      for (const n of c.nodes) await clusterOf(n).whenUp;
      expect(tables(c)).toEqual([ALL_UP, ALL_UP, ALL_UP]);
      if (mode === 'chaos') {
        for (const n of c.nodes) {
          net.lose({ node: n.name, rate: 0.05 });
          net.reorder({ node: n.name, windowMs: 30, within: true });
        }
      } else {
        for (const n of c.nodes) net.reorder({ node: n.name, windowMs: 30 });
      }
      // Longer than unreachableAfterMs (1,000), shorter than it plus downAfterMs (1,000).
      const heal = net.partition(['node-1'], ['node-2', 'node-3']);
      await c.advance(1_500);
      const during = tables(c);
      expect(during[0]).toEqual([
        'node-1 up reachable',
        'node-2 up unreachable',
        'node-3 up unreachable',
      ]);
      expect(during[1]).toContain('node-1 up unreachable');
      heal();
      await c.advance(3_000);
      expect(tables(c)).toEqual([ALL_UP, ALL_UP, ALL_UP]);
      for (const n of c.incarnations) {
        expect(n.events.filter((e) => e.type === 'memberDown')).toEqual([]);
      }
      return net.counts();
    } finally {
      await c.shutdown();
    }
  }

  it('converges in contract mode, with frames held across the partition', async () => {
    const counts = await partitionAndHeal('contract', 10_000);
    expect(counts.held).toBeGreaterThan(0);
    expect(counts.timedOut).toBe(0);
  });

  it('converges in contract mode when the partition outlasts resetAfterMs', async () => {
    const counts = await partitionAndHeal('contract', 500);
    expect(counts.timedOut).toBeGreaterThan(0);
  });

  it('converges in chaos mode, with frames lost and reordered on the way', async () => {
    const counts = await partitionAndHeal('chaos', 10_000);
    expect(counts.lost).toBeGreaterThan(0);
    expect(counts.overtaken).toBeGreaterThan(0);
  });
});
