import { checkKeys, checkId, wallClock } from '../checks.js';
import {
  byText,
  checkAcquire,
  checkEntity,
  checkPrefix,
  checkRelease,
  checkRenewAll,
  type AcquireResult,
  type LeaseHolder,
  type ShardStore,
} from './shard-store.js';

interface Lease {
  readonly holder: string;
  readonly token: number;
  // On the store's clock. The lease is live while the clock reads less than this.
  readonly expiresAt: number;
}

const OPTIONS = new Set(['clock']);

/**
 * A shard store in memory, for tests, demos and the browser, on any runtime. Every call does its
 * work on a microtask, as a real store answers later, and nothing waits on time: a lease expires
 * when the clock says so.
 *
 * It judges expiry on `clock`, its own, which no node's clock is compared with (decision 0029).
 * Give a cluster on one `ManualScheduler` the scheduler's `now`, so leases expire in virtual time.
 *
 * @param opts.clock The store's clock, in integer ms. Defaults to `Date.now`.
 */
export function inMemoryShardStore(opts: { clock?: () => number } = {}): ShardStore {
  checkKeys(opts, OPTIONS, 'inMemoryShardStore');
  // The default clock, as for the journals' timestamps (decision 0015). Only this store reads it.
  // eslint-disable-next-line no-restricted-properties
  const { clock = Date.now } = opts;
  const now = wallClock(clock, 'inMemoryShardStore');
  const leases = new Map<string, Lease>();
  const entities = new Map<string, Set<string>>();

  const live = (lease: Lease | undefined, time: number): boolean =>
    lease !== undefined && time < lease.expiresAt;

  return {
    async acquire(name, holder, ttlMs): Promise<AcquireResult> {
      checkAcquire(name, holder, ttlMs);
      await Promise.resolve();
      const time = now();
      const current = leases.get(name);
      if (current !== undefined && live(current, time) && current.holder !== holder) {
        return { acquired: false, holder: current.holder };
      }
      // Still this holder's: the same ownership, extended. Otherwise a new one.
      const token =
        current !== undefined && live(current, time) ? current.token : (current?.token ?? 0) + 1;
      leases.set(name, { holder, token, expiresAt: time + ttlMs });
      return { acquired: true, token };
    },

    async renewAll(holder, ttlMs) {
      checkRenewAll(holder, ttlMs);
      await Promise.resolve();
      const time = now();
      const renewed: string[] = [];
      for (const [name, lease] of leases) {
        if (lease.holder !== holder || !live(lease, time)) continue;
        leases.set(name, { ...lease, expiresAt: time + ttlMs });
        renewed.push(name);
      }
      return renewed.sort(byText);
    },

    async release(name, holder, token) {
      checkRelease(name, holder, token);
      await Promise.resolve();
      const current = leases.get(name);
      if (current?.holder !== holder || current.token !== token) return;
      // Kept, expired, so the next owner's token carries on from this one.
      leases.set(name, { ...current, expiresAt: -Infinity });
    },

    async holders(prefix) {
      checkPrefix(prefix);
      await Promise.resolve();
      const time = now();
      const found: LeaseHolder[] = [];
      for (const [lease, current] of leases) {
        if (lease.startsWith(prefix) && live(current, time)) {
          found.push({ lease, holder: current.holder });
        }
      }
      return found.sort((a, b) => byText(a.lease, b.lease));
    },

    async remember(shard, id) {
      checkEntity(shard, id, 'remember');
      await Promise.resolve();
      let ids = entities.get(shard);
      if (ids === undefined) {
        ids = new Set();
        entities.set(shard, ids);
      }
      ids.add(id);
    },

    async forget(shard, id) {
      checkEntity(shard, id, 'forget');
      await Promise.resolve();
      entities.get(shard)?.delete(id);
    },

    async remembered(shard) {
      checkId(shard, 'remembered: shard');
      await Promise.resolve();
      return [...(entities.get(shard) ?? [])].sort(byText);
    },
  };
}
