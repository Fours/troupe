import { afterEach, describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import type { EntityType } from '../../src/cluster/sharding.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import { desiredOwner, shardOf } from '../../src/cluster/placement.js';
import { ActorNameError } from '../../src/errors.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import {
  FAST,
  createTestCluster,
  type TestCluster,
  type TestClusterOptions,
  type TestNode,
} from '../helpers/cluster.js';

// Milestone 4, T6: cluster sharding, routing and placement (decision 0030). Entity refs reach the
// one entity with their id from any node, messages to entities are always encoded, and shards go
// to their desired owner by rendezvous hashing, through a lease.

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
  | { readonly type: 'get'; readonly replyTo: ActorRef<Count> };

/** A counter entity that says which node it runs on. */
function counter(node: string) {
  return (id: string) =>
    actor<CounterMsg, number>({
      initial: 0,
      receive(count, msg) {
        if (msg.type === 'add') return count + msg.by;
        msg.replyTo.tell({ id, count, node });
        return count;
      },
    });
}

function initCounters(c: TestCluster, shardCount = 16): EntityType<CounterMsg>[] {
  return c.nodes.map((n) =>
    clusterOf(n).sharding.init({ type: 'counter', entity: counter(n.name), shardCount }),
  );
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

/** Every `spawned` of an entity on every incarnation, as `node path`. */
function entitySpawns(c: TestCluster): string[] {
  return c.incarnations.flatMap((n) =>
    n.events
      .filter((e): e is Extract<SystemEvent, { type: 'spawned' }> => e.type === 'spawned')
      .filter((e) => /^\/system\/sharding\/[^/]+\/\d+\/[^/]+$/.test(e.path))
      .map((e) => `${n.name} ${e.path}`),
  );
}

describe('routing', () => {
  it('reaches the one entity with an id from every node, and ask works through it', async () => {
    const c = await cluster();
    const types = initCounters(c);
    for (const t of types) t.ref('hamlet').tell({ type: 'add', by: 1 });
    await c.advance(2_000);
    const replies: Count[] = [];
    for (const t of types) {
      replies.push(
        await ask(c, () => t.ref('hamlet').ask<Count>((replyTo) => ({ type: 'get', replyTo }))),
      );
    }
    expect(replies.map((r) => r.count)).toEqual([3, 3, 3]);
    expect(new Set(replies.map((r) => r.node)).size).toBe(1);
    expect(entitySpawns(c)).toHaveLength(1);
    expect(entitySpawns(c)[0]).toMatch(/\/system\/sharding\/counter\/\d+\/hamlet$/);
  });

  it('throws ActorNameError for an id that isn’t an actor name', async () => {
    const c = await cluster();
    const [t] = initCounters(c);
    expect(() => t?.ref('a b')).toThrow(ActorNameError);
    expect(() => t?.ref('')).toThrow(ActorNameError);
  });
});

/** The `shardAcquired` events on a node. */
function acquired(n: TestNode) {
  return n.events.filter(
    (e): e is Extract<SystemEvent, { type: 'shardAcquired' }> => e.type === 'shardAcquired',
  );
}

/** Ids whose shard's desired owner, among `addresses`, is `owner`. */
function idsOwnedBy(
  owner: string,
  addresses: readonly string[],
  shardCount: number,
  { n = 1, type = 'counter' }: { n?: number; type?: string } = {},
) {
  const ids: string[] = [];
  for (let i = 0; ids.length < n; i++) {
    const id = `show-${String(i)}`;
    if (desiredOwner(`${type}/${String(shardOf(id, shardCount))}`, addresses) === owner) {
      ids.push(id);
    }
  }
  return ids;
}

describe('placement', () => {
  it('puts every shard on its desired owner, as every node computes it', async () => {
    const c = await cluster();
    const types = initCounters(c);
    const ids = Array.from({ length: 60 }, (_, i) => `show-${String(i)}`);
    ids.forEach((id, i) => types[i % 3]?.ref(id).tell({ type: 'add', by: 1 }));
    await c.advance(3_000);
    const addresses = c.nodes.map((n) => n.address);
    const holders = c.nodes.flatMap((n) =>
      acquired(n).map((e) => ({ shard: e.shard, address: n.address })),
    );
    expect(new Set(holders.map((h) => h.shard)).size).toBe(holders.length);
    expect(holders.length).toBe(new Set(ids.map((id) => shardOf(id, 16))).size);
    for (const { shard, address } of holders) {
      expect(desiredOwner(`counter/${String(shard)}`, addresses)).toBe(address);
    }
    // Every node is some shard's owner.
    expect(new Set(holders.map((h) => h.address)).size).toBe(3);
  });

  it('places new shards on a fourth node that tops them, once it has joined', async () => {
    const c = await cluster({
      addresses: ['node-1', 'node-2', 'node-3', 'node-4'],
      startAll: false,
    });
    for (const i of [0, 1, 2]) await c.start(i);
    await c.advance(3_000);
    const fourth = await c.start(3);
    await c.advance(3_000);
    await clusterOf(fourth).whenUp;
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id] = idsOwnedBy('node-4', all, 16);
    types[0]?.ref(id ?? '').tell({ type: 'add', by: 1 });
    await c.advance(2_000);
    expect(acquired(fourth).map((e) => e.shard)).toEqual([shardOf(id ?? '', 16)]);
  });

  it('never places a shard on a node that only routes', async () => {
    const c = await cluster();
    const types = c.nodes.map((n, i) =>
      clusterOf(n).sharding.init({
        type: 'counter',
        entity: counter(n.name),
        shardCount: 16,
        host: i !== 2,
      }),
    );
    const get = (t: EntityType<CounterMsg> | undefined, id: string) =>
      ask(c, () =>
        (t as EntityType<CounterMsg>).ref(id).ask<Count>((replyTo) => ({ type: 'get', replyTo })),
      );
    // Ids that would be node 3's if it hosted, sent from a hosting node, go elsewhere.
    const all = c.nodes.map((n) => n.address);
    for (const id of idsOwnedBy('node-3', all, 16, { n: 3 })) {
      expect(['node-1', 'node-2']).toContain((await get(types[0], id)).node);
    }
    // And the crowd routes to every shard without holding one.
    const replies: Count[] = [];
    for (let i = 0; i < 30; i++) replies.push(await get(types[2], `show-${String(i)}`));
    expect(new Set(replies.map((r) => r.node))).toEqual(new Set(['node-1', 'node-2']));
    expect(acquired(c.node(2))).toEqual([]);
  });

  it('refuses a node whose shardCount differs, on both sides', async () => {
    const c = await cluster();
    const types = c.nodes.map((n, i) =>
      clusterOf(n).sharding.init({
        type: 'counter',
        entity: counter(n.name),
        shardCount: i === 2 ? 8 : 16,
      }),
    );
    await c.advance(1_000);
    for (const i of [0, 1]) {
      expect(c.node(i).logs).toContainEqual(
        expect.objectContaining({
          level: 'error',
          msg: 'sharding: refused node-3 for counter: its shardCount is 8, and this node’s is 16'.replace(
            '’',
            "'",
          ),
        }),
      );
    }
    expect(
      c.node(2).logs.filter((l) => l.level === 'error' && l.msg.startsWith('sharding: refused')),
    ).toHaveLength(2);
    const replies: Count[] = [];
    for (let i = 0; i < 20; i++) {
      replies.push(
        await ask(c, () =>
          (types[0] as EntityType<CounterMsg>)
            .ref(`show-${String(i)}`)
            .ask<Count>((replyTo) => ({ type: 'get', replyTo })),
        ),
      );
    }
    expect(replies.every((r) => r.node !== 'node-3')).toBe(true);
    expect(acquired(c.node(2))).toEqual([]);
  });
});

