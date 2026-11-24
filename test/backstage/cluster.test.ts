import { afterEach, describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { backstage } from '../../src/backstage/source.js';
import type { ClusterInfo, Frame } from '../../src/backstage/types.js';
import { shardOf } from '../../src/cluster/placement.js';
import type { EntityType } from '../../src/cluster/sharding.js';
import type { ActorRef } from '../../src/types.js';
import { createActorSystem } from '../../src/system.js';
import { hooksOf, inspectSystem, type MemberInspection } from '../../src/internal.js';
import { FAST, createTestCluster, type TestCluster, type TestNode } from '../helpers/cluster.js';

// Milestone 4, T9: Backstage for clusters. Protocol version 2's hello carries the node's place in
// its cluster, the tree walk includes /system/sharding, member and shard events are kept in the
// history, and a `cluster` frame follows every change to the node's view, once per change.

const open: TestCluster[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.shutdown()));
});

type CounterMsg =
  | { readonly type: 'add'; readonly by: number }
  | { readonly type: 'get'; readonly replyTo: ActorRef<number> };

const counter = () =>
  actor<CounterMsg, number>({
    initial: 0,
    receive(count, msg) {
      if (msg.type === 'add') return count + msg.by;
      msg.replyTo.tell(count);
      return count;
    },
  });

const SHARDS = 8;

async function cluster(): Promise<{ c: TestCluster; types: EntityType<CounterMsg>[] }> {
  const c = await createTestCluster({ ...FAST });
  open.push(c);
  await c.advance(2_000);
  const types = c.nodes.map((n) =>
    clusterOf(n).sharding.init({ type: 'counter', entity: counter, shardCount: SHARDS }),
  );
  await c.advance(500);
  return { c, types };
}

function clusterOf(n: TestNode) {
  if (n.cluster === undefined) throw new Error(`${n.name} has no cluster`);
  return n.cluster;
}

function record() {
  const frames: Frame[] = [];
  const clusters = (): ClusterInfo[] =>
    frames.flatMap((f) => (f.type === 'cluster' ? [f.cluster] : []));
  return { frames, clusters, listener: (f: Frame) => frames.push(f) };
}

const keyOf = (n: TestNode) => {
  const { address, uid } = clusterOf(n).self;
  return `${address}#${String(uid)}`;
};

