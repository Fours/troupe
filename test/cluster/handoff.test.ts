import { afterEach, describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { desiredOwner, shardOf } from '../../src/cluster/placement.js';
import type { EntityType, EntityTypeOptions } from '../../src/cluster/sharding.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import type { Persistence } from '../../src/persistence/types.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { account, type AccountCmd, type Receipt } from '../helpers/account.js';
import {
  FAST,
  createTestCluster,
  isolatable,
  type TestCluster,
  type TestClusterOptions,
  type TestNode,
} from '../helpers/cluster.js';
import { deferred } from '../helpers/deferred.js';
import { faultyJournal } from '../helpers/faulty-journal.js';

// Milestone 4, T7: passivation, rebalancing, handoff and remembering (decision 0030). Shards move
// only by handoff or an expired lease. A handoff stops the shard's entities once they've handled
// what they have, releases the lease, and sends what waited to the new owner.

const open: TestCluster[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.shutdown()));
});

async function cluster(opts: TestClusterOptions = {}): Promise<TestCluster> {
  const c = await createTestCluster({ ...FAST, ...opts });
  open.push(c);
  await c.advance(2_000);
  for (const n of c.nodes) await clusterOf(n).whenUp;
  return c;
}

function clusterOf(n: TestNode) {
  const c = n.cluster;
  if (c === undefined) throw new Error(`${n.name} has no cluster`);
  return c;
}

interface Count {
  readonly id: string;
  readonly count: number;
  readonly node: string;
}
type CounterMsg =
  | { readonly type: 'add'; readonly by: number }
  | { readonly type: 'note'; readonly n: number }
  | { readonly type: 'quit' }
  | { readonly type: 'get'; readonly replyTo: ActorRef<Count> };

/** A counter entity that says which node it runs on, records notes, and can stop itself. */
function counter(node: string, notes: number[] = []) {
  return (id: string) =>
    actor<CounterMsg, number>({
      initial: 0,
      receive(count, msg, ctx) {
        switch (msg.type) {
          case 'add':
            return count + msg.by;
          case 'note':
            notes.push(msg.n);
            return count;
          case 'quit':
            ctx.stop();
            return count;
          case 'get':
            msg.replyTo.tell({ id, count, node });
            return count;
        }
      },
    });
}

function init(
  n: TestNode,
  opts: Partial<EntityTypeOptions<CounterMsg, number>> = {},
  notes: number[] = [],
): EntityType<CounterMsg> {
  return clusterOf(n).sharding.init<CounterMsg, number>({
    type: 'counter',
    entity: counter(n.name, notes),
    shardCount: 16,
    ...opts,
  });
}

/** Asks, moving virtual time on until the reply comes. */
async function ask<R>(c: TestCluster, run: () => Promise<R>, ms = 5_000): Promise<R> {
  const promise = run();
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  for (let waited = 0; !state.settled && waited < ms; waited += 50) await c.advance(50);
  return promise;
}

type Acquired = Extract<SystemEvent, { type: 'shardAcquired' }>;
type Released = Extract<SystemEvent, { type: 'shardReleased' }>;

function acquired(n: TestNode): Acquired[] {
  return n.events.filter((e): e is Acquired => e.type === 'shardAcquired');
}

function released(n: TestNode): Released[] {
  return n.events.filter((e): e is Released => e.type === 'shardReleased');
}

/** The entity paths `spawned` on a node, as `at id`. */
function spawns(n: TestNode, type = 'counter'): { at: number; id: string }[] {
  const pattern = new RegExp(`^/system/sharding/${type}/\\d+/([^/]+)$`);
  return n.events.flatMap((e) => {
    if (e.type !== 'spawned') return [];
    const id = pattern.exec(e.path)?.[1];
    return id === undefined ? [] : [{ at: e.at, id }];
  });
}

function stops(n: TestNode, id: string): number {
  return n.events.filter(
    (e) =>
      e.type === 'stopped' && new RegExp(`/${id}$`).test(e.path) && e.path.includes('/sharding/'),
  ).length;
}

/** Dead letters of messages to entities, on every node. */
function deadLetters(c: TestCluster) {
  return c.incarnations.flatMap((n) =>
    n.events
      .filter((e) => e.type === 'deadLetter' && e.recipient.startsWith('/sharding/'))
      .map((e) => ({ node: n.name, ...e })),
  );
}

