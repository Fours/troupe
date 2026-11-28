// The holder's side of a lease (decision 0029). The store judges expiry on its clock, and this
// judges it on the node's own: it notes `scheduler.now()` before it sends a renewal, and once the
// store says yes, treats the lease as its own until that time plus `ttlMs` minus `marginMs`. The
// store started its `ttlMs` after this node noted the time, so this deadline comes first, as long
// as the two clocks run at about the same rate. Their readings are never compared.
//
// At the deadline the lease is lost, whether or not the store has answered, and `onLost` says so.
// A renewal that comes back after that can't win the lease back: only `acquire` can. Never
// exported: T6's shards use it.
import { checkInt, checkId, checkKeys } from '../checks.js';
import type { Plant } from '../internal.js';
import type { Scheduler } from '../scheduler.js';
import type { AcquireResult, ShardStore } from './shard-store.js';

/** Options for {@link leaseKeeper}. Every time is in integer milliseconds. */
export interface LeaseKeeperOptions {
  readonly store: ShardStore;
  /** This node's holder name, `<address>#<uid>`. */
  readonly holder: string;
  readonly scheduler: Scheduler;
  /** How long the store keeps a lease after each acquire or renewal. */
  readonly ttlMs: number;
  /** How often to renew. Less than `ttlMs - marginMs`, so a renewal lands before the deadline. */
  readonly renewMs: number;
  /** How long before the store's expiry this node gives a lease up. */
  readonly marginMs: number;
  /** Called once for each lease this node stops holding without releasing it. */
  readonly onLost: (lease: string, token: number) => void;
  /** A bug Rehearsal planted on this node's system, if any (T6). */
  readonly plant?: Plant | undefined;
}

/** The leases one node holds. */
export interface LeaseKeeper {
  /** Asks the store for the lease. If it's granted, holds it, and renews it, from then on. */
  acquire(lease: string): Promise<AcquireResult>;
  /** Stops holding the lease at once, then gives it up in the store. */
  release(lease: string): Promise<void>;
  /** Whether this node holds the lease now, by its own clock. */
  holds(lease: string): boolean;
  /** The token this node holds the lease with, if it holds it. */
  token(lease: string): number | undefined;
  /** Stops renewing and forgets every lease, with no `onLost`. They expire in the store. */
  close(): void;
}

interface Held {
  readonly token: number;
  // When this node noted the time for the acquire that granted it.
  readonly since: number;
  deadline: number;
  cancel: () => void;
}

const OPTIONS = new Set([
  'store',
  'holder',
  'scheduler',
  'ttlMs',
  'renewMs',
  'marginMs',
  'onLost',
  'plant',
]);

/**
 * Keeps one node's leases: acquires, renews every `renewMs` on the scheduler, and drops each at
 * its deadline unless a renewal has moved it.
 * @throws TypeError for options that can't be used, unknown ones included, or intervals whose
 * renewals couldn't land before the deadline.
 */