describe('Backstage on a cluster node', () => {
  it('says hello with the members, the shard owners it knows, and the sharding tree', async () => {
    const { c, types } = await cluster();
    const [first] = types;
    if (first === undefined) throw new Error('no type');
    first.ref('ann').tell({ type: 'add', by: 2 });
    await c.advance(1_000);

    const source = backstage(c.node(0).system);
    const { frames, listener } = record();
    source.connect(listener);
    const hello = frames[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.protocol).toBe(2);

    const shard = shardOf('ann', SHARDS);
    const info = hello.cluster;
    expect(info).toMatchObject({ address: 'node-1', uid: clusterOf(c.node(0)).self.uid });
    expect(info?.members.map((m) => [m.address, m.status, m.reachable])).toEqual([
      ['node-1', 'up', true],
      ['node-2', 'up', true],
      ['node-3', 'up', true],
    ]);
    // node-1 sent the message, so its region learned where ann's shard is, wherever that is.
    const owner = info?.types[0]?.shards.find((s) => s.shard === shard)?.owner;
    const holder = c.nodes.find((n) => keyOf(n) === owner);
    expect(holder, `the owner of shard ${String(shard)}`).toBeDefined();
    expect(info?.types).toEqual([
      expect.objectContaining({ type: 'counter', shardCount: SHARDS, host: true }),
    ]);

    // The holder's own hello lists the region, the shard and the entity under /system/sharding.
    const there = backstage(holder?.system ?? c.node(0).system);
    const seen = record();
    there.connect(seen.listener);
    const theirs = seen.frames[0];
    if (theirs?.type !== 'hello') throw new Error('no hello');
    const paths = theirs.actors.map((a) => a.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/system/sharding/counter',
        `/system/sharding/counter/${String(shard)}`,
        `/system/sharding/counter/${String(shard)}/ann`,
      ]),
    );
    // The entity's state can be read like any actor's.
    await expect(
      there.request({ type: 'state', path: `/system/sharding/counter/${String(shard)}/ann` }),
    ).resolves.toMatchObject({ ok: true, state: 2 });
    source.close();
    there.close();
  });

  it('keeps member and shard events in the history of a source attached before they happened', async () => {
    const c = await createTestCluster({ ...FAST });
    open.push(c);
    const source = backstage(c.node(1).system);
    await c.advance(2_000);
    const type = clusterOf(c.node(1)).sharding.init({ type: 'counter', entity: counter });
    for (const n of [c.node(0), c.node(2)]) {
      clusterOf(n).sharding.init({ type: 'counter', entity: counter });
    }
    for (let i = 0; i < 20; i++) type.ref(`e${String(i)}`).tell({ type: 'add', by: 1 });
    await c.advance(1_000);
    const { frames, listener } = record();
    source.connect(listener);
    const hello = frames[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.history.filter((e) => e.type === 'memberUp').map((e) => e.address)).toEqual(
      expect.arrayContaining(['node-1', 'node-2', 'node-3']),
    );
    expect(hello.history.map((e) => e.type)).toContain('shardAcquired');
    source.close();
  });

  it('sends a cluster frame when a node it knows of goes, and none while nothing changes', async () => {
    const { c, types } = await cluster();
    // Touch every shard from node-1, so its region knows every owner.
    for (let i = 0; i < 40; i++) types[0]?.ref(`e${String(i)}`).tell({ type: 'add', by: 1 });
    await c.advance(1_000);
    const source = backstage(c.node(0).system);
    const { frames, clusters, listener } = record();
    source.connect(listener);

    // Quiet: heartbeats and renewals change nothing this node shows.
    await c.advance(3_000);
    expect(clusters()).toEqual([]);

    const gone = keyOf(c.node(2));
    c.kill(2);
    await c.advance(1_100);
    const unreachable = clusters().at(-1);
    expect(unreachable?.members.find((m) => m.address === 'node-3')).toMatchObject({
      status: 'up',
      reachable: false,
    });

    // Downed, then its shards' leases expire and they start elsewhere as they're used again.
    await c.advance(4_000);
    for (let i = 0; i < 40; i++) types[0]?.ref(`e${String(i)}`).tell({ type: 'add', by: 1 });
    await c.advance(3_000);
    const last = clusters().at(-1);
    expect(last?.members.find((m) => m.address === 'node-3')?.status).toBe('down');
    const owners = new Set(last?.types[0]?.shards.map((s) => s.owner));
    expect(owners.has(gone)).toBe(false);
    expect([...owners].sort()).toEqual([keyOf(c.node(0)), keyOf(c.node(1))].sort());

    // Never the same view twice in a row.
    const texts = clusters().map((x) => JSON.stringify(x));
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
    // Each frame came in order with the events, after the one that caused it.
    const firstCluster = frames.findIndex((f) => f.type === 'cluster');
    const reachability = frames.findIndex(
      (f) => f.type === 'event' && f.event.type === 'reachability',
    );
    expect(reachability).toBeGreaterThanOrEqual(0);
    expect(firstCluster).toBeGreaterThan(reachability);

    // Closed, it sends nothing more.
    source.close();
    const count = frames.length;
    c.kill(1);
    await c.advance(2_000);
    expect(frames).toHaveLength(count);
  });

  it('sends one cluster frame per turn of changes, and none for a view that ended up the same', async () => {
    const system = createActorSystem({ name: 'node' });
    let members: MemberInspection[] = [{ address: 'a', uid: 1, status: 'up', reachable: true }];
    const changed = hooksOf(system).setCluster({
      address: 'a',
      uid: 1,
      members: () => members,
      entityTypes: () => [],
    });
    expect(() =>
      hooksOf(system).setCluster({
        address: 'a',
        uid: 1,
        members: () => [],
        entityTypes: () => [],
      }),
    ).toThrow(/already set/);
    const source = backstage(system);
    const { frames, clusters, listener } = record();
    // Nobody connected: nothing is sent, and nothing is queued for later.
    changed();
    await Promise.resolve();
    source.connect(listener);
    expect(frames).toHaveLength(1);

    // Told of a change that changed nothing: no frame.
    changed();
    await Promise.resolve();
    expect(clusters()).toEqual([]);

    // Two changes in one turn: one frame, with the last view.
    members = [...members, { address: 'b', uid: 2, status: 'up', reachable: true }];
    changed();
    members = members.map((m) => (m.address === 'b' ? { ...m, reachable: false } : m));
    changed();
    await Promise.resolve();
    expect(clusters().map((c) => c.members.map((m) => [m.address, m.reachable]))).toEqual([
      [
        ['a', true],
        ['b', false],
      ],
    ]);

    // Back and forth within a turn ends where it began: no frame.
    members = members.filter((m) => m.address === 'a');
    changed();
    members = [...members, { address: 'b', uid: 2, status: 'up', reachable: false }];
    changed();
    await Promise.resolve();
    expect(clusters()).toHaveLength(1);

    // Closed, it sends nothing more.
    source.close();
    members = [];
    changed();
    await Promise.resolve();
    expect(clusters()).toHaveLength(1);
    await system.terminate();
  });

  it('logs a cluster change listener that throws, and still tells the others', () => {
    const errors: string[] = [];
    const quiet = () => undefined;
    const system = createActorSystem({
      name: 'node',
      logger: { debug: quiet, info: quiet, warn: quiet, error: (msg) => errors.push(msg) },
    });
    const inspection = inspectSystem(system);
    const heard: string[] = [];
    inspection.onClusterChange(() => {
      throw new Error('boom');
    });
    const stop = inspection.onClusterChange(() => heard.push('second'));
    const changed = hooksOf(system).setCluster({
      address: 'a',
      uid: 1,
      members: () => [],
      entityTypes: () => [],
    });
    expect(inspection.cluster()?.address).toBe('a');
    changed();
    expect(heard).toEqual(['second']);
    expect(errors).toEqual(['a cluster view listener threw; skipped it']);
    stop();
    changed();
    expect(heard).toEqual(['second']);
  });

  it('sends a cluster frame as shards move by handoff, with no member event to prompt it', async () => {
    const addresses = ['node-1', 'node-2', 'node-3', 'node-4'];
    const c = await createTestCluster({ ...FAST, addresses, startAll: false });
    open.push(c);
    for (const i of [0, 1, 2]) await c.start(i);
    await c.advance(2_000);
    const init = (n: TestNode) =>
      clusterOf(n).sharding.init({ type: 'counter', entity: counter, shardCount: SHARDS });
    const first = init(c.node(0));
    init(c.node(1));
    init(c.node(2));
    for (let i = 0; i < 40; i++) first.ref(`e${String(i)}`).tell({ type: 'add', by: 1 });
    await c.advance(3_000);

    // On node-4 itself, which learns it's up from member events, then takes its shards as the
    // others hand them off, a rebalance or more later.
    const node4 = await c.start(3);
    const source = backstage(node4.system);
    const { frames, clusters, listener } = record();
    source.connect(listener);
    init(node4);
    // Until node-4 is up, then a moment more: what the member events alone would have sent.
    await c.advance(1_000);
    const key = keyOf(node4);
    const ownedBy4 = (info: ClusterInfo | undefined) =>
      info?.types[0]?.shards.filter((s) => s.owner === key).length ?? 0;
    const memberFrames = clusters().length;
    expect(
      clusters()
        .at(-1)
        ?.members.map((m) => m.address),
    ).toContain('node-4');
    expect(ownedBy4(clusters().at(-1))).toBe(0);

    // Rebalancing hands node-4 its shards over the next seconds, a few at a time.
    await c.advance(6_000);
    expect(ownedBy4(clusters().at(-1))).toBeGreaterThan(0);
    expect(clusters().length).toBeGreaterThan(memberFrames);
    const lastMemberEvent = frames.findLastIndex(
      (f) => f.type === 'event' && f.event.type.startsWith('member'),
    );
    const lastCluster = frames.findLastIndex((f) => f.type === 'cluster');
    expect(lastCluster).toBeGreaterThan(lastMemberEvent);
    source.close();
  });

  it('sends no cluster frame to a system with no cluster', async () => {
    const c = await createTestCluster();
    open.push(c);
    const source = backstage(c.node(0).system);
    const { frames, listener } = record();
    source.connect(listener);
    await c.advance(1_000);
    const hello = frames[0];
    expect(hello?.type === 'hello' && hello.cluster).toBeNull();
    expect(frames.filter((f) => f.type === 'cluster')).toEqual([]);
    source.close();
  });
});
