import { afterEach, describe, expect, it } from 'vitest';
import { joinCluster, inMemoryNetwork, type ClusterOptions } from '@kylewillett/troupe/cluster';
import { actor } from '../../src/actor.js';
import { startRemoting } from '../../src/cluster/remoting.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { createSystem } from '../../src/system.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import type { ActorRef, ActorSystem, SystemEvent } from '../../src/types.js';
import {
  createTestCluster,
  type TestCluster,
  type TestClusterOptions,
  type TestNode,
} from '../helpers/cluster.js';
import { watcher } from '../helpers/actors.js';

// Milestone 4, T4: membership (decision 0028). Nodes join through seeds, heartbeat each other,
// gossip their tables, down a node that stays unreachable, and leave.

const open: TestCluster[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.shutdown()));
});

async function cluster(opts: TestClusterOptions = {}): Promise<TestCluster> {
  const c = await createTestCluster({ membership: {}, ...opts });
  open.push(c);
  return c;
}

/** Node `n`'s cluster, which every node here has. */
function clusterOf(n: TestNode) {
  const c = n.cluster;
  if (c === undefined) throw new Error(`${n.name} has no cluster`);
  return c;
}

/** What a node's table says, in a form that compares across nodes. */
function table(n: TestNode): string[] {
  return clusterOf(n)
    .members()
    .map((m) => `${m.address}#${String(m.uid)} ${m.status}${m.reachable ? '' : ' unreachable'}`);
}

type MemberEvent = Extract<
  SystemEvent,
  { type: 'memberUp' | 'memberLeaving' | 'memberDown' | 'memberRemoved' | 'reachability' }
>;
const MEMBER_TYPES = new Set(['memberUp', 'memberLeaving', 'memberDown', 'memberRemoved']);

/** A node's member and reachability events, about the node at `address` when given. */
function memberEvents(n: TestNode, address?: string): MemberEvent[] {
  return n.events.filter(
    (e): e is MemberEvent =>
      (MEMBER_TYPES.has(e.type) || e.type === 'reachability') &&
      (address === undefined || (e as MemberEvent).address === address),
  );
}

/** Each member event as `type uid`, or `reachability uid false`. */
function story(events: readonly MemberEvent[]): string[] {
  return events.map((e) =>
    e.type === 'reachability'
      ? `reachability ${String(e.uid)} ${String(e.reachable)}`
      : `${e.type} ${String(e.uid)}`,
  );
}

/** Whether a promise has settled yet, and how. */
function track(promise: Promise<unknown>): { state: 'pending' | 'resolved' | 'rejected' } {
  const out: { state: 'pending' | 'resolved' | 'rejected' } = { state: 'pending' };
  promise.then(
    () => (out.state = 'resolved'),
    () => (out.state = 'rejected'),
  );
  return out;
}

/** A ref on `from` to the actor at `ref.path` on `to`. */
function remoteRef<M>(from: TestNode, to: TestNode, ref: ActorRef<M>): ActorRef<M> {
  return from.remoting.ref(to.remoting.codec.uri(ref.path)) as unknown as ActorRef<M>;
}

