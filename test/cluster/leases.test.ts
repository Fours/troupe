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
    // The late answer extended it in the store, which keeps it until 16,000. Holding nothing
    // else, the keeper renews nothing, so it expires there.
    expect((await t.store.holders('')).map((h) => h.lease)).toEqual(['show/1']);
    t.setMode('ok');
    await t.advanceTo(17_000);
    expect(await t.store.holders('')).toEqual([]);
    // Only acquire can make it this node's again, as a new holding.
    expect(await t.keeper.acquire('show/1')).toEqual({ acquired: true, token: 2 });
    expect(t.keeper.holds('show/1')).toBe(true);
  });

  it('gives a lease back only a TTL after it let go, so a write sent before then lands first', async () => {
    // Found by the hunt (contract seed 37,436 on the nodes mix): a lease lost at its deadline,
    // while its shard was still persisting, was given back at once. Another node took the shard
    // and recovered before the old write landed, and answered a read from before it.
    const t = setup();
    await t.keeper.acquire('show/9');
    await t.keeper.acquire('show/1');
    await t.advanceTo(4_000);
    // Renewals of show/1 stop answering in time: renewAll still extends both in the store.
    t.setMode('held');
    await t.advanceTo(11_000);
    expect(t.lost.map(([lease]) => lease)).toEqual(['show/9', 'show/1']);
    t.setMode('ok');
    for (const reply of t.held.splice(0)) reply.resolve();
    await t.keeper.acquire('show/9');
    // Still the keeper's in the store, renewed with show/9, until a TTL after it was lost...
    await t.advanceTo(20_500);
    expect((await t.store.holders('show/1')).map((h) => h.holder)).toEqual(['a#1']);
    // ...and given back with the first renewal after that.
    await t.advanceTo(24_000);
    expect(await t.store.holders('show/1')).toEqual([]);
  });

  it('gives back a lease whose release failed, so it isn’t renewed for good', async () => {
    const t = setup();
    let failRelease = true;
    const keeper = leaseKeeper({
      store: {
        ...t.store,
        release: (lease, holder, token) =>
          failRelease
            ? Promise.reject(new Error('store unreachable'))
            : t.store.release(lease, holder, token),
      },
      holder: 'b#2',
      scheduler: t.scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: () => {},
    });
    // It holds another, so it goes on renewing: with none, the lease would simply expire.
    await keeper.acquire('show/9');
    await keeper.acquire('show/2');
    await expect(keeper.release('show/2')).rejects.toThrow('store unreachable');
    expect(keeper.holds('show/2')).toBe(false);
    // Renewed with the rest while the store can't hear the release...
    await t.advanceTo(12_000);
    expect(await t.store.holders('show/2')).toEqual([
      expect.objectContaining({ lease: 'show/2', holder: 'b#2' }),
    ]);
    // ...and given back by the first renewal after it can.
    failRelease = false;
    await t.advanceTo(15_000);
    expect(await t.store.holders('show/2')).toEqual([]);
    expect((await t.store.acquire('show/2', 'c#3', TTL)).acquired).toBe(true);
  });

  it('waits for a give-back to finish before acquiring the lease again', async () => {
    // Found by the hunt (contract seed 9,886): the give-back learned the token and sent its
    // release, then the region's acquire landed first and got the same token back, and the
    // release freed the lease the region now held. Another node took it while it still ran.
    const t = setup();
    const releasing = deferred();
    let holdRelease = false;
    const keeper = leaseKeeper({
      store: {
        ...t.store,
        renewAll: async (holder, ttlMs) => {
          const renewed = await t.store.renewAll(holder, ttlMs);
          // The store still has show/5 as this node's, which the keeper doesn't hold.
          return [...renewed, 'show/5'].sort();
        },
        release: async (lease, holder, token) => {
          if (holdRelease) await releasing.promise;
          await t.store.release(lease, holder, token);
        },
      },
      holder: 'b#2',
      scheduler: t.scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: () => {},
    });
    await keeper.acquire('show/9');
    await t.store.acquire('show/5', 'b#2', TTL);
    holdRelease = true;
    // The renewal at 3,000 finds show/5 and starts giving it back; its release waits.
    await t.advanceTo(3_000);
    const acquiring = keeper.acquire('show/5');
    await t.advanceTo(3_100);
    releasing.resolve();
    const result = await acquiring;
    expect(result.acquired).toBe(true);
    expect(keeper.holds('show/5')).toBe(true);
    // Held in the store too, under the token the keeper has.
    expect(await t.store.holders('show/5')).toEqual([
      expect.objectContaining({ lease: 'show/5', holder: 'b#2' }),
    ]);
    expect((await t.store.acquire('show/5', 'c#3', TTL)).acquired).toBe(false);
  });

  it('waits for its own release to land before acquiring the lease again', async () => {
    // Found by the hunt (contract seed 48,788 on the heavy mix): a node handed a shard off on a
    // slow disk and, alone in a partition, took it straight back. The acquire landed before the
    // release and kept the token, then the release freed the lease it had just taken, and
    // another node ran the shard alongside it.
    const t = setup();
    const landing = deferred();
    let holdRelease = false;
    const keeper = leaseKeeper({
      store: {
        ...t.store,
        release: async (lease, holder, token) => {
          if (holdRelease) await landing.promise;
          await t.store.release(lease, holder, token);
        },
      },
      holder: 'b#2',
      scheduler: t.scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: () => {},
    });
    expect(await keeper.acquire('show/7')).toEqual({ acquired: true, token: 1 });
    holdRelease = true;
    const releasing = keeper.release('show/7');
    const acquiring = keeper.acquire('show/7');
    await t.advanceTo(500);
    landing.resolve();
    await releasing;
    // A new holding, after the release: the store has it as this node's, under that token.
    expect(await acquiring).toEqual({ acquired: true, token: 2 });
    expect(keeper.holds('show/7')).toBe(true);
    expect((await t.store.acquire('show/7', 'c#3', TTL)).acquired).toBe(false);
  });

  it('won’t take a lease again under the token of a release that never answered', async () => {
    // Found by the hunt (contract seed 48,788 on the heavy mix): the release timed out on a slow
    // disk and landed later, after the node had taken the lease back under the same token, so
    // it freed the lease the node then held.
    const t = setup();
    const landing = deferred();
    const keeper = leaseKeeper({
      store: {
        ...t.store,
        release: (lease, holder, token) => {
          // Applied only when landing resolves; the caller gives up at once, as a timeout would.
          void landing.promise.then(() => t.store.release(lease, holder, token));
          return Promise.reject(new Error('timed out'));
        },
      },
      holder: 'b#2',
      scheduler: t.scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: () => {},
    });
    expect(await keeper.acquire('show/8')).toEqual({ acquired: true, token: 1 });
    await expect(keeper.release('show/8')).rejects.toThrow('timed out');
    // The store still has it as this node's, token 1: taking it now would be undone by the release.
    await expect(keeper.acquire('show/8')).rejects.toThrow('has had no answer');
    expect(keeper.holds('show/8')).toBe(false);
    landing.resolve();
    await t.advanceTo(10);
    // Landed: the lease is free, and taken again under a new token, which no late release matches.
    expect(await keeper.acquire('show/8')).toEqual({ acquired: true, token: 2 });
    expect(keeper.holds('show/8')).toBe(true);
  });

  it('gives nothing back while its own acquire of it is on the way', async () => {
    const t = setup();
    const answer = deferred();
    let holdAcquire = false;
    const keeper = leaseKeeper({
      store: {
        ...t.store,
        acquire: async (lease, holder, ttlMs) => {
          const result = await t.store.acquire(lease, holder, ttlMs);
          if (holdAcquire) await answer.promise;
          return result;
        },
      },
      holder: 'b#2',
      scheduler: t.scheduler,
      ttlMs: TTL,
      renewMs: RENEW,
      marginMs: MARGIN,
      onLost: () => {},
    });
    await keeper.acquire('show/9');
    holdAcquire = true;
    // Applied in the store at once, answered only after a renewal has seen it.
    const acquiring = keeper.acquire('show/3');
    await t.advanceTo(3_500);
    answer.resolve();
    expect(await acquiring).toEqual({ acquired: true, token: 1 });
    await t.advanceTo(7_000);
    expect(keeper.holds('show/3')).toBe(true);
    expect((await t.store.holders('show/3')).map((h) => h.holder)).toEqual(['b#2']);
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
