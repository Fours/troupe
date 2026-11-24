import { afterEach, describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { desiredOwner, shardOf } from '../../src/cluster/placement.js';
import type { EntityType } from '../../src/cluster/sharding.js';
import type { ShardStore } from '../../src/cluster/shard-store.js';
import { timedStore } from '../../src/cluster/timed-store.js';
import { AskTimeoutError } from '../../src/errors.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { account, type AccountCmd, type Receipt } from '../helpers/account.js';
import {
  FAST,
  createTestCluster,
  type TestCluster,
  type TestClusterOptions,
  type TestNode,
} from '../helpers/cluster.js';
import { faultyJournal } from '../helpers/faulty-journal.js';

// Milestone 5, T4 (decision 0036): every shard store call the cluster makes times out after
// `storeTimeoutMs`, which is `renewMs` by default, and a persistent entity's journal calls after
// its `timeoutMs`, so a hung store or journal can't hold a shard, or a handoff, for good.

const NEVER = new Promise<never>(() => {});

const open: TestCluster[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.shutdown()));
});

function clusterOf(n: TestNode) {
  const c = n.cluster;
  if (c === undefined) throw new Error(`${n.name} has no cluster`);
  return c;
}

type Released = Extract<SystemEvent, { type: 'shardReleased' }>;
type Acquired = Extract<SystemEvent, { type: 'shardAcquired' }>;
const released = (n: TestNode) => n.events.filter((e): e is Released => e.type === 'shardReleased');
const acquired = (n: TestNode) => n.events.filter((e): e is Acquired => e.type === 'shardAcquired');

type Get = { readonly type: 'get'; readonly replyTo: ActorRef<string> };
const where = (node: string) => () =>
  actor<Get, null>({
    initial: null,
    receive(s, msg) {
      msg.replyTo.tell(node);
      return s;
    },
  });

/** Asks, moving virtual time on until the reply comes. */
async function ask<R>(c: TestCluster, run: () => Promise<R>, ms = 10_000): Promise<R> {
  const promise = run();
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  for (let waited = 0; !state.settled && waited < ms; waited += 50) await c.advance(50);
  return promise;
}

/**
 * A store whose calls hang, never answering, while `hang` says so for the method and the
 * holder, with each call's method and time recorded.
 */
function hangable(now: () => number) {
  const calls: { method: string; holder: string | undefined; at: number }[] = [];
  let hang: (method: string, holder: string | undefined) => boolean = () => false;
  const wrap = (inner: ShardStore): ShardStore => {
    const call =
      <A extends unknown[], R>(
        method: string,
        holderAt: number | undefined,
        fn: (...a: A) => Promise<R>,
      ) =>
      (...args: A): Promise<R> => {
        const holder = holderAt === undefined ? undefined : (args[holderAt] as string);
        calls.push({ method, holder, at: now() });
        return hang(method, holder) ? NEVER : fn(...args);
      };
    return {
      acquire: call('acquire', 1, (l: string, h: string, t: number) => inner.acquire(l, h, t)),
      renewAll: call('renewAll', 0, (h: string, t: number) => inner.renewAll(h, t)),
      release: call('release', 1, (l: string, h: string, t: number) => inner.release(l, h, t)),
      holders: call('holders', undefined, (p: string) => inner.holders(p)),
      remember: call('remember', undefined, (s: string, id: string) => inner.remember(s, id)),
      forget: call('forget', undefined, (s: string, id: string) => inner.forget(s, id)),
      remembered: call('remembered', undefined, (s: string) => inner.remembered(s)),
    };
  };
  return {
    calls,
    wrap,
    hangWhen(rule: (method: string, holder: string | undefined) => boolean) {
      hang = rule;
    },
  };
}