/** One id in each shard, `show-<i>`, for the first id that falls in it. */
function oneIdPerShard(shardCount: number): string[] {
  const ids: (string | undefined)[] = new Array<string | undefined>(shardCount).fill(undefined);
  for (let i = 0; ids.includes(undefined); i++) {
    const id = `show-${String(i)}`;
    const shard = shardOf(id, shardCount);
    ids[shard] ??= id;
  }
  return ids as string[];
}

/** An id whose shard of `type` belongs on `address`, of the cluster's three nodes. */
function idOn(c: TestCluster, type: string, address: string): string {
  const addresses = c.nodes.map((n) => n.address);
  for (let i = 0; ; i++) {
    const id = `${type}-${String(i)}`;
    if (desiredOwner(`${type}/${String(shardOf(id, 16))}`, addresses) === address) return id;
  }
}

describe('passivation', () => {
  it('stops an entity that has had no message for idleMs, and its next message starts it again', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const t = init(c.node(0), { passivation: { idleMs: 1_000 } });
    const node = c.node(0);
    t.ref('hamlet').tell({ type: 'add', by: 1 });
    await c.advance(600);
    t.ref('hamlet').tell({ type: 'add', by: 1 });
    await c.advance(600);
    // 1,200 ms since the first message, but only 600 since the last.
    expect(stops(node, 'hamlet')).toBe(0);
    await c.advance(600);
    expect(stops(node, 'hamlet')).toBe(1);
    const reply = await ask(c, () =>
      t.ref('hamlet').ask<Count>((replyTo) => ({ type: 'get', replyTo })),
    );
    // A new incarnation, which hasn't seen the adds.
    expect(reply.count).toBe(0);
    expect(spawns(node).map((s) => s.id)).toEqual(['hamlet', 'hamlet']);
    expect(deadLetters(c)).toEqual([]);
  });

  it('holds what arrives while an entity stops, and gives it to the next incarnation', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const got: string[] = [];
    let incarnation = 0;
    const hold = deferred();
    const t = clusterOf(c.node(0)).sharding.init<string, null>({
      type: 'slow',
      passivation: { idleMs: 500 },
      entity: () => {
        const mine = ++incarnation;
        return actor<string, null>({
          initial: null,
          receive: async (state, msg) => {
            if (msg === 'slow') await hold.promise;
            got.push(`${String(mine)} ${msg}`);
            return state;
          },
        });
      },
    });
    const unhold = c.hold();
    t.ref('ophelia').tell('slow');
    t.ref('ophelia').tell('queued');
    // Idle by the shard's clock: it asks the entity to stop after what it has queued.
    await c.advance(1_500);
    expect(spawns(c.node(0), 'slow')).toHaveLength(1);
    t.ref('ophelia').tell('during');
    await c.advance(100);
    expect(got).toEqual([]);
    hold.resolve();
    unhold();
    await c.advance(100);
    expect(got).toEqual(['1 slow', '1 queued', '2 during']);
    expect(spawns(c.node(0), 'slow')).toHaveLength(2);
    expect(deadLetters(c)).toEqual([]);
  });
});

