import { describe, expect, it } from 'vitest';
import { inMemoryShardStore, type ShardStore } from '@kylewillett/troupe/cluster';
import { leaseKeeper, type LeaseKeeperOptions } from '../../src/cluster/leases.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { deferred, type Deferred } from '../helpers/deferred.js';

// Milestone 4, T5: the holder's side of a lease (decision 0029). The holder notes its own time
// before it sends a renewal, and stops treating the lease as its own at that time plus ttlMs
// minus marginMs, whether or not the store answers. The store, on its own clock, gives the lease
// away only at ttlMs, so the holder always lets go first. The two clocks are never compared, so
// the store's can read anything.

const TTL = 10_000;
const RENEW = 3_000;
const MARGIN = 2_000;

type Mode = 'ok' | 'reject' | 'hang' | 'held';

/**
 * A node's keeper on one ManualScheduler, with the store's clock `offsetMs` from the node's, and
 * the store's renewals controlled by `mode`: answered, rejected, never answered, or answered
 * when the test releases them. A held renewal reaches the store at once: only the reply waits.
 */
function setup(offsetMs = 0, extra: Partial<LeaseKeeperOptions> = {}) {
  const scheduler = new ManualScheduler();
  const store = inMemoryShardStore({ clock: () => scheduler.now() + offsetMs });
  const lost: [string, number][] = [];
  const held: Deferred<void>[] = [];
  let mode: Mode = 'ok';
  let renewals = 0;
  const faulty: ShardStore = {
    ...store,
    async renewAll(holder, ttlMs) {
      renewals += 1;
      if (mode === 'reject') throw new Error('store unreachable');
      if (mode === 'hang') return new Promise<never>(() => {});
      const result = store.renewAll(holder, ttlMs);
      if (mode === 'held') {
        const reply = deferred();
        held.push(reply);
        await reply.promise;
      }
      return result;
    },
  };
  const keeper = leaseKeeper({
    store: faulty,
    holder: 'a#1',
    scheduler,
    ttlMs: TTL,
    renewMs: RENEW,
    marginMs: MARGIN,
    onLost: (lease, token) => {
      lost.push([lease, token]);
    },
    ...extra,
  });

  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** Moves virtual time to `time`, letting each timer's promises settle before the next. */
  const advanceTo = async (time: number) => {
    await drain();
    for (;;) {
      const next = scheduler.nextTimerAt();
      if (next === undefined || next > time) break;
      scheduler.advanceTo(next);
      await drain();
    }
    scheduler.advanceTo(time);
    await drain();
  };

  return {
    scheduler,
    store,
    keeper,
    lost,
    held,
    advanceTo,
    setMode(next: Mode) {
      mode = next;
    },
    renewals: () => renewals,
  };
}

