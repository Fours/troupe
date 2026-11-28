import { afterEach, describe, expect, it } from 'vitest';
import { decideDowning } from '../../src/cluster/downing.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { createTestCluster, type TestCluster, type TestNode } from '../helpers/cluster.js';

// Milestone 5, T7 (decision 0042): keep the majority. The hunt's commonest failure was split
// brain: when a partition cut both ways, each side downed the other and the halves never merged.
// Now only a side with more than half the members downs the rest; a smaller side downs itself,
// and its nodes come back as new incarnations through their seeds.

describe('decideDowning', () => {
  const side = (...reach: boolean[]) =>
    reach.map((reachable, i) => ({ address: `node-${String(i + 1)}`, reachable }));

  it('keeps the cluster on more than half, and gives it up on less', () => {
    expect(decideDowning(side(true, true, false))).toBe('others');
    expect(decideDowning(side(true, false, false))).toBe('self');
    expect(decideDowning(side(true, true, true, false, false))).toBe('others');
    expect(decideDowning(side(true, true, false, false, false))).toBe('self');
  });

  it('keeps it at exactly half only on the side with the lowest address', () => {
    expect(decideDowning(side(true, true, false, false))).toBe('others');
    expect(decideDowning(side(false, false, true, true))).toBe('self');
    // Sorted by nothing: the lowest address is found, not assumed first.
    expect(
      decideDowning([
        { address: 'node-3', reachable: true },
        { address: 'crowd', reachable: false },
        { address: 'node-1', reachable: true },
        { address: 'node-2', reachable: false },
      ]),
    ).toBe('self');
  });

  it('breaks a tie by the first seed that’s a member, where there is one', () => {
    // Traced in the hunt (contract seed 10,475): by address the crowd, a client, kept a 2–2 split
    // over node-1 and node-3, and a kill on its side a moment later left only the crowd.
    const split = [
      { address: 'crowd', reachable: true },
      { address: 'node-2', reachable: true },
      { address: 'node-1', reachable: false },
      { address: 'node-3', reachable: false },
    ];
    expect(decideDowning(split)).toBe('others');
    expect(decideDowning(split, false, 'node-1')).toBe('self');
    expect(decideDowning(split, false, 'node-2')).toBe('others');
    // A first seed that isn't a member is no help: the lowest address decides.
    expect(decideDowning(split, false, 'node-9')).toBe('others');
  });

  it('never keeps it on a side of one, unless that node is the only seed', () => {
    // Found by the hunt (chaos seed 710 on the network mix): the crowd knew only node-1 when a
    // partition cut it off, won the tie on its address, and downed node-1 for good.
    expect(
      decideDowning([
        { address: 'crowd', reachable: true },
        { address: 'node-1', reachable: false },
      ]),
    ).toBe('self');
    expect(decideDowning(side(true, false))).toBe('self');
    expect(decideDowning(side(true, false), true)).toBe('others');
    expect(decideDowning(side(true))).toBe('others');
  });
});

const open: TestCluster[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.shutdown()));
});

const MEMBERSHIP = {
  heartbeatMs: 200,
  unreachableAfterMs: 1_000,
  downAfterMs: 1_000,
  seedTimeoutMs: 500,
};

async function cluster(addresses: readonly string[], seeds?: readonly string[]) {
  const c = await createTestCluster({
    addresses,
    network: 'simulated',
    membership: { ...MEMBERSHIP, ...(seeds === undefined ? {} : { seeds }) },
  });
  open.push(c);
  await c.advance(3_000);
  return c;
}

function net(c: TestCluster) {
  if (c.simulated === undefined) throw new Error('not on the simulated network');
  return c.simulated;
}

/** What `n` has as up, by address, or `left` once it has left. */
function up(n: TestNode): string {
  const c = n.cluster;
  if (c === undefined) throw new Error('no cluster');
  const self = c.members().find((m) => m.address === n.address && m.uid === n.remoting.self.uid);
  if (self === undefined || self.status === 'down') return 'left';
  return c
    .members()
    .filter((m) => m.status === 'up')
    .map((m) => m.address)
    .join(' ');
}