describe('rebalancing', () => {
  it('gives a new node the shards it tops, at most maxHandoffs at a time from each node, losing no message', async () => {
    const addresses = ['node-1', 'node-2', 'node-3', 'node-4'];
    const c = await createTestCluster({ ...FAST, addresses, startAll: false });
    open.push(c);
    for (const i of [0, 1, 2]) await c.start(i);
    await c.advance(2_000);
    const notes: number[] = [];
    const types: EntityType<CounterMsg>[] = [];
    for (const i of [0, 1, 2]) types.push(init(c.node(i), { shardCount: 64 }, notes));
    const ids = oneIdPerShard(64);
    for (const id of ids) types[0]?.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(3_000);
    expect([0, 1, 2].flatMap((i) => acquired(c.node(i)))).toHaveLength(64);

    await c.start(3);
    await c.advance(1_000);
    types.push(init(c.node(3), { shardCount: 64 }, notes));
    const sent: number[] = [];
    for (let n = 0; n < 400; n++) {
      types[n % 4]?.ref(ids[n % 64] as string).tell({ type: 'note', n });
      sent.push(n);
      await c.advance(25);
    }
    await c.advance(3_000);

    const theirs = Array.from({ length: 64 }, (_, s) => s).filter(
      (s) => desiredOwner(`counter/${String(s)}`, addresses) === 'node-4',
    );
    expect(theirs.length).toBeGreaterThan(6);
    const handedOff = [0, 1, 2].flatMap((i) =>
      released(c.node(i)).filter((e) => e.reason === 'handoff'),
    );
    expect(handedOff.map((e) => e.shard).sort((a, b) => a - b)).toEqual(theirs);
    expect(
      acquired(c.node(3))
        .map((e) => e.shard)
        .sort((a, b) => a - b),
    ).toEqual(theirs);
    const takenAt = new Map(acquired(c.node(3)).map((e) => [e.shard, e.at]));
    for (const i of [0, 1, 2]) {
      const mine = released(c.node(i)).filter((e) => e.reason === 'handoff');
      // From each release to the new owner's acquire, at most two at once, and they go in
      // rounds rather than all together.
      const points = mine.flatMap((e) => [
        { at: e.at, d: 1 },
        { at: takenAt.get(e.shard) ?? Infinity, d: -1 },
      ]);
      points.sort((a, b) => a.at - b.at || a.d - b.d);
      let inFlight = 0;
      let most = 0;
      for (const p of points) {
        inFlight += p.d;
        most = Math.max(most, inFlight);
      }
      expect(most).toBeLessThanOrEqual(2);
      const rounds = new Set(mine.map((e) => e.at)).size;
      expect(rounds).toBeGreaterThanOrEqual(Math.ceil(mine.length / 2));
    }
    // Every note arrived, once.
    expect([...notes].sort((a, b) => a - b)).toEqual(sent);
    expect(deadLetters(c)).toEqual([]);
  });

  it('greets a node again until it answers, so lost hellos can’t keep its shards from it', async () => {
    // Found by T8's CI run: remoting is at most once, and each region said hello to a new member
    // only once, so a node whose hellos were lost was never a candidate, and never got a shard.
    const addresses = ['node-1', 'node-2', 'node-3', 'node-4'];
    let dropHellos = false;
    const c = await createTestCluster({
      ...FAST,
      addresses,
      startAll: false,
      wrap: (_, t) => dropping(t, (frame) => dropHellos && frame.includes('shardCount')),
    });
    open.push(c);
    for (const i of [0, 1, 2]) await c.start(i);
    await c.advance(2_000);
    const types = [0, 1, 2].map((i) => init(c.node(i), { shardCount: 64 }));
    for (const id of oneIdPerShard(64)) types[0]?.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(3_000);

    // Every hello between node 4 and the others is lost, both ways.
    dropHellos = true;
    await c.start(3);
    await c.advance(1_000);
    init(c.node(3), { shardCount: 64 });
    await c.advance(3_000);
    expect(acquired(c.node(3))).toEqual([]);

    // The next ticks greet again, and the shards move, two at a time from each node.
    dropHellos = false;
    await c.advance(12_000);
    const theirs = Array.from({ length: 64 }, (_, s) => s).filter(
      (s) => desiredOwner(`counter/${String(s)}`, addresses) === 'node-4',
    );
    expect(
      acquired(c.node(3))
        .map((e) => e.shard)
        .sort((a, b) => a - b),
    ).toEqual(theirs);
  });

  it('waits for an entity’s persist in flight before it releases the lease', async () => {
    const addresses = ['node-1', 'node-2', 'node-3'];
    const c = await createTestCluster({ ...FAST, addresses, startAll: false });
    open.push(c);
    for (const i of [0, 1]) await c.start(i);
    await c.advance(2_000);
    const store = inMemoryPersistence({ clock: () => c.scheduler.now() });
    const journal = faultyJournal(store.journal);
    const persistence: Persistence = { journal };
    const initAccounts = (n: TestNode): EntityType<AccountCmd> =>
      clusterOf(n).sharding.init<AccountCmd, unknown>({
        type: 'account',
        shardCount: 16,
        entity: (id) => account(persistence, { id }),
      });
    const t = initAccounts(c.node(0));
    initAccounts(c.node(1));
    let id = '';
    for (let i = 0; id === ''; i++) {
      const candidate = `acct-${String(i)}`;
      const lease = `account/${String(shardOf(candidate, 16))}`;
      if (desiredOwner(lease, addresses) === 'node-3') id = candidate;
    }
    const shard = shardOf(id, 16);
    const lease = `account/${String(shard)}`;
    const deposit = (amount: number, timeoutMs = 5_000) =>
      t.ref(id).ask<Receipt>((replyTo) => ({ type: 'deposit', amount, replyTo }), { timeoutMs });
    expect(await ask(c, () => deposit(10))).toEqual({ ok: true, balance: 10 });
    const owner = c.nodes.find((n) => acquired(n).some((e) => e.shard === shard)) as TestNode;

    const hold = journal.holdNextAppend();
    const unhold = c.hold();
    const second = deposit(5, 30_000);
    await c.advance(200);
    expect(journal.appends).toHaveLength(2);
    await c.start(2);
    await c.advance(1_000);
    initAccounts(c.node(2));
    await c.advance(6_000);
    // Three rebalance rounds later, the shard is still where it was: its entity is persisting.
    expect(released(owner).filter((e) => e.shard === shard)).toEqual([]);
    expect((await c.store.holders(lease))[0]?.holder).toBe(
      `${owner.name}#${String(owner.remoting.self.uid)}`,
    );
    expect(acquired(c.node(2))).toEqual([]);

    hold.resolve();
    unhold();
    expect(await ask(c, () => second)).toEqual({ ok: true, balance: 15 });
    await c.advance(3_000);
    const release = released(owner).find((e) => e.shard === shard);
    expect(release?.reason).toBe('handoff');
    // The entity stopped, after its persist, before the lease went.
    const stoppedAt = owner.events.findIndex(
      (e) => e.type === 'stopped' && e.path.endsWith(`/${id}`),
    );
    expect(stoppedAt).toBeGreaterThan(-1);
    expect(stoppedAt).toBeLessThan(owner.events.indexOf(release as SystemEvent));
    expect(acquired(c.node(2)).map((e) => e.shard)).toContain(shard);
    const balance = await ask(c, () =>
      t.ref(id).ask<number>((replyTo) => ({ type: 'balance', replyTo })),
    );
    expect(balance).toBe(15);
    expect(spawns(c.node(2), 'account').map((s) => s.id)).toEqual([id]);
    const events = await store.journal.read(id, 1, 100);
    expect(events.map((e) => (e.event as { amount: number }).amount)).toEqual([10, 5]);
  });

  it('never moves a shard whose holder is unreachable, while it keeps its lease', async () => {
    const partitioned = new Set<string>();
    const c = await cluster({
      membership: { ...FAST.membership, downAfterMs: 60_000 },
      wrap: (name, t) => isolatable(t, () => partitioned.has(name)),
    });
    const types = c.nodes.map((n) => init(n));
    for (const id of oneIdPerShard(16)) types[0]?.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(2_000);
    const third = c.node(2);
    const theirs = acquired(third).map((e) => e.shard);
    expect(theirs.length).toBeGreaterThan(0);
    const before = await c.store.holders('counter/');

    partitioned.add('node-3');
    await c.advance(10_000);
    expect(
      c
        .node(0)
        .events.some((e) => e.type === 'reachability' && e.address === 'node-3' && !e.reachable),
    ).toBe(true);
    expect(released(third)).toEqual([]);
    for (const i of [0, 1]) {
      expect(acquired(c.node(i)).filter((e) => theirs.includes(e.shard) && e.token > 1)).toEqual(
        [],
      );
    }
    expect(await c.store.holders('counter/')).toEqual(before);
    partitioned.delete('node-3');
  });
});