/** Wraps a transport so a frame `drop` picks is lost: only those it sends, unless `both`. */
function dropping(inner: Transport, drop: (frame: string) => boolean, both = false): Transport {
  const wrap = (c: Connection): Connection => ({
    send: (frame) => {
      if (!drop(frame)) c.send(frame);
    },
    onFrame: (listener) => {
      c.onFrame((frame) => {
        if (!both || !drop(frame)) listener(frame);
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

const isHeartbeat = (frame: string) => frame === '{"t":"hb"}';

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('joining', () => {
  it('converges on one table from the seeds, whatever order the nodes start in', async () => {
    for (const order of [...permutations([0, 1, 2]), null]) {
      const c = await cluster({ startAll: false });
      const ups: ReturnType<typeof track>[] = [];
      if (order === null) {
        for (const i of [0, 1, 2]) ups.push(track(clusterOf(await c.start(i)).whenUp));
      } else {
        for (const i of order) {
          ups.push(track(clusterOf(await c.start(i)).whenUp));
          await c.advance(2_000);
        }
      }
      await c.advance(10_000);
      const label = order === null ? 'together' : order.join(',');
      expect(
        ups.map((u) => u.state),
        label,
      ).toEqual(['resolved', 'resolved', 'resolved']);
      const expected = c.nodes.map((n) => `${n.address}#${String(n.remoting.self.uid)} up`);
      for (const n of c.nodes) expect(table(n), `${label}: ${n.name}`).toEqual(expected);
      // Every node saw every member come up, once, itself included.
      for (const n of c.nodes) {
        expect(
          memberEvents(n).map((e) => e.type),
          `${label}: ${n.name}`,
        ).toEqual(['memberUp', 'memberUp', 'memberUp']);
      }
      await c.shutdown();
    }
  });

  it('never forms a cluster from a seed that isn’t the first', async () => {
    const c = await cluster({ startAll: false });
    const second = track(clusterOf(await c.start(1)).whenUp);
    const third = track(clusterOf(await c.start(2)).whenUp);
    await c.advance(60_000);
    expect([second.state, third.state]).toEqual(['pending', 'pending']);
    expect(table(c.node(1))).toEqual([]);
    expect(table(c.node(2))).toEqual([]);
    expect(memberEvents(c.node(1))).toEqual([]);
  });

  it('forms a cluster alone from the first seed, after seedTimeoutMs', async () => {
    const c = await cluster({ startAll: false });
    const first = clusterOf(await c.start(0));
    const up = track(first.whenUp);
    await c.advance(4_999);
    expect(up.state).toBe('pending');
    await c.advance(1);
    expect(up.state).toBe('resolved');
    expect(memberEvents(c.node(0)).map((e) => [e.type, e.at])).toEqual([['memberUp', 5_000]]);
    expect(table(c.node(0))).toEqual([`node-1#${String(first.self.uid)} up`]);
    expect(c.node(0).logs.some((l) => l.msg.includes('formed the cluster alone'))).toBe(true);
  });

  it('forms a cluster at once when its only seed is itself', async () => {
    const c = await cluster({ addresses: ['solo'], membership: { seeds: ['solo'] } });
    await clusterOf(c.node(0)).whenUp;
    expect(c.scheduler.now()).toBe(0);
    expect(table(c.node(0))).toEqual([`solo#${String(c.node(0).remoting.self.uid)} up`]);
  });

  it('joins a node that isn’t a seed through one', async () => {
    const c = await cluster({
      addresses: ['node-1', 'node-2', 'extra'],
      membership: { seeds: ['node-1', 'node-2'] },
    });
    await c.advance(10_000);
    expect(table(c.node(2))).toHaveLength(3);
    expect(table(c.node(0))).toEqual(table(c.node(2)));
  });

  it('rejects whenUp when the node leaves before it’s in', async () => {
    const c = await cluster({ startAll: false });
    const lone = clusterOf(await c.start(1));
    const up = track(lone.whenUp);
    await lone.leave();
    await c.settle();
    expect(up.state).toBe('rejected');
    await expect(lone.whenUp).rejects.toThrow('before it was in the cluster');
  });

  it('runs on TCP too', async () => {
    const c = await cluster({ network: 'tcp' });
    await c.advance(10_000);
    // Tables are sorted by address, and TCP's ports come in any order.
    const up = (nodes: readonly TestNode[]) =>
      [...nodes]
        .sort((x, y) => (x.address < y.address ? -1 : 1))
        .map((n) => `${n.address}#${String(n.remoting.self.uid)} up`);
    for (const n of c.nodes) expect(table(n)).toEqual(up(c.nodes));
    await clusterOf(c.node(2)).leave();
    await c.advance(10);
    expect(table(c.node(0))).toEqual(up(c.nodes.slice(0, 2)));
  });
});

describe('failure detection', () => {
  it('makes a killed node unreachable, then down, on every node, and ends its watches', async () => {
    const c = await cluster();
    await c.advance(10_000);
    const [a, b, gone] = [c.node(0), c.node(1), c.node(2)];
    const log: string[] = [];
    const w = a.system.spawn(watcher(log), 'watcher');
    const target = remoteRef(
      a,
      gone,
      gone.system.spawn(actor({ initial: null, receive: (s) => s })),
    );
    w.tell({ watch: target });
    await c.advance(100);
    const killedAt = c.scheduler.now();
    c.kill(2);
    await c.advance(5);
    // Sent once the connection has dropped: it waits for the node, until the node is down.
    (target as ActorRef<string>).tell('anyone there?');
    await c.advance(30_000);

    for (const n of [a, b]) {
      const events = memberEvents(n, gone.address);
      const unreachable = events.find((e) => e.type === 'reachability');
      const down = events.find((e) => e.type === 'memberDown');
      expect(unreachable && 'reachable' in unreachable && unreachable.reachable).toBe(false);
      // Heard last at most one heartbeat before the kill, and checked once a heartbeat.
      expect((unreachable?.at ?? 0) - killedAt).toBeGreaterThanOrEqual(4_000);
      expect((unreachable?.at ?? 0) - killedAt).toBeLessThanOrEqual(6_000);
      expect((down?.at ?? 0) - (unreachable?.at ?? 0)).toBe(10_000);
      expect(table(n)).toContain(
        `${gone.address}#${String(gone.remoting.self.uid)} down unreachable`,
      );
    }
    expect(log).toEqual([`watcher saw ${target.path} fail: Error: node node-3 is gone: down`]);
    const letters = a.events.flatMap((e) =>
      e.type === 'deadLetter' ? [[e.message, e.reason]] : [],
    );
    expect(letters).toEqual([['anyone there?', 'unreachable']]);
  });

  it('shows a member unreachable before it’s down, and reachable again if it comes back', async () => {
    let muted = false;
    const c = await cluster({
      wrap: (name, t) =>
        name === 'node-3' ? dropping(t, (f) => muted && isHeartbeat(f), true) : t,
    });
    await c.advance(10_000);
    const [a, quiet] = [c.node(0), c.node(2)];
    muted = true;
    await c.advance(7_000);
    expect(table(a)).toContain(`node-3#${String(quiet.remoting.self.uid)} up unreachable`);
    muted = false;
    await c.advance(2_000);
    expect(table(a)).toContain(`node-3#${String(quiet.remoting.self.uid)} up`);
    expect(story(memberEvents(a, 'node-3')).slice(1)).toEqual([
      `reachability ${String(quiet.remoting.self.uid)} false`,
      `reachability ${String(quiet.remoting.self.uid)} true`,
    ]);
  });

  it('replaces a node restarted with a new uid, before it was downed', async () => {
    const c = await cluster();
    await c.advance(10_000);
    const old = c.node(2);
    c.kill(2);
    await c.advance(1_000);
    const fresh = await c.restart(2);
    await c.advance(10_000);
    const expected = c.nodes.map((n) => `${n.address}#${String(n.remoting.self.uid)} up`);
    for (const n of c.nodes) expect(table(n), n.name).toEqual(expected);
    const [oldUid, newUid] = [old.remoting.self.uid, fresh.remoting.self.uid];
    for (const n of [c.node(0), c.node(1)]) {
      expect(story(memberEvents(n, 'node-3')), n.name).toEqual([
        `memberUp ${String(oldUid)}`,
        `memberRemoved ${String(oldUid)}`,
        `memberUp ${String(newUid)}`,
      ]);
    }
  });

  it('replaces a node restarted with a new uid, after it was downed', async () => {
    const c = await cluster();
    await c.advance(10_000);
    const old = c.node(2);
    c.kill(2);
    await c.advance(20_000);
    expect(table(c.node(0))).toContain(`node-3#${String(old.remoting.self.uid)} down unreachable`);
    const fresh = await c.restart(2);
    await c.advance(10_000);
    const expected = c.nodes.map((n) => `${n.address}#${String(n.remoting.self.uid)} up`);
    for (const n of c.nodes) expect(table(n), n.name).toEqual(expected);
    const [oldUid, newUid] = [old.remoting.self.uid, fresh.remoting.self.uid];
    expect(story(memberEvents(c.node(0), 'node-3'))).toEqual([
      `memberUp ${String(oldUid)}`,
      `reachability ${String(oldUid)} false`,
      `memberDown ${String(oldUid)}`,
      `memberRemoved ${String(oldUid)}`,
      `memberUp ${String(newUid)}`,
    ]);
  });

  it('prunes a down member’s tombstone after pruneAfterMs', async () => {
    const c = await cluster({ membership: { pruneAfterMs: 60_000 } });
    await c.advance(10_000);
    c.kill(2);
    await c.advance(30_000);
    expect(table(c.node(0))).toHaveLength(3);
    await c.advance(61_000);
    expect(table(c.node(0))).toHaveLength(2);
    expect(memberEvents(c.node(0), 'node-3').map((e) => e.type)).toEqual([
      'memberUp',
      'reachability',
      'memberDown',
      'memberRemoved',
    ]);
  });
});

describe('downing and leaving', () => {
  it('makes a node that learns it’s down leave', async () => {
    let muted = false;
    const c = await cluster({
      wrap: (name, t) => (name === 'node-3' ? dropping(t, (f) => muted && isHeartbeat(f)) : t),
    });
    await c.advance(10_000);
    const downed = c.node(2);
    const uid = downed.remoting.self.uid;
    // Its heartbeats are lost, but it hears the others: so they down it, and it doesn't down them.
    muted = true;
    await c.advance(20_000);
    for (const n of [c.node(0), c.node(1)]) {
      expect(table(n)).toContain(`node-3#${String(uid)} down unreachable`);
    }
    expect(story(memberEvents(downed, 'node-3'))).toEqual([
      `memberUp ${String(uid)}`,
      `memberDown ${String(uid)}`,
    ]);
    expect(downed.logs.some((l) => l.level === 'warn' && l.msg.includes('downed this node'))).toBe(
      true,
    );
    // It has left: leave() is already done, and it tells no one anything more.
    await clusterOf(downed).leave();
    const sent = memberEvents(downed).length;
    await c.advance(30_000);
    expect(memberEvents(downed)).toHaveLength(sent);
    // The others never saw it as anything but down.
    expect(memberEvents(c.node(0), 'node-3').map((e) => e.type)).toEqual([
      'memberUp',
      'reachability',
      'memberDown',
    ]);
  });

  it('removes a leaving node from every table once it has left', async () => {
    const c = await cluster();
    await c.advance(10_000);
    const leaver = c.node(2);
    const uid = leaver.remoting.self.uid;
    const left = clusterOf(leaver).leave();
    expect(clusterOf(leaver).leave()).toBe(left);
    await c.advance(10);
    await left;
    const expected = c.nodes
      .slice(0, 2)
      .map((n) => `${n.address}#${String(n.remoting.self.uid)} up`);
    for (const n of c.nodes.slice(0, 2)) {
      expect(table(n), n.name).toEqual(expected);
      expect(story(memberEvents(n, 'node-3')), n.name).toEqual([
        `memberUp ${String(uid)}`,
        `memberLeaving ${String(uid)}`,
        `memberRemoved ${String(uid)}`,
      ]);
    }
    expect(story(memberEvents(leaver, 'node-3'))).toEqual([
      `memberUp ${String(uid)}`,
      `memberLeaving ${String(uid)}`,
      `memberRemoved ${String(uid)}`,
    ]);
    // Nobody heartbeats it, so nobody finds it unreachable or downs it later.
    await c.advance(30_000);
    expect(memberEvents(c.node(0), 'node-3')).toHaveLength(3);
  });

  it('leaves when the system terminates', async () => {
    const c = await cluster();
    await c.advance(10_000);
    await c.node(2).system.terminate();
    await c.advance(10);
    expect(table(c.node(0))).toHaveLength(2);
    expect(memberEvents(c.node(0), 'node-3').map((e) => e.type)).toEqual([
      'memberUp',
      'memberLeaving',
      'memberRemoved',
    ]);
  });

  it('ignores a downed frame from a node that isn’t a member', async () => {
    const c = await cluster();
    await c.advance(10_000);
    const handle = createSystem({ name: 'stranger', scheduler: c.scheduler });
    const stranger = startRemoting(handle.system, {
      cluster: 'test',
      transport: c.network.transport('stranger'),
    });
    await stranger.whenListening;
    stranger.signal('node-1', { t: 'downed' });
    await c.advance(10);
    stranger.signal('node-1', { t: 'downed' });
    await c.advance(10);
    expect(table(c.node(0))).toHaveLength(3);
    await handle.system.terminate();
    await stranger.close();
  });

  it('answers gossip from a node that knew less, once', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    await c.advance(10_000);
    const handle = createSystem({ name: 'stranger', scheduler: c.scheduler });
    const logs: string[] = [];
    const stranger = startRemoting(handle.system, {
      cluster: 'test',
      transport: c.network.transport('stranger'),
    });
    stranger.onControl((from, frame) => {
      logs.push(`${String(frame.t)} from ${from.address}, reply ${String(frame.reply)}`);
    });
    // With no connection yet, a signal is dropped, and dials.
    expect(stranger.signal('node-1', { t: 'gossip', members: [] })).toBe(false);
    await c.advance(10);
    expect(stranger.signal('node-1', { t: 'gossip', members: [] })).toBe(true);
    stranger.signal('node-1', { t: 'gossip', members: [], reply: true });
    await c.advance(10);
    // One answer to each gossip that wasn't itself an answer.
    expect(logs).toEqual(['gossip from node-1, reply true']);
    await handle.system.terminate();
    await stranger.close();
  });

  it('logs and ignores frames it doesn’t understand', async () => {
    const c = await cluster({ addresses: ['node-1', 'node-2'] });
    await c.advance(10_000);
    const [a, b] = [c.node(0), c.node(1)];
    a.remoting.signal(b.address, { t: 'gossip', members: 'not a table' });
    a.remoting.signal(b.address, { t: 'whatever' });
    await c.advance(10);
    const warnings = b.logs.filter((l) => l.level === 'warn').map((l) => l.msg);
    expect(warnings).toEqual([
      'cluster: ignored gossip from node-1 that isn’t a table',
      'cluster: ignored a "whatever" frame from node-1',
    ]);
    expect(table(b)).toHaveLength(2);
  });
});

describe('determinism', () => {
  it('gives identical events on every node for the same seed', async () => {
    const run = async (seed: number) => {
      const c = await createTestCluster({ membership: {}, seed });
      await c.advance(10_000);
      c.kill(1);
      await c.advance(20_000);
      await c.restart(1);
      await c.advance(10_000);
      await clusterOf(c.node(2)).leave();
      await c.advance(5_000);
      const out = c.incarnations.map((n) => JSON.stringify(n.events));
      await c.shutdown();
      return out;
    };
    const first = await run(42);
    expect(await run(42)).toEqual(first);
    expect(await run(43)).not.toEqual(first);
  });
});

describe('joinCluster options', () => {
  const scheduler = new ManualScheduler();
  const network = inMemoryNetwork({ scheduler });
  let n = 0;
  const fresh = (): { system: ActorSystem; transport: Transport } => {
    const { system } = createSystem({ name: 'opts', scheduler });
    return { system, transport: network.transport(`opts-${String(++n)}`) };
  };
  const base = (transport: Transport): ClusterOptions => ({
    name: 'test',
    transport,
    seeds: ['a'],
  });

  it.each<[string, (o: ClusterOptions) => unknown, string]>([
    ['unknown fields', (o) => ({ ...o, gossipMs: 1 }), 'unknown option "gossipMs"'],
    ['options that aren’t an object', () => 'x', 'options must be an object'],
    ['a bad name', (o) => ({ ...o, name: 'Opening Night' }), 'name must be lower-case'],
    ['a name that isn’t a string', (o) => ({ ...o, name: 1 }), 'name must be lower-case'],
    ['no transport', (o) => ({ ...o, transport: {} }), 'transport must be a Transport'],
    ['no seeds', (o) => ({ ...o, seeds: [] }), 'seeds must be a non-empty array'],
    ['seeds that aren’t an array', (o) => ({ ...o, seeds: 'a' }), 'seeds must be a non-empty'],
    ['a bad seed', (o) => ({ ...o, seeds: ['a#1'] }), 'a seed must be an address'],
    ['a seed twice', (o) => ({ ...o, seeds: ['a', 'a'] }), 'seed "a" is listed twice'],
    ['heartbeatMs 0', (o) => ({ ...o, heartbeatMs: 0 }), 'heartbeatMs must be a positive'],
    ['heartbeatMs 1.5', (o) => ({ ...o, heartbeatMs: 1.5 }), 'heartbeatMs must be a positive'],
    [
      'unreachableAfterMs at heartbeatMs',
      (o) => ({ ...o, heartbeatMs: 1_000, unreachableAfterMs: 1_000 }),
      'must be more than heartbeatMs',
    ],
    ['downAfterMs -1', (o) => ({ ...o, downAfterMs: -1 }), 'downAfterMs must be a non-negative'],
    ['seedTimeoutMs NaN', (o) => ({ ...o, seedTimeoutMs: NaN }), 'seedTimeoutMs must be'],
    ['bufferSize -1', (o) => ({ ...o, bufferSize: -1 }), 'bufferSize must be a non-negative'],
    ['maxFrameBytes 0', (o) => ({ ...o, maxFrameBytes: 0 }), 'maxFrameBytes must be a positive'],
  ])('throws for %s', (_, change, message) => {
    const { system, transport } = fresh();
    expect(() => joinCluster(system, change(base(transport)) as ClusterOptions)).toThrow(
      new RegExp(`^joinCluster: .*${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    expect(() => joinCluster(system, change(base(transport)) as ClusterOptions)).toThrow(TypeError);
  });

  it('throws for a system that wasn’t made by createActorSystem', () => {
    const { transport } = fresh();
    expect(() => joinCluster({} as ActorSystem, base(transport))).toThrow(TypeError);
  });

  it('throws for a system that’s already in a cluster', async () => {
    const { system, transport } = fresh();
    const first = joinCluster(system, base(transport));
    expect(() => joinCluster(system, base(network.transport('another')))).toThrow(
      'joinCluster: this system is already in a cluster',
    );
    await first.leave();
  });

  it('accepts every option at its edge', async () => {
    const { system, transport } = fresh();
    const c = joinCluster(system, {
      ...base(transport),
      heartbeatMs: 1,
      unreachableAfterMs: 2,
      downAfterMs: 0,
      seedTimeoutMs: 0,
      bufferSize: 0,
      maxFrameBytes: 1,
    });
    expect(c.self.address).toBe(transport.address);
    expect(c.members()).toEqual([]);
    await c.leave();
  });
});