/** The dead letters a node published. */
function deadLetters(n: TestNode) {
  return n.events.filter(
    (e): e is Extract<SystemEvent, { type: 'deadLetter' }> => e.type === 'deadLetter',
  );
}

describe('messages to entities', () => {
  it('are encoded even on the same node: a Map is a dead letter, and nothing is shared', async () => {
    const c = await cluster();
    const received: unknown[] = [];
    const types = c.nodes.map((n) =>
      clusterOf(n).sharding.init({
        type: 'box',
        shardCount: 16,
        entity: () =>
          actor<unknown, null>({
            initial: null,
            receive: (s, msg) => {
              received.push(msg);
              return s;
            },
          }),
      }),
    );
    const all = c.nodes.map((n) => n.address);
    // An id whose shard belongs to node 1, sent from node 1.
    const [id = ''] = idsOwnedBy('node-1', all, 16, { type: 'box' });
    const local = (types[0] as EntityType<unknown>).ref(id);
    const payload = { seats: [1, 2], note: 'aisle' };
    local.tell(payload);
    await c.advance(1_000);
    expect(acquired(c.node(0)).map((e) => e.shard)).toEqual([shardOf(id, 16)]);
    expect(received).toEqual([payload]);
    expect(received[0]).not.toBe(payload);
    local.tell({ seats: new Map([[1, 'a']]) });
    await c.advance(1_000);
    expect(received).toHaveLength(1);
    expect(deadLetters(c.node(0)).at(-1)).toMatchObject({
      recipient: `/sharding/box/${id}`,
      reason: 'unserializable',
    });
    expect(c.node(0).logs.at(-1)?.msg).toMatch(
      /can.t be sent: \$\.seats is not a plain object \(Map\)/,
    );
  });

  it('is a dead letter past maxFrameBytes, on the same node too', async () => {
    const c = await cluster({ membership: { ...FAST.membership, maxFrameBytes: 1_000 } });
    const [t] = initCounters(c);
    t?.ref('hamlet').tell({ type: 'add', by: 1, padding: 'x'.repeat(2_000) } as never);
    expect(deadLetters(c.node(0)).at(-1)).toMatchObject({ reason: 'unserializable' });
  });

  it('can’t watch an entity ref: ctx.watch throws a TypeError', async () => {
    const c = await cluster();
    const [t] = initCounters(c);
    const errors: unknown[] = [];
    c.node(0).system.spawn(
      actor<null, null>({
        initial: (ctx) => {
          try {
            ctx.watch(t?.ref('hamlet') as ActorRef<never>);
          } catch (error) {
            errors.push(error);
          }
          return null;
        },
        receive: (s) => s,
      }),
    );
    await c.settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
  });

  it('checks the type’s schema after decoding, sync or async: a failure is invalid', async () => {
    for (const async of [false, true]) {
      const c = await cluster();
      // Adds must have a numeric `by`, which the schema's output multiplies by ten.
      const check = (value: unknown) => {
        const { type, by } = value as { type?: unknown; by?: unknown };
        if (type !== 'add') return { value };
        if (by === 'boom') throw new Error('the schema broke');
        return typeof by === 'number'
          ? { value: { ...(value as object), by: by * 10 } }
          : { issues: [{ message: 'by must be a number', path: ['by'] }] };
      };
      const schema = {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: (value: unknown) =>
            async ? Promise.resolve().then(() => check(value)) : check(value),
        },
      };
      const types = c.nodes.map((n) =>
        clusterOf(n).sharding.init<CounterMsg, number>({
          type: 'counter',
          shardCount: 16,
          entity: counter(n.name),
          schema: schema as never,
        }),
      );
      const ref = (types[1] as EntityType<CounterMsg>).ref('hamlet');
      ref.tell({ type: 'add', by: 2 });
      ref.tell({ type: 'add', by: 'lots' } as never);
      ref.tell({ type: 'add', by: 'boom' } as never);
      const count = await ask(c, () => ref.ask<Count>((replyTo) => ({ type: 'get', replyTo })));
      // The schema's output is what arrives: 2 became 20.
      expect(count.count).toBe(20);
      const owner = c.nodes.find((n) => acquired(n).length > 0) as TestNode;
      expect(deadLetters(owner).map((d) => d.reason)).toEqual(['invalid', 'invalid']);
      expect(owner.logs).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({
            issues: [{ message: 'the schema threw: Error: the schema broke' }],
          }) as unknown,
        }),
      );
      expect(owner.logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          msg: 'sharding: a message to /sharding/counter/hamlet failed its schema',
          fields: expect.objectContaining({
            issues: [{ message: 'by must be a number', path: ['by'] }],
          }) as unknown,
        }),
      );
      await c.shutdown();
      open.splice(open.indexOf(c), 1);
    }
  });
});