describe('leaving', () => {
  it('hands off every shard before the node goes, and no ask to its entities times out', async () => {
    const c = await cluster();
    const types = c.nodes.map((n) => init(n));
    const ids = oneIdPerShard(16);
    for (const id of ids) types[0]?.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(1_000);
    const third = c.node(2);
    const theirs = new Set(acquired(third).map((e) => e.shard));
    expect(theirs.size).toBeGreaterThan(1);
    const targets = ids.filter((id) => theirs.has(shardOf(id, 16)));

    const results: ('ok' | 'failed')[] = [];
    let left: Promise<void> | undefined;
    for (let step = 0; step < 100; step++) {
      if (step === 10) left = clusterOf(third).leave();
      for (const id of targets) {
        types[0]
          ?.ref(id)
          .ask<Count>((replyTo) => ({ type: 'get', replyTo }), { timeoutMs: 2_000 })
          .then(
            () => results.push('ok'),
            () => results.push('failed'),
          );
      }
      await c.advance(20);
    }
    await c.advance(3_000);
    await left;
    expect(results).toHaveLength(100 * targets.length);
    expect(results.filter((r) => r === 'failed')).toEqual([]);

    const { uid } = third.remoting.self;
    const removed = third.events.find(
      (e) => e.type === 'memberRemoved' && e.address === 'node-3' && e.uid === uid,
    );
    expect(removed).toBeDefined();
    expect(released(third).map((e) => e.reason)).toEqual([...theirs].map(() => 'leaving'));
    for (const shard of theirs) {
      const taken = [0, 1].flatMap((i) => acquired(c.node(i))).find((e) => e.shard === shard);
      expect(taken, `shard ${String(shard)}`).toBeDefined();
      expect(taken?.at).toBeLessThanOrEqual(removed?.at ?? -1);
    }
    expect(deadLetters(c)).toEqual([]);
  });

  it('hands off as the system terminates, before /system stops', async () => {
    const c = await cluster();
    const types = c.nodes.map((n) => init(n));
    for (const id of oneIdPerShard(16)) types[0]?.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(1_000);
    const third = c.node(2);
    const theirs = acquired(third).map((e) => `counter/${String(e.shard)}`);
    expect(theirs.length).toBeGreaterThan(0);
    await c.terminate(2);
    expect(new Set(released(third).map((e) => e.reason))).toEqual(new Set(['leaving']));
    const holders = await c.store.holders('counter/');
    for (const lease of theirs) {
      const holder = holders.find((h) => h.lease === lease)?.holder ?? '';
      expect(holder.startsWith('node-1#') || holder.startsWith('node-2#'), lease).toBe(true);
    }
  });

  /** Accounts on every node, with one journal whose appends a test can hold. */
  async function accounts(c: TestCluster) {
    const store = inMemoryPersistence({ clock: () => c.scheduler.now() });
    const journal = faultyJournal(store.journal);
    const persistence: Persistence = { journal };
    const types = c.nodes.map((n) =>
      clusterOf(n).sharding.init<AccountCmd, unknown>({
        type: 'account',
        shardCount: 16,
        entity: (id) => account(persistence, { id }),
      }),
    );
    await c.advance(500);
    const id = idOn(c, 'account', 'node-3');
    const t = types[0] as EntityType<AccountCmd>;
    const deposit = (amount: number) =>
      t.ref(id).ask<Receipt>((replyTo) => ({ type: 'deposit', amount, replyTo }), {
        timeoutMs: 30_000,
      });
    return { journal, id, deposit };
  }

  it('keeps heartbeating while it leaves, so a handoff longer than downing isn’t cut short', async () => {
    // Found by the hunt (contract seed 1,914): a leaving node stopped heartbeating, so a handoff
    // that took longer than unreachableAfterMs plus downAfterMs got it downed halfway.
    const c = await cluster();
    const { journal, deposit } = await accounts(c);
    expect(await ask(c, () => deposit(10))).toEqual({ ok: true, balance: 10 });
    const hold = journal.holdNextAppend();
    const unhold = c.hold();
    const second = deposit(5);
    await c.advance(100);
    const third = c.node(2);
    const left = clusterOf(third).leave();
    let done = false;
    void left.then(() => (done = true));
    // Four seconds of handoff: twice what downing takes here.
    await c.advance(4_000);
    expect(done).toBe(false);
    hold.resolve();
    unhold();
    expect(await ask(c, () => second)).toEqual({ ok: true, balance: 15 });
    await ask(c, () => left);
    for (const n of [c.node(0), c.node(1)]) {
      const about = n.events.filter((e) => 'address' in e && e.address === 'node-3');
      expect(about.map((e) => e.type)).toEqual(['memberUp', 'memberLeaving', 'memberRemoved']);
    }
  });

  it('hands on a shard whose acquire is answered after the leave began', async () => {
    // Found by the hunt (contract seed 1,914): an acquire sent during a database hang came back
    // once the node was leaving, and the region waited on that shard for good.
    const holding = deferred();
    let holdAcquires = false;
    const c = await cluster({
      sharding: {
        ...FAST.sharding,
        wrapStore: (store) => ({
          ...store,
          acquire: async (lease, holder, ttlMs) => {
            const result = await store.acquire(lease, holder, ttlMs);
            if (holdAcquires && holder.startsWith('node-3#')) await holding.promise;
            return result;
          },
        }),
      },
    });
    const types = c.nodes.map((n) => init(n));
    await c.advance(500);
    const id = idOn(c, 'counter', 'node-3');
    holdAcquires = true;
    const unhold = c.hold();
    const answer = types[0]?.ref(id).ask<Count>((replyTo) => ({ type: 'get', replyTo }), {
      timeoutMs: 10_000,
    });
    answer?.catch(() => {});
    await c.advance(200);
    const left = clusterOf(c.node(2)).leave();
    await c.advance(200);
    holding.resolve();
    unhold();
    await ask(c, () => left);
    const shard = shardOf(id, 16);
    expect(
      released(c.node(2))
        .filter((e) => e.shard === shard)
        .map((e) => e.reason),
    ).toEqual(['leaving']);
    // What waited went to the shard where it was granted, and the shard went on from there.
    expect((await ask(c, () => answer as Promise<Count>)).count).toBe(0);
    const taken = [0, 1].flatMap((i) => acquired(c.node(i))).filter((e) => e.shard === shard);
    expect(taken).toHaveLength(1);
  });

  it('finishes leaving when the last shard it waits for lost its lease instead', async () => {
    // Found by the hunt (contract seed 1,914): a shard that lost its lease during a database
    // hang was still stopping when the leave began, and its stop never told the region it was
    // done.
    let failing = false;
    const c = await cluster({
      sharding: {
        ...FAST.sharding,
        wrapStore: (store) => ({
          ...store,
          renewAll: (holder, ttlMs) =>
            failing && holder.startsWith('node-3#')
              ? Promise.reject(new Error('store unreachable'))
              : store.renewAll(holder, ttlMs),
        }),
      },
    });
    const { journal, deposit } = await accounts(c);
    expect(await ask(c, () => deposit(10))).toEqual({ ok: true, balance: 10 });
    const third = c.node(2);
    const hold = journal.holdNextAppend();
    const unhold = c.hold();
    const second = deposit(5);
    failing = true;
    // Past the lease's deadline: the shard stops, but its entity is still persisting.
    await c.advance(2_000);
    expect(released(third).map((e) => e.reason)).toContain('leaseLost');
    const left = clusterOf(third).leave();
    await c.advance(500);
    hold.resolve();
    unhold();
    await ask(c, () => second.catch(() => undefined));
    let done = false;
    void left.then(() => (done = true));
    await c.advance(2_000);
    expect(done).toBe(true);
  });

  it('releases what it can’t hand off when no other node hosts the type', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const t = init(c.node(0));
    t.ref('hamlet').tell({ type: 'add', by: 1 });
    await c.advance(500);
    await c.terminate(0);
    expect(released(c.node(0)).map((e) => e.reason)).toEqual(['leaving']);
    expect(await c.store.holders('counter/')).toEqual([]);
  });
});

