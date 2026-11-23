// Shard leases (decision 0029): a shard is owned by whoever holds its lease in the store, and by
// nothing else. The store judges expiry on its own clock, and each holder on its own (leases.ts),
// so no clock is ever compared with another. Every backend runs the same argument checks, from
// here, so they reject exactly the same calls.
import { checkId, checkInt } from '../checks.js';

/** The answer to {@link ShardStore.acquire}. */
export type AcquireResult =
  | {
      readonly acquired: true;
      /** Goes up by one every time the lease changes hands, so a history can tell owners apart. */
      readonly token: number;
    }
  | {
      readonly acquired: false;
      /** Who holds it now. */
      readonly holder: string;
    };

/** A lease and its current holder, from {@link ShardStore.holders}. */
export interface LeaseHolder {
  /** The lease's name, `<type>/<shard>`. */
  readonly lease: string;
  /** Who holds it, `<address>#<uid>`. */
  readonly holder: string;
}

/**
 * Where shard leases live, and the entities each shard remembers. A lease's name is
 * `<type>/<shard>`, and a holder is `<address>#<uid>`, so a restarted node is a new holder that
 * waits for its old incarnation's leases to expire.
 *
 * The store judges expiry on its own clock. A lease whose time is up is free, whatever its holder
 * thinks. Holders judge it on theirs, and stop treating a lease as their own before the store
 * would give it away. Every time is in integer milliseconds.
 */
export interface ShardStore {
  /**
   * Takes the lease if it's free, expired or already this holder's, for `ttlMs` from now on the
   * store's clock. Taking a lease that was free, released or expired raises its token by one,
   * even for the holder that had it before. Taking one this holder still has keeps the token,
   * and extends it.
   */
  acquire(lease: string, holder: string, ttlMs: number): Promise<AcquireResult>;
  /** Extends every lease `holder` still holds by `ttlMs` from now, and returns their names, sorted. */
  renewAll(holder: string, ttlMs: number): Promise<readonly string[]>;
  /**
   * Gives a lease up, if `holder` still holds it with `token`. Otherwise does nothing, so a holder
   * that lost the lease can never release its next owner's.
   */
  release(lease: string, holder: string, token: number): Promise<void>;
  /** The current holders of the unexpired leases whose names start with `prefix`, sorted by name. */
  holders(prefix: string): Promise<readonly LeaseHolder[]>;
  /** Records that `shard` has started entity `id`, for `remember: true`. */
  remember(shard: string, id: string): Promise<void>;
  /** Forgets entity `id` of `shard`. Forgetting one that isn't remembered does nothing. */
  forget(shard: string, id: string): Promise<void>;
  /** The entities `shard` remembers, sorted. */
  remembered(shard: string): Promise<readonly string[]>;
}

/** Checks `acquire`'s arguments. */
export function checkAcquire(lease: unknown, holder: unknown, ttlMs: unknown): void {
  checkId(lease, 'acquire: lease');
  checkId(holder, 'acquire: holder');
  checkInt(ttlMs, 'acquire: ttlMs');
}

/** Checks `renewAll`'s arguments. */
export function checkRenewAll(holder: unknown, ttlMs: unknown): void {
  checkId(holder, 'renewAll: holder');
  checkInt(ttlMs, 'renewAll: ttlMs');
}

/** Checks `release`'s arguments. */
export function checkRelease(lease: unknown, holder: unknown, token: unknown): void {
  checkId(lease, 'release: lease');
  checkId(holder, 'release: holder');
  checkInt(token, 'release: token');
}

/** Checks `holders`' prefix, which may be empty, to list every lease. */
export function checkPrefix(prefix: unknown): void {
  if (prefix !== '') checkId(prefix, 'holders: prefix');
}

/** Checks a shard and entity id, for `remember` and `forget`. */
export function checkEntity(shard: unknown, id: unknown, where: string): void {
  checkId(shard, `${where}: shard`);
  checkId(id, `${where}: id`);
}

/** Orders by UTF-16 code unit, which is code point order for the ids sharding uses. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