type RelayMsg =
  | { readonly type: 'set'; readonly target: ActorRef<CounterMsg> }
  | { readonly type: 'get'; readonly replyTo: ActorRef<Count> };

/** Keeps an entity ref it was sent, and passes gets on to it. */
const relay = actor<RelayMsg, ActorRef<CounterMsg> | null>({
  initial: null,
  receive(target, msg) {
    if (msg.type === 'set') return msg.target;
    target?.tell(msg);
    return target;
  },
});

describe('entity refs', () => {
  it('travel in messages, and still reach their entity after its shard moves', async () => {
    const c = await cluster();
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id = ''] = idsOwnedBy('node-3', all, 16);
    const local = c.node(0).system.spawn(relay, 'relay');
    const remote = c
      .node(1)
      .remoting.ref(c.node(0).remoting.codec.uri(local.path)) as unknown as ActorRef<RelayMsg>;
    // Node 2 sends node 1 a ref to the entity: it arrives as node 1's own entity ref.
    remote.tell({ type: 'set', target: (types[1] as EntityType<CounterMsg>).ref(id) });
    await c.advance(100);
    const before = await ask(c, () => local.ask<Count>((replyTo) => ({ type: 'get', replyTo })));
    expect(before).toMatchObject({ id, node: 'node-3' });

    c.kill(2);
    await c.advance(8_000);
    const after = await ask(c, () => local.ask<Count>((replyTo) => ({ type: 'get', replyTo })));
    expect(after.id).toBe(id);
    expect(['node-1', 'node-2']).toContain(after.node);
    // The new owner took the lease once it expired, with the next token.
    const taken = c.nodes
      .slice(0, 2)
      .flatMap(acquired)
      .find((e) => e.shard === shardOf(id, 16));
    expect(taken?.token).toBe(2);
  });

  it('decode on a node that hasn’t initialised the type, and their tells are unreachable', async () => {
    const c = await cluster();
    const [first] = c.nodes.map((n, i) =>
      i === 0
        ? clusterOf(n).sharding.init({ type: 'counter', entity: counter(n.name) })
        : undefined,
    );
    const local = c.node(1).system.spawn(relay, 'relay');
    const remote = c
      .node(0)
      .remoting.ref(c.node(1).remoting.codec.uri(local.path)) as unknown as ActorRef<RelayMsg>;
    remote.tell({ type: 'set', target: (first as EntityType<CounterMsg>).ref('hamlet') });
    await c.advance(100);
    local.tell({ type: 'get', replyTo: local as never });
    await c.advance(100);
    expect(deadLetters(c.node(1)).at(-1)).toMatchObject({
      recipient: '/sharding/counter/hamlet',
      reason: 'unreachable',
    });
  });
});