describe('remembering entities', () => {
  it('starts a killed node’s remembered entities on the others without a message, and forgets one that stops itself', async () => {
    const c = await cluster();
    const types = c.nodes.map((n) => init(n, { remember: true }));
    const ids = Array.from({ length: 12 }, (_, i) => `show-${String(i)}`);
    for (const id of ids) types[0]?.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(1_000);
    const third = c.node(2);
    const onThird = spawns(third).map((s) => s.id);
    expect(onThird.length).toBeGreaterThan(1);
    const [quitter = '', ...rest] = onThird;
    const quitterLease = `counter/${String(shardOf(quitter, 16))}`;
    expect(await c.store.remembered(quitterLease)).toContain(quitter);
    types[0]?.ref(quitter).tell({ type: 'quit' });
    await c.advance(500);
    expect(await c.store.remembered(quitterLease)).not.toContain(quitter);

    c.kill(2);
    const killedAt = c.scheduler.now();
    await c.advance(8_000);
    const after = [0, 1].flatMap((i) => spawns(c.node(i))).filter((s) => s.at > killedAt);
    expect(after.map((s) => s.id).sort()).toEqual([...rest].sort());
    expect(deadLetters(c)).toEqual([]);
  });

  it('starts remembered entities again where a shard is handed off to', async () => {
    const addresses = ['node-1', 'node-2'];
    const c = await createTestCluster({ ...FAST, addresses, startAll: false });
    open.push(c);
    await c.start(0);
    await c.advance(2_000);
    const t = init(c.node(0), { remember: true });
    const ids = Array.from({ length: 8 }, (_, i) => `show-${String(i)}`);
    for (const id of ids) t.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(1_000);
    await c.start(1);
    await c.advance(1_000);
    init(c.node(1), { remember: true });
    await c.advance(6_000);
    const moved = ids.filter(
      (id) => desiredOwner(`counter/${String(shardOf(id, 16))}`, addresses) === 'node-2',
    );
    expect(moved.length).toBeGreaterThan(0);
    expect(
      spawns(c.node(1))
        .map((s) => s.id)
        .sort(),
    ).toEqual(moved.sort());
  });
});