describe('leaseKeeper', () => {
  it('keeps a lease for as long as renewals get through', async () => {
    const t = setup();
    await t.advanceTo(10_000);
    // Nothing held, nothing to renew.
    expect(t.renewals()).toBe(0);
    expect(await t.keeper.acquire('show/1')).toEqual({ acquired: true, token: 1 });
    await t.advanceTo(200_000);
    expect(t.keeper.holds('show/1')).toBe(true);
    expect(t.keeper.token('show/1')).toBe(1);
    expect(t.lost).toEqual([]);
    expect(t.renewals()).toBe(Math.floor((200_000 - 10_000) / RENEW));
    expect(await t.store.acquire('show/1', 'b#2', TTL)).toEqual({
      acquired: false,
      holder: 'a#1',
    });
  });

  // The Done-when item: at the deadline the holder has let go, and the store still won't give the
  // lease to anyone else until its own TTL is up. On any store clock.
  for (const mode of ['reject', 'hang'] as const) {
    for (const offsetMs of [0, 3_600_000]) {
      it(`lets go at its deadline when renewals ${mode === 'reject' ? 'fail' : 'hang'}, before the store would give the lease away (store clock +${String(offsetMs)} ms)`, async () => {
        const t = setup(offsetMs);
        await t.keeper.acquire('show/1');
        // The renewal at 3,000 gets through: noted at 3,000, so the deadline is 11,000, and the
        // store's expiry is 13,000 on its own clock.
        await t.advanceTo(4_000);
        t.setMode(mode);
        await t.advanceTo(10_999);
        expect(t.keeper.holds('show/1')).toBe(true);
        expect(t.lost).toEqual([]);

        await t.advanceTo(11_000);
        expect(t.keeper.holds('show/1')).toBe(false);
        expect(t.keeper.token('show/1')).toBeUndefined();
        expect(t.lost).toEqual([['show/1', 1]]);
        // Let go, and nobody else can have it yet.
        expect(await t.store.acquire('show/1', 'b#2', TTL)).toEqual({
          acquired: false,
          holder: 'a#1',
        });
        await t.advanceTo(12_999);
        expect(await t.store.acquire('show/1', 'b#2', TTL)).toEqual({
          acquired: false,
          holder: 'a#1',
        });
        await t.advanceTo(13_000);
        expect(await t.store.acquire('show/1', 'b#2', TTL)).toEqual({ acquired: true, token: 2 });
        expect(t.lost).toEqual([['show/1', 1]]);
      });
    }
  }

  it('times a renewal from when it was sent, not from when the store answered', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    t.setMode('held');
    // Sent at 3,000. The store renews it at once, but the answer takes 2,000 to come back.
    await t.advanceTo(5_000);
    t.setMode('hang');
    for (const reply of t.held.splice(0)) reply.resolve();
    await t.advanceTo(10_999);
    expect(t.keeper.holds('show/1')).toBe(true);
    // 3,000 + 10,000 - 2,000. Timing from the answer would hold it until 13,000, as long as the
    // store does.
    await t.advanceTo(11_000);
    expect(t.keeper.holds('show/1')).toBe(false);
    expect(t.lost).toEqual([['show/1', 1]]);
  });

  it('never wins a lease back from a renewal that answers after the deadline', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    await t.advanceTo(4_000);
    // The renewal at 6,000 reaches the store, which extends the lease, but its answer is late.
    t.setMode('held');
    await t.advanceTo(7_000);
    t.setMode('hang');
    await t.advanceTo(11_000);
    expect(t.lost).toEqual([['show/1', 1]]);
    for (const reply of t.held.splice(0)) reply.resolve();
    await t.advanceTo(11_500);
    expect(t.keeper.holds('show/1')).toBe(false);
    expect(t.lost).toEqual([['show/1', 1]]);
    // Only acquire can make it this node's again.
    expect(await t.keeper.acquire('show/1')).toEqual({ acquired: true, token: 1 });
    expect(t.keeper.holds('show/1')).toBe(true);
  });

  it('lets go at once when the store no longer has the lease as its own', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    // Something released it behind this node's back, as a store whose clock ran fast would.
    await t.store.release('show/1', 'a#1', 1);
    await t.advanceTo(3_000);
    expect(t.keeper.holds('show/1')).toBe(false);
    expect(t.lost).toEqual([['show/1', 1]]);
  });

  it('keeps a lease acquired while a renewal was on its way', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    t.setMode('held');
    await t.advanceTo(3_000);
    t.setMode('ok');
    // Acquired after the renewal was sent, so the renewal's answer can't list it.
    await t.keeper.acquire('show/2');
    for (const reply of t.held.splice(0)) reply.resolve();
    await t.advanceTo(3_500);
    expect(t.keeper.holds('show/1')).toBe(true);
    expect(t.keeper.holds('show/2')).toBe(true);
    expect(t.lost).toEqual([]);
  });

  it('extends a lease it acquires again, with the same token', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    t.setMode('hang');
    await t.advanceTo(5_000);
    expect(await t.keeper.acquire('show/1')).toEqual({ acquired: true, token: 1 });
    await t.advanceTo(12_999);
    expect(t.keeper.holds('show/1')).toBe(true);
    await t.advanceTo(13_000);
    expect(t.lost).toEqual([['show/1', 1]]);
  });

  it('holds a lease another holder has, only once it is free', async () => {
    const t = setup();
    await t.store.acquire('show/1', 'b#2', TTL);
    expect(await t.keeper.acquire('show/1')).toEqual({ acquired: false, holder: 'b#2' });
    expect(t.keeper.holds('show/1')).toBe(false);
    await t.advanceTo(TTL);
    expect(await t.keeper.acquire('show/1')).toEqual({ acquired: true, token: 2 });
    expect(t.keeper.holds('show/1')).toBe(true);
  });

  it('treats a lease whose acquire took past the deadline as lost, after the caller hears', async () => {
    const t = setup();
    const reply = deferred();
    const slow: ShardStore = {
      ...t.store,
      async acquire(lease, holder, ttlMs) {
        const result = await t.store.acquire(lease, holder, ttlMs);
        await reply.promise;
        return result;
      },
    };
    const lost: string[] = [];
    const keeper = leaseKeeper({
      store: slow,
      holder: 'c#3',
      scheduler: t.scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: (lease) => {
        lost.push(lease);
      },
    });
    const acquired = keeper.acquire('show/1');
    await t.advanceTo(9_000);
    reply.resolve();
    expect(await acquired).toEqual({ acquired: true, token: 1 });
    expect(keeper.holds('show/1')).toBe(false);
    expect(lost).toEqual([]);
    await t.advanceTo(9_000);
    expect(lost).toEqual(['show/1']);
  });

  it('stops holding a lease it releases at once, and frees it in the store', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    const released = t.keeper.release('show/1');
    expect(t.keeper.holds('show/1')).toBe(false);
    await released;
    expect(await t.store.holders('')).toEqual([]);
    await t.keeper.release('show/1');
    await t.keeper.release('never/held');
    await t.advanceTo(20_000);
    expect(t.lost).toEqual([]);
    expect(t.renewals()).toBe(0);
  });

  it('stops renewing on close, and hands back a lease acquired after it', async () => {
    const t = setup();
    await t.keeper.acquire('show/1');
    await t.advanceTo(4_000);
    const before = t.renewals();
    t.keeper.close();
    t.keeper.close();
    expect(t.keeper.holds('show/1')).toBe(false);
    await t.advanceTo(30_000);
    expect(t.renewals()).toBe(before);
    expect(t.lost).toEqual([]);
    // The lease expires in the store on its own.
    expect(await t.store.holders('')).toEqual([]);
    expect(await t.keeper.acquire('show/2')).toEqual({ acquired: true, token: 1 });
    expect(t.keeper.holds('show/2')).toBe(false);
    expect(await t.store.holders('')).toEqual([]);
  });

  it('throws TypeError for options it can’t use, before it touches the store', () => {
    const scheduler = new ManualScheduler();
    const store = inMemoryShardStore({ clock: () => 0 });
    const base: LeaseKeeperOptions = {
      store,
      holder: 'a#1',
      scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: () => {},
    };
    expect(() => leaseKeeper({ ...base, ttl: 5 } as never)).toThrow(
      new TypeError('leaseKeeper: unknown option "ttl"'),
    );
    expect(() => leaseKeeper({ ...base, holder: '' })).toThrow(TypeError);
    expect(() => leaseKeeper({ ...base, ttlMs: 0 })).toThrow(TypeError);
    expect(() => leaseKeeper({ ...base, renewMs: 1.5 })).toThrow(TypeError);
    expect(() => leaseKeeper({ ...base, marginMs: -1 })).toThrow(TypeError);
    // A renewal every 8,000 can't land before a deadline 8,000 after the last one.
    expect(() => leaseKeeper({ ...base, renewMs: 8_000 })).toThrow(
      new TypeError(
        'leaseKeeper: renewMs must be less than ttlMs - marginMs, so a renewal lands before the ' +
          'deadline, got 8000 with ttlMs 10000 and marginMs 2000',
      ),
    );
    expect(() => leaseKeeper({ ...base, marginMs: TTL })).toThrow(TypeError);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  it('rejects a bad lease name from acquire with TypeError', async () => {
    const t = setup();
    await expect(t.keeper.acquire('')).rejects.toThrow(TypeError);
  });
});