export function leaseKeeper(opts: LeaseKeeperOptions): LeaseKeeper {
  checkKeys(opts, OPTIONS, 'leaseKeeper');
  const { store, holder, scheduler, ttlMs, renewMs, marginMs, onLost, plant } = opts;
  checkId(holder, 'leaseKeeper: holder');
  checkInt(ttlMs, 'leaseKeeper: ttlMs');
  checkInt(renewMs, 'leaseKeeper: renewMs');
  checkInt(marginMs, 'leaseKeeper: marginMs', { min: 0 });
  if (renewMs >= ttlMs - marginMs) {
    throw new TypeError(
      `leaseKeeper: renewMs must be less than ttlMs - marginMs, so a renewal lands before the ` +
        `deadline, got ${String(renewMs)} with ttlMs ${String(ttlMs)} and marginMs ${String(marginMs)}`,
    );
  }

  const held = new Map<string, Held>();
  // Leases with an acquire of this node's on its way, and how many.
  const acquiring = new Map<string, number>();
  // Releases and give-backs under way. An acquire waits for one to finish: an acquire of a lease
  // this node still has in the store keeps its token, so a release sent before it but landing
  // after would free the lease it had just taken (T7).
  const lettingGo = new Map<string, Promise<void>>();
  // When this node let each lease go, by losing it or releasing it, for a TTL afterwards.
  const letGo = new Map<string, number>();
  // The token of each lease whose release has had no answer: it may still land (T7).
  const unanswered = new Map<string, number>();
  let closed = false;

  /** Moves a lease's deadline to `noted + ttlMs - marginMs`, if that's later. */
  function extend(lease: string, entry: Held, noted: number): void {
    const deadline = noted + ttlMs - marginMs;
    if (deadline <= entry.deadline) return;
    entry.cancel();
    entry.deadline = deadline;
    entry.cancel = scheduler.setTimer(
      () => {
        lose(lease, entry);
      },
      Math.max(0, deadline - scheduler.now()),
    );
  }

  function lose(lease: string, entry: Held): void {
    if (held.get(lease) !== entry) return;
    entry.cancel();
    held.delete(lease);
    letGo.set(lease, scheduler.now());
    onLost(lease, entry.token);
  }

  async function renew(): Promise<void> {
    if (held.size === 0) return;
    let noted = scheduler.now();
    let renewed: readonly string[];
    try {
      renewed = await store.renewAll(holder, ttlMs);
    } catch {
      // Keep trying on the next tick. The deadline stops the shard if none gets through.
      return;
    }
    // Planted (T6): the time noted once the store has answered, so a slow reply stretches the
    // deadline past the store's own expiry.
    if (plant === 'late-deadline') noted = scheduler.now();
    const yes = new Set(renewed);
    for (const [lease, entry] of [...held]) {
      if (yes.has(lease)) extend(lease, entry, noted);
      // The store no longer has it as ours, though it did when this renewal was sent: someone
      // released it, or the store's clock ran fast. Losing it early is always safe.
      else if (entry.since < noted) lose(lease, entry);
    }
    // The store renews every lease it has as ours, so one this node let go of without the store
    // hearing, a release that failed, a lease lost at its deadline while a renewal was still on
    // its way, or an acquire that timed out after it was applied, would be renewed for good and
    // its shard never find another home (T7). Each is given back.
    for (const lease of renewed) {
      if (held.has(lease) || acquiring.has(lease)) continue;
      // Not before a TTL has passed since this node let it go, as the store would have kept it
      // had its renewals stopped: a write its shard sent before then may still land, and the
      // next owner must recover after it (T7, contract seed 37,436 on the nodes mix).
      const since = letGo.get(lease);
      if (since !== undefined && scheduler.now() - since < ttlMs) continue;
      letGo.delete(lease);
      void giveBack(lease);
    }
    for (const [lease, since] of letGo) {
      if (scheduler.now() - since >= ttlMs && !renewed.includes(lease)) letGo.delete(lease);
    }
  }

  // Gives back a lease the store has as this node's and this node doesn't hold. Only the store
  // knows its token, so it's acquired again, which keeps the token, to learn it.
  function giveBack(lease: string): Promise<void> {
    const pending = lettingGo.get(lease);
    if (pending !== undefined) return pending;
    const giving = (async () => {
      try {
        const result = await store.acquire(lease, holder, ttlMs);
        // An acquire of this node's that began meanwhile wants the lease: it keeps it.
        if (result.acquired && !held.has(lease) && !acquiring.has(lease)) {
          unanswered.set(lease, result.token);
          await store.release(lease, holder, result.token);
          if (unanswered.get(lease) === result.token) unanswered.delete(lease);
        }
      } catch {
        // The next renewal finds it again, or it expires in the store.
      }
    })().finally(() => {
      if (lettingGo.get(lease) === giving) lettingGo.delete(lease);
    });
    lettingGo.set(lease, giving);
    return giving;
  }

  const cancelTick = (() => {
    let cancel = () => {};
    const tick = () => {
      cancel = scheduler.setTimer(tick, renewMs);
      void renew();
    };
    cancel = scheduler.setTimer(tick, renewMs);
    return () => {
      cancel();
    };
  })();

  return {
    async acquire(lease) {
      checkId(lease, 'acquire: lease');
      let noted = scheduler.now();
      acquiring.set(lease, (acquiring.get(lease) ?? 0) + 1);
      let result: AcquireResult;
      try {
        const letting = lettingGo.get(lease);
        if (letting !== undefined) {
          await letting;
          noted = scheduler.now();
        }
        result = await store.acquire(lease, holder, ttlMs);
      } finally {
        const left = (acquiring.get(lease) ?? 1) - 1;
        if (left === 0) acquiring.delete(lease);
        else acquiring.set(lease, left);
      }
      if (!result.acquired) return result;
      const tainted = unanswered.get(lease);
      if (tainted !== undefined) {
        // A release of this holding has no answer: it may land yet, and free the lease this
        // acquire just kept. Not until the token has changed, once the release lands, or a give-
        // back frees the lease (T7, contract seed 48,788 on the heavy mix).
        if (tainted === result.token) {
          throw new Error(
            `${lease}'s release with token ${String(tainted)} has had no answer, so it isn't taken again under that token`,
          );
        }
        unanswered.delete(lease);
      }
      if (closed) {
        // Nobody will renew it, so hand it straight back rather than leave it to expire.
        await store.release(lease, holder, result.token).catch(() => {});
        return result;
      }
      const current = held.get(lease);
      if (current?.token === result.token) {
        extend(lease, current, noted);
        return result;
      }
      if (current !== undefined) lose(lease, current);
      const entry: Held = { token: result.token, since: noted, deadline: -Infinity, cancel() {} };
      held.set(lease, entry);
      // A deadline already past fires on the next timer turn, after the caller has the result.
      extend(lease, entry, noted);
      return result;
    },

    async release(lease) {
      const entry = held.get(lease);
      if (entry === undefined) return;
      entry.cancel();
      held.delete(lease);
      letGo.set(lease, scheduler.now());
      const releasing = store.release(lease, holder, entry.token);
      // Until it answers, an acquire must not take the lease under this token: see acquire.
      unanswered.set(lease, entry.token);
      const settled = releasing.then(
        () => {
          if (unanswered.get(lease) === entry.token) unanswered.delete(lease);
        },
        () => {},
      );
      lettingGo.set(lease, settled);
      try {
        await releasing;
      } finally {
        if (lettingGo.get(lease) === settled) lettingGo.delete(lease);
      }
    },

    holds(lease) {
      const entry = held.get(lease);
      return entry !== undefined && scheduler.now() < entry.deadline;
    },

    token(lease) {
      return held.get(lease)?.token;
    },

    close() {
      if (closed) return;
      closed = true;
      cancelTick();
      for (const entry of held.values()) entry.cancel();
      held.clear();
    },
  };
}