const downedItself = (n: TestNode): boolean =>
  n.logs.some((l) => l.level === 'warn' && l.msg.includes('so it downed itself'));

describe('keep the majority', () => {
  it('downs the smaller side of a partition, which downs itself, and they merge once healed', async () => {
    const c = await cluster(['node-1', 'node-2', 'node-3', 'node-4', 'node-5']);
    const heal = net(c).partition(['node-1', 'node-2', 'node-3'], ['node-4', 'node-5']);
    await c.advance(5_000);
    expect(c.nodes.map(up)).toEqual([
      'node-1 node-2 node-3',
      'node-1 node-2 node-3',
      'node-1 node-2 node-3',
      'left',
      'left',
    ]);
    expect(c.nodes.map(downedItself)).toEqual([false, false, false, true, true]);
    heal();
    // Their processes start again, as a process manager would, with new uids.
    await c.restart(3);
    await c.restart(4);
    await c.advance(3_000);
    const all = 'node-1 node-2 node-3 node-4 node-5';
    expect(c.nodes.map(up)).toEqual([all, all, all, all, all]);
  });

  it('keeps the half with the lowest address when a partition splits the cluster evenly', async () => {
    const c = await cluster(['node-1', 'node-2', 'node-3', 'node-4']);
    net(c).partition(['node-3', 'node-4'], ['node-1', 'node-2']);
    await c.advance(5_000);
    expect(c.nodes.map(up)).toEqual(['node-1 node-2', 'node-1 node-2', 'left', 'left']);
  });

  it('keeps the half with the first seed, not the lowest address, when the two differ', async () => {
    const c = await cluster(['node-1', 'node-2', 'node-3', 'node-4'], ['node-3', 'node-1']);
    net(c).partition(['node-1', 'node-2'], ['node-3', 'node-4']);
    await c.advance(5_000);
    expect(c.nodes.map(up)).toEqual(['left', 'left', 'node-3 node-4', 'node-3 node-4']);
  });

  it('makes a node that hears no one down itself, not the others, in a one-way partition', async () => {
    // Before 0042, a node whose incoming frames were cut found every other member unreachable
    // and downed them all, while they, still hearing it, downed no one.
    const c = await cluster(['node-1', 'node-2', 'node-3']);
    net(c).partition(['node-1', 'node-2'], ['node-3'], { oneWay: true });
    await c.advance(5_000);
    expect(c.nodes.map(up)).toEqual(['node-1 node-2', 'node-1 node-2', 'left']);
    expect(downedItself(c.node(2))).toBe(true);
    for (const n of [c.node(0), c.node(1)]) {
      expect(
        n.events.filter((e) => e.type === 'memberDown').map((e) => 'address' in e && e.address),
      ).toEqual(['node-3']);
    }
  });

  it('keeps a node of two up only when it is the only seed', async () => {
    const both = await cluster(['node-1', 'node-2']);
    net(both).partition(['node-1'], ['node-2']);
    await both.advance(5_000);
    expect(both.nodes.map(up)).toEqual(['left', 'left']);

    const one = await cluster(['node-1', 'node-2'], ['node-1']);
    net(one).partition(['node-1'], ['node-2']);
    await one.advance(5_000);
    expect(one.nodes.map(up)).toEqual(['node-1', 'left']);
  });

  it('merges a cluster the first seed formed alone during a partition, once it heals', async () => {
    // Found by the hunt (contract seed 80): node-1, alone on its side, downed itself, restarted
    // while the partition held, and formed a cluster of its own as the first seed. Nothing
    // brought the two together again.
    const c = await cluster(['node-1', 'node-2', 'node-3']);
    const heal = net(c).partition(['node-1'], ['node-2', 'node-3']);
    await c.advance(5_000);
    expect(up(c.node(0))).toBe('left');
    await c.restart(0);
    await c.advance(2_000);
    expect(up(c.node(0))).toBe('node-1');
    heal();
    await c.advance(3_000);
    const all = 'node-1 node-2 node-3';
    expect(c.nodes.map(up)).toEqual([all, all, all]);
  });

  it('lets no one new in while a member is unreachable, except at that member’s own address', async () => {
    // Found by the hunt (chaos seed 9,264): a member let a newcomer in during a partition, so
    // its side counted one more member than the far side knew of, and both sides kept the
    // cluster. Akka lets members in only on convergence, for the same reason.
    const c = await createTestCluster({
      addresses: ['node-1', 'node-2', 'node-3', 'node-4'],
      network: 'simulated',
      membership: { ...MEMBERSHIP, seeds: ['node-1'] },
      startAll: false,
    });
    open.push(c);
    for (const i of [0, 1, 2]) await c.start(i);
    await c.advance(3_000);
    // node-1 stops hearing node-2: unreachable after a second, downed a second later.
    const from = c.scheduler.now();
    net(c).partition(['node-2'], ['node-1'], { oneWay: true });
    await c.advance(1_300);
    await c.start(3);
    await c.advance(400);
    expect(c.scheduler.now() - from).toBeLessThan(2_000);
    expect(up(c.node(0))).toBe('node-1 node-2 node-3');
    // Once node-2 is down, node-1 hears everyone it talks to, and lets node-4 in.
    await c.advance(1_500);
    expect(up(c.node(0))).toBe('node-1 node-3 node-4');
  });

  it('lets a restarted node in while its old incarnation is unreachable', async () => {
    const c = await cluster(['node-1', 'node-2', 'node-3']);
    const old = c.node(2).remoting.self.uid;
    c.kill(2);
    await c.advance(1_300);
    expect(
      c
        .node(0)
        .cluster?.members()
        .find((m) => m.uid === old)?.reachable,
    ).toBe(false);
    const fresh = await c.restart(2);
    await c.advance(300);
    expect(up(c.node(0))).toBe('node-1 node-2 node-3');
    expect(
      c
        .node(0)
        .cluster?.members()
        .some((m) => m.uid === fresh.remoting.self.uid),
    ).toBe(true);
  });

  it('makes a node that was downed before it heard it was in give up joining', async () => {
    // Found by the hunt (chaos seed 9,347 on the network mix): node-1 let node-3 in, a one-way
    // partition lost the welcome, and the others downed node-3, which, still joining, ignored
    // being told so and asked to join as that uid for good.
    let welcomes = true;
    const c = await createTestCluster({
      addresses: ['node-1', 'node-2', 'node-3'],
      membership: MEMBERSHIP,
      startAll: false,
      wrap: (name, t) => (name === 'node-3' ? losingGossip(t, () => !welcomes) : t),
    });
    open.push(c);
    for (const i of [0, 1]) await c.start(i);
    await c.advance(3_000);
    welcomes = false;
    const joiner = await c.start(2);
    let outcome = 'pending';
    joiner.cluster?.whenUp.then(
      () => (outcome = 'up'),
      (error: unknown) => (outcome = String(error)),
    );
    // Let in, but never told: a joining node doesn't heartbeat, so the others down it.
    await c.advance(4_000);
    expect(up(c.node(0))).toBe('node-1 node-2');
    expect(c.node(0).events.some((e) => e.type === 'memberDown' && e.address === 'node-3')).toBe(
      true,
    );
    expect(outcome).toContain('downed this node while it joined');
    expect(joiner.logs.some((l) => l.msg.includes('was downed before it heard it was in'))).toBe(
      true,
    );
    // Started again as a new uid, it gets in.
    welcomes = true;
    await c.restart(2);
    await c.advance(2_000);
    expect(up(c.node(0))).toBe('node-1 node-2 node-3');
  });
});

/** Wraps a transport so that, while `losing()`, the gossip that arrives is lost. */
function losingGossip(inner: Transport, losing: () => boolean): Transport {
  const wrap = (c: Connection): Connection => ({
    send: (frame) => {
      c.send(frame);
    },
    onFrame: (listener) => {
      c.onFrame((frame) => {
        if (!(losing() && frame.includes('"t":"gossip"'))) listener(frame);
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