/** The `shardReleased` events on a node, as `shard reason`. */
function released(n: TestNode): string[] {
  return n.events.flatMap((e) =>
    e.type === 'shardReleased' ? [`${String(e.shard)} ${e.reason}`] : [],
  );
}

/** Whether the entity at `id` is running on `n` now, by its spawned and stopped events. */
function running(n: TestNode, id: string): boolean {
  let live = false;
  for (const e of n.events) {
    if ((e.type === 'spawned' || e.type === 'stopped') && e.path.endsWith(`/${id}`)) {
      live = e.type === 'spawned';
    }
  }
  return live;
}

describe('ownership', () => {
  it('stops a shard at its deadline when its node loses the store, and starts nowhere else', async () => {
    const c = await cluster();
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id = ''] = idsOwnedBy('node-3', all, 16);
    const shard = shardOf(id, 16);
    const first = types[0] as EntityType<CounterMsg>;
    first.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(500);
    expect(running(c.node(2), id)).toBe(true);

    // Node 3 can't renew: it lets go at its deadline, before the store would give the lease away.
    c.node(2).setReachesStore(false);
    await c.advance(1_600);
    expect(released(c.node(2))).toEqual([`${String(shard)} leaseLost`]);
    expect(running(c.node(2), id)).toBe(false);

    // Node 1 still thinks node 3 has it, and is sent back. Node 3 is still the desired owner, and
    // can't acquire, so the entity is unavailable: never started twice.
    const reply = first.ref(id).ask<Count>((replyTo) => ({ type: 'get', replyTo }), {
      timeoutMs: 30_000,
    });
    await c.advance(10_000);
    for (const n of c.nodes) expect(running(n, id), n.name).toBe(false);
    expect(
      acquired(c.node(0))
        .concat(acquired(c.node(1)))
        .map((e) => e.shard),
    ).not.toContain(shard);
    expect(
      c.node(2).logs.some((l) => l.msg === `sharding: could not acquire counter/${String(shard)}`),
    ).toBe(true);

    // Back on the store, node 3 takes the lease again, and what waited arrives.
    c.node(2).setReachesStore(true);
    const answered = await ask(c, () => reply, 10_000);
    expect(answered).toMatchObject({ id, node: 'node-3', count: 0 });
  });

  it('hands its shards off as a node leaves, so others take them without waiting', async () => {
    const c = await cluster();
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id = ''] = idsOwnedBy('node-3', all, 16);
    const shard = shardOf(id, 16);
    (types[0] as EntityType<CounterMsg>).ref(id).tell({ type: 'add', by: 1 });
    await c.advance(500);
    const left = clusterOf(c.node(2)).leave();
    await c.advance(10);
    await left;
    await c.advance(10);
    expect(released(c.node(2))).toEqual([`${String(shard)} leaving`]);
    // Handed off (T7): another node took the lease before this one left.
    const holders = await c.store.holders(`counter/${String(shard)}`);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.holder.startsWith('node-3#')).toBe(false);
    const at = c.scheduler.now();
    const reply = await ask(c, () =>
      (types[0] as EntityType<CounterMsg>)
        .ref(id)
        .ask<Count>((replyTo) => ({ type: 'get', replyTo })),
    );
    expect(['node-1', 'node-2']).toContain(reply.node);
    // Well inside the lease's 2 s: it was released, not left to expire.
    expect(c.scheduler.now() - at).toBeLessThan(1_000);
  });

  it('routes around a holder it can’t reach, so failover waits for the lease, not downing', async () => {
    // Found by T8 on real processes: regions routed to any holder that wasn't down, so a killed
    // node's entities waited for it to be downed, and failover took unreachable plus down.
    const c = await cluster({
      membership: { ...FAST.membership, downAfterMs: 60_000 },
    });
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id = ''] = idsOwnedBy('node-3', all, 16);
    const first = types[0] as EntityType<CounterMsg>;
    first.ref(id).tell({ type: 'add', by: 1 });
    await c.advance(500);
    expect(running(c.node(2), id)).toBe(true);

    c.kill(2);
    const killedAt = c.scheduler.now();
    let reply: Count | undefined;
    while (reply === undefined && c.scheduler.now() - killedAt < 20_000) {
      try {
        reply = await ask(c, () =>
          first.ref(id).ask<Count>((replyTo) => ({ type: 'get', replyTo }), { timeoutMs: 500 }),
        );
      } catch {
        // Lost on its way to the dead node, or still waiting for a home: ask again.
      }
    }
    expect(reply?.id).toBe(id);
    expect(['node-1', 'node-2']).toContain(reply?.node);
    // The lease (2 s TTL, last renewed at most 500 ms before the kill) and a backoff, well before
    // node 3 could be downed, 61 s after it went quiet.
    expect(c.scheduler.now() - killedAt).toBeLessThan(5_000);
    expect(c.node(0).events.some((e) => e.type === 'memberDown')).toBe(false);
  });

  it('releases its shards as downed when a node learns it’s down', async () => {
    let muted = false;
    const c = await cluster({
      wrap: (name, t) => (name === 'node-3' ? dropping(t, (f) => muted && f === '{"t":"hb"}') : t),
    });
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id = ''] = idsOwnedBy('node-3', all, 16);
    (types[0] as EntityType<CounterMsg>).ref(id).tell({ type: 'add', by: 1 });
    await c.advance(500);
    muted = true;
    await c.advance(5_000);
    expect(released(c.node(2))).toEqual([`${String(shardOf(id, 16))} downed`]);
    expect(running(c.node(2), id)).toBe(false);
  });

  it('holds at most bufferSize messages per shard while it has no home', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const crowd = clusterOf(c.node(0)).sharding.init({
      type: 'counter',
      entity: counter('node-1'),
      host: false,
      bufferSize: 2,
    });
    for (let i = 0; i < 5; i++) crowd.ref('hamlet').tell({ type: 'add', by: i });
    await c.advance(1_000);
    expect(deadLetters(c.node(0)).map((d) => [d.recipient, d.reason, d.message])).toEqual([
      ['/sharding/counter/hamlet', 'unreachable', { type: 'add', by: 2 }],
      ['/sharding/counter/hamlet', 'unreachable', { type: 'add', by: 3 }],
      ['/sharding/counter/hamlet', 'unreachable', { type: 'add', by: 4 }],
    ]);
    // Terminating stops the region, and what waited is a stopped dead letter.
    await c.terminate(0);
    expect(
      deadLetters(c.node(0))
        .slice(3)
        .map((d) => [d.recipient, d.reason]),
    ).toEqual([
      ['/sharding/counter/hamlet', 'stopped'],
      ['/sharding/counter/hamlet', 'stopped'],
    ]);
  });
});