describe('remembering, when the store fails', () => {
  it('retries reading what a shard remembers, and a remember write that fails', async () => {
    let failReads = 2;
    let failWrites = 1;
    const c = await cluster({
      addresses: ['node-1'],
      sharding: {
        ...FAST.sharding,
        wrapStore: (store) => ({
          ...store,
          acquire: store.acquire.bind(store),
          renewAll: store.renewAll.bind(store),
          release: store.release.bind(store),
          holders: store.holders.bind(store),
          forget: store.forget.bind(store),
          remember: (shard, id) =>
            failWrites-- > 0 ? Promise.reject(new Error('no write')) : store.remember(shard, id),
          remembered: (shard) =>
            failReads-- > 0 ? Promise.reject(new Error('no read')) : store.remembered(shard),
        }),
      },
    });
    await c.store.remember(`counter/${String(shardOf('yorick', 16))}`, 'yorick');
    const t = init(c.node(0), { remember: true });
    // hamlet's shard has to start first: its remember fails, and is logged.
    t.ref('hamlet').tell({ type: 'add', by: 1 });
    await c.advance(3_000);
    const logs = c.node(0).logs.map((l) => l.msg);
    expect(logs).toContain('sharding: could not remember /sharding/counter/hamlet');
    expect(logs.filter((m) => m.startsWith('sharding: could not read the entities'))).toHaveLength(
      2,
    );
    // Every shard starts with remember: true, so yorick's shard came up and started yorick.
    expect(spawns(c.node(0)).map((s) => s.id)).toContain('yorick');
    expect(spawns(c.node(0)).map((s) => s.id)).toContain('hamlet');
    // And the remember that failed was tried again, so a failover would start hamlet too (T7,
    // chaos seed 120,717: a show whose remember failed wasn't started after its node was killed).
    expect(await c.store.remembered(`counter/${String(shardOf('hamlet', 16))}`)).toContain(
      'hamlet',
    );
  });
});

