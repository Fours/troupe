// Every shard store call the cluster makes, timed on the node's scheduler (decision 0036). Each
// caller already treats a failed call as one to retry or log, so a timeout reuses that path. A
// renewal that times out counts as failed, and the holder's deadline still drops the lease
// (decision 0029). An acquire that times out may have been granted: the holder's next acquire
// finds the lease its own and keeps it. Never exported.
import { withTimeout, type SetTimer } from '../timeout.js';
import type { ShardStore } from './shard-store.js';

/** `store`, with every call failing if it hasn't answered within `ms`. */
export function timedStore(store: ShardStore, ms: number, setTimer: SetTimer): ShardStore {
  const timed = <T>(call: string, promise: Promise<T>): Promise<T> =>
    withTimeout(
      promise,
      ms,
      setTimer,
      () => new Error(`shard store: ${call} did not answer within ${String(ms)} ms`),
    );
  return {
    acquire: (lease, holder, ttlMs) => timed('acquire', store.acquire(lease, holder, ttlMs)),
    renewAll: (holder, ttlMs) => timed('renewAll', store.renewAll(holder, ttlMs)),
    release: (lease, holder, token) => timed('release', store.release(lease, holder, token)),
    holders: (prefix) => timed('holders', store.holders(prefix)),
    remember: (shard, id) => timed('remember', store.remember(shard, id)),
    forget: (shard, id) => timed('forget', store.forget(shard, id)),
    remembered: (shard) => timed('remembered', store.remembered(shard)),
  };
}