describe('what regions refuse', () => {
  it('ignores malformed messages from other nodes, with a warning, and never fails', async () => {
    const c = await cluster();
    const types = initCounters(c);
    const all = c.nodes.map((n) => n.address);
    const [id = ''] = idsOwnedBy('node-2', all, 16);
    (types[0] as EntityType<CounterMsg>).ref(id).tell({ type: 'add', by: 1 });
    await c.advance(500);
    const region = c
      .node(0)
      .remoting.ref(
        c.node(1).remoting.codec.uri('/system/sharding/counter'),
      ) as unknown as ActorRef<unknown>;
    const back = c.node(0).system.spawn(relay, 'back');
    for (const msg of [
      'hello',
      { t: 'what' },
      { t: 'deliver', id: 1, m: '{}' },
      { t: 'deliver', id, m: '{}', back: 'nope' },
      { t: 'start', shard: 99, back },
      { t: 'home', shard: 1, holder: 7 },
      { t: 'notOwner', shard: 1 },
      { t: 'hello', shardCount: 16 },
      // Text the codec can't read reaches the shard, which says so.
      { t: 'deliver', id, m: '{"a":', back },
    ]) {
      region.tell(msg);
    }
    await c.advance(500);
    const ignored = c.node(1).logs.filter((l) => l.msg.startsWith('sharding: counter ignored'));
    expect(ignored.map((l) => l.msg)).toEqual([
      'sharding: counter ignored a message that isn’t an object',
      'sharding: counter ignored a "what" message',
      'sharding: counter ignored a malformed deliver',
      'sharding: counter ignored a deliver whose back isn’t a ref',
      'sharding: counter ignored a malformed start',
      'sharding: counter ignored a malformed home',
      'sharding: counter ignored a malformed notOwner',
      'sharding: counter ignored a malformed hello',
    ]);
    expect(deadLetters(c.node(1)).at(-1)).toMatchObject({
      recipient: `/sharding/counter/${id}`,
      reason: 'unserializable',
    });
    expect(c.node(1).events.filter((e) => e.type === 'failed')).toEqual([]);
  });

  it('dead-letters a message whose entity can’t be made, and the shard carries on', async () => {
    const c = await cluster();
    const types = c.nodes.map((n) =>
      clusterOf(n).sharding.init({
        type: 'counter',
        shardCount: 16,
        entity: (id) => {
          if (id === 'cursed') throw new Error('no such show');
          return counter(n.name)(id);
        },
      }),
    );
    const t = types[0] as EntityType<CounterMsg>;
    t.ref('cursed').tell({ type: 'add', by: 1 });
    const reply = await ask(c, () =>
      t.ref('hamlet').ask<Count>((replyTo) => ({ type: 'get', replyTo })),
    );
    expect(reply.id).toBe('hamlet');
    const owner = c.nodes.find((n) =>
      n.logs.some((l) => l.msg.includes('could not start counter "cursed"')),
    );
    expect(owner).toBeDefined();
    expect(deadLetters(owner as TestNode).at(-1)).toMatchObject({
      recipient: '/sharding/counter/cursed',
      reason: 'stopped',
    });
  });
});