describe('options', () => {
  it('throws from sharding.init for passivation, remember and rebalancing it can’t use', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const sharding = clusterOf(c.node(0)).sharding;
    const entity = counter('node-1');
    const bad: Record<string, unknown>[] = [
      { passivation: 1_000 },
      { passivation: { idleMs: 0 } },
      { passivation: { idleMs: 1_000, after: 1 } },
      { remember: 'yes' },
      { remember: true, passivation: { idleMs: 1_000 } },
      { rebalanceMs: 0 },
      { maxHandoffs: 0 },
      { maxHandoffs: 1.5 },
    ];
    for (const opts of bad) {
      expect(
        () => sharding.init({ type: 'counter', entity, ...opts }),
        JSON.stringify(opts),
      ).toThrow(TypeError);
    }
    expect(() =>
      sharding.init({ type: 'counter', entity, remember: true, passivation: { idleMs: 1 } }),
    ).toThrow('can’t passivate');
  });
});

/** Wraps a transport so frames `drop` picks are never sent. */
function dropping(inner: Transport, drop: (frame: string) => boolean): Transport {
  const wrap = (c: Connection): Connection => ({
    send: (frame) => {
      if (!drop(frame)) c.send(frame);
    },
    onFrame: (listener) => {
      c.onFrame(listener);
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