async function cluster(
  wrapStore: (s: ShardStore) => ShardStore,
  opts: TestClusterOptions = {},
): Promise<TestCluster> {
  const c = await createTestCluster({
    ...FAST,
    sharding: { leases: FAST.sharding?.leases ?? {}, wrapStore },
    // Through Rehearsal's run loop, so time moves on while a region awaits a hung call.
    clocks: { driftPpm: 0 },
    ...opts,
  });
  open.push(c);
  await c.advance(2_000);
  for (const n of c.nodes) await clusterOf(n).whenUp;
  return c;
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const holderOf = (n: TestNode) => `${n.name}#${String(n.remoting.self.uid)}`;
const init = (n: TestNode): EntityType<Get> =>
  clusterOf(n).sharding.init<Get, null>({ type: 'where', entity: where(n.name), shardCount: 4 });

describe('the timed shard store', () => {
  const methods = [
    ['acquire', (s: ShardStore) => s.acquire('t/1', 'n#1', 1_000)],
    ['renewAll', (s: ShardStore) => s.renewAll('n#1', 1_000)],
    ['release', (s: ShardStore) => s.release('t/1', 'n#1', 1)],
    ['holders', (s: ShardStore) => s.holders('t')],
    ['remember', (s: ShardStore) => s.remember('t/1', 'a')],
    ['forget', (s: ShardStore) => s.forget('t/1', 'a')],
    ['remembered', (s: ShardStore) => s.remembered('t/1')],
  ] as const;
  const hung: ShardStore = {
    acquire: () => NEVER,
    renewAll: () => NEVER,
    release: () => NEVER,
    holders: () => NEVER,
    remember: () => NEVER,
    forget: () => NEVER,
    remembered: () => NEVER,
  };

  it.each(methods)('fails a hung %s after the timeout, on the scheduler', async (method, run) => {
    const sim = new ManualScheduler();
    const store = timedStore(hung, 500, (task, ms) => sim.setTimer(task, ms));
    let outcome: unknown = 'pending';
    run(store).then(
      () => (outcome = 'answered'),
      (error: unknown) => (outcome = error),
    );
    sim.advanceTo(499);
    await Promise.resolve();
    expect(outcome).toBe('pending');
    sim.advanceTo(500);
    await Promise.resolve();
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(`shard store: ${method} did not answer within 500 ms`);
  });

  it('passes answers and failures through, and cancels the timer', async () => {
    const sim = new ManualScheduler();
    const inner: ShardStore = {
      ...hung,
      holders: () => Promise.resolve([{ lease: 't/1', holder: 'n#1' }]),
      remembered: () => Promise.reject(new Error('refused')),
    };
    const store = timedStore(inner, 500, (task, ms) => sim.setTimer(task, ms));
    expect(await store.holders('t')).toEqual([{ lease: 't/1', holder: 'n#1' }]);
    await expect(store.remembered('t/1')).rejects.toThrow('refused');
    expect(sim.nextTimerAt()).toBeUndefined();
  });

  it('drops an answer that comes after the timeout', async () => {
    const sim = new ManualScheduler();
    let answer: (holders: []) => void = () => {};
    const inner: ShardStore = {
      ...hung,
      holders: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    };
    const store = timedStore(inner, 500, (task, ms) => sim.setTimer(task, ms));
    const result = store.holders('t');
    sim.advanceTo(500);
    answer([]);
    await expect(result).rejects.toThrow('did not answer');
  });
});

describe('shard store timeouts in a cluster', () => {
  it('defaults storeTimeoutMs to renewMs, and retries a hung acquire after it', async () => {
    const late: { c?: TestCluster } = {};
    const store = hangable(() => late.c?.scheduler.now() ?? 0);
    const c = (late.c = await cluster(store.wrap, { addresses: ['node-1'] }));
    const n = c.node(0);
    store.hangWhen(
      (method) =>
        method === 'acquire' && store.calls.filter((x) => x.method === 'acquire').length === 1,
    );
    const t = init(n);
    const reply = await ask(c, () =>
      t.ref('a').ask<string>((replyTo) => ({ type: 'get', replyTo }), { timeoutMs: 10_000 }),
    );
    expect(reply).toBe('node-1');
    const acquires = store.calls.filter((x) => x.method === 'acquire');
    expect(acquires.length).toBeGreaterThanOrEqual(2);
    const first = acquires[0]?.at ?? 0;
    // FAST's renewMs is 500, so the hung one gave up then, and the region backed off after it.
    expect((acquires[1]?.at ?? 0) - first).toBeGreaterThanOrEqual(500);
    const warning = n.logs.find((l) => l.msg.startsWith('sharding: could not acquire'));
    expect((warning?.fields?.error as Error).message).toBe(
      'shard store: acquire did not answer within 500 ms',
    );
  });

  it('times a hung renewal out, and still stops the shard at the holder’s deadline', async () => {
    const late: { c?: TestCluster } = {};
    const store = hangable(() => late.c?.scheduler.now() ?? 0);
    const c = (late.c = await cluster(store.wrap, { addresses: ['node-1', 'node-2'] }));
    const [one, two] = [c.node(0), c.node(1)];
    const types = [init(one), init(two)];
    // An id whose shard node-1 should own.
    let id = '';
    for (let i = 0; id === ''; i++) {
      const lease = `where/${String(shardOf(`e-${String(i)}`, 4))}`;
      if (desiredOwner(lease, ['node-1', 'node-2']) === 'node-1') id = `e-${String(i)}`;
    }
    const shard = shardOf(id, 4);
    const get = () =>
      types[1]?.ref(id).ask<string>((replyTo) => ({ type: 'get', replyTo })) ?? NEVER;
    expect(await ask(c, get)).toBe('node-1');

    const holder = holderOf(one);
    const hungAt = c.scheduler.now();
    store.hangWhen((method, h) => h === holder && (method === 'renewAll' || method === 'acquire'));
    await c.advance(3_000);
    const lost = released(one).find((e) => e.shard === shard);
    expect(lost?.reason).toBe('leaseLost');
    const lostAt = one.times[one.events.indexOf(lost as SystemEvent)] ?? 0;
    // The last renewal that answered was noted at most renewMs before the hang, so the deadline,
    // ttlMs - marginMs after it, falls in this window.
    expect(lostAt).toBeGreaterThan(hungAt + 1_500 - 500);
    expect(lostAt).toBeLessThanOrEqual(hungAt + 1_500);
    // A renewal went out every tick until then, and none has since: the lease is gone.
    const renewals = store.calls.filter(
      (x) => x.method === 'renewAll' && x.holder === holder && x.at > hungAt,
    );
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    expect(renewals.every((x) => x.at <= lostAt)).toBe(true);

    // Once the store answers again, the shard's desired owner takes it back.
    store.hangWhen(() => false);
    expect(await ask(c, get)).toBe('node-1');
    expect(acquired(one).filter((e) => e.shard === shard)).toHaveLength(2);
  });

  it('lets a handoff go on when its release hangs', async () => {
    const late: { c?: TestCluster } = {};
    const store = hangable(() => late.c?.scheduler.now() ?? 0);
    const c = (late.c = await cluster(store.wrap, { addresses: ['node-1', 'node-2'] }));
    const [one, two] = [c.node(0), c.node(1)];
    const t = init(one);
    init(two);
    for (const id of IDS) {
      void t
        .ref(id)
        .ask<string>((replyTo) => ({ type: 'get', replyTo }))
        .catch(() => {});
    }
    await c.advance(2_000);
    const theirs = acquired(two).map((e) => e.shard);
    expect(theirs.length).toBeGreaterThan(0);

    const holder = holderOf(two);
    store.hangWhen((method, h) => method === 'release' && h === holder);
    const leaving = clusterOf(two).leave();
    const left = { done: false };
    void leaving.then(() => (left.done = true));
    for (let waited = 0; !left.done && waited < 5_000; waited += 50) await c.advance(50);
    expect(left.done).toBe(true);
    expect(store.calls.filter((x) => x.method === 'release' && x.holder === holder)).not.toEqual(
      [],
    );
    // The leases weren't given up, so node-1 takes the shards once they expire in the store.
    for (const id of IDS) {
      expect(
        await ask(c, () =>
          t.ref(id).ask<string>((replyTo) => ({ type: 'get', replyTo }), { timeoutMs: 10_000 }),
        ),
      ).toBe('node-1');
    }
    for (const shard of theirs) expect(acquired(one).map((e) => e.shard)).toContain(shard);
  });
});

describe('a handoff whose entity’s append hangs', () => {
  it('finishes within the entity’s timeoutMs, rather than waiting on the journal', async () => {
    const addresses = ['node-1', 'node-2', 'node-3'];
    const c = await createTestCluster({ ...FAST, addresses, startAll: false });
    open.push(c);
    for (const i of [0, 1]) await c.start(i);
    await c.advance(2_000);
    const store = inMemoryPersistence({ clock: () => c.scheduler.now() });
    const journal = faultyJournal(store.journal);
    const TIMEOUT = 2_000;
    const initAccounts = (n: TestNode): EntityType<AccountCmd> =>
      clusterOf(n).sharding.init<AccountCmd, unknown>({
        type: 'account',
        shardCount: 16,
        entity: (id) => account({ journal }, { id, timeoutMs: TIMEOUT }),
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
    const deposit = (amount: number, timeoutMs = 5_000) =>
      t.ref(id).ask<Receipt>((replyTo) => ({ type: 'deposit', amount, replyTo }), { timeoutMs });
    expect(await ask(c, () => deposit(10))).toEqual({ ok: true, balance: 10 });
    const owner = c.nodes.find((n) => acquired(n).some((e) => e.shard === shard)) as TestNode;

    // Held for good: without a timeout, the entity, and so the handoff, would wait forever.
    journal.holdNextAppend();
    const unhold = c.hold();
    const appendedAt = c.scheduler.now();
    const second = deposit(5, 30_000);
    let outcome: unknown;
    second.then(
      (r) => (outcome = r),
      (e: unknown) => (outcome = e),
    );
    await c.advance(200);
    expect(journal.appends).toHaveLength(2);
    await c.start(2);
    await c.advance(1_000);
    initAccounts(c.node(2));
    await c.advance(TIMEOUT);
    unhold();
    await c.advance(1_000);

    const release = released(owner).find((e) => e.shard === shard);
    expect(release?.reason).toBe('handoff');
    const releasedAt = owner.times[owner.events.indexOf(release as SystemEvent)] ?? Infinity;
    expect(releasedAt).toBeLessThanOrEqual(appendedAt + TIMEOUT + 1_000);
    expect(acquired(c.node(2)).map((e) => e.shard)).toContain(shard);

    // The write's outcome is unknown, so it got no reply, and the new owner recovered without it.
    const balance = await ask(c, () =>
      t.ref(id).ask<number>((replyTo) => ({ type: 'balance', replyTo })),
    );
    expect(balance).toBe(10);
    await ask(c, () => second.catch(() => undefined), 30_000);
    expect(outcome).toBeInstanceOf(AskTimeoutError);
  });
});