/** Wraps a transport so a frame `drop` picks is lost, on its way out. */
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

describe('options', () => {
  it('throw from sharding.init when they can’t be used, unknown ones included', async () => {
    const c = await cluster({ addresses: ['node-1'] });
    const sharding = clusterOf(c.node(0)).sharding;
    const entity = counter('node-1');
    const bad: [unknown, RegExp][] = [
      [{ type: 'counter', entity, extra: 1 }, /unknown option "extra"/],
      [{ type: 'a b', entity }, /type must be an actor name/],
      [{ type: 'counter', entity: 'no' }, /entity must be a function/],
      [{ type: 'counter', entity, shardCount: 0 }, /shardCount must be a positive integer/],
      [{ type: 'counter', entity, shardCount: 70_000 }, /shardCount must be at most 65536/],
      [{ type: 'counter', entity, supervision: 'restart' }, /supervision/],
      [{ type: 'counter', entity, host: 'yes' }, /host must be a boolean/],
      [{ type: 'counter', entity, schema: {} }, /schema must be a Standard Schema/],
      [{ type: 'counter', entity, bufferSize: 0 }, /bufferSize must be a positive integer/],
    ];
    for (const [opts, message] of bad) {
      expect(() => sharding.init(opts as never), String(message)).toThrow(TypeError);
      expect(() => sharding.init(opts as never)).toThrow(message);
    }
    sharding.init({ type: 'counter', entity });
    expect(() => sharding.init({ type: 'counter', entity })).toThrow(
      'sharding.init: "counter" is already initialised',
    );
  });

  it('need a shard store, and check joinCluster’s shards and leases', async () => {
    const c = await createTestCluster({ addresses: ['node-1'], membership: {} });
    open.push(c);
    expect(() =>
      clusterOf(c.node(0)).sharding.init({ type: 'counter', entity: counter('x') }),
    ).toThrow(/the cluster has no shard store/);
    const { joinCluster, inMemoryNetwork } = await import('../../src/cluster/index.js');
    const { createActorSystem } = await import('../../src/system.js');
    const base = {
      name: 'test',
      transport: inMemoryNetwork({ scheduler: c.scheduler }).transport('x'),
      seeds: ['x'],
    };
    const bad: [unknown, RegExp][] = [
      [{ ...base, shards: {} }, /shards must be a ShardStore/],
      [{ ...base, shards: c.store, leases: { ttl: 1 } }, /unknown option "ttl"/],
      [{ ...base, shards: c.store, leases: { ttlMs: 0 } }, /ttlMs must be a positive integer/],
      [{ ...base, shards: c.store, leases: { renewMs: 0 } }, /renewMs must be a positive integer/],
      [{ ...base, shards: c.store, leases: { marginMs: -1 } }, /marginMs must be a non-negative/],
      [
        { ...base, shards: c.store, leases: { ttlMs: 1_000, renewMs: 900 } },
        /renewMs must be less than/,
      ],
    ];
    for (const [opts, message] of bad) {
      expect(() =>
        joinCluster(createActorSystem({ scheduler: c.scheduler }), opts as never),
      ).toThrow(message);
    }
  });
});
