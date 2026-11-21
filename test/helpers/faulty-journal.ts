import type { Journal, NewEvent, StoredEvent } from '../../src/persistence/types.js';
import { deferred, type Deferred } from './deferred.js';

/** A journal that fails or holds calls on request, for persistent actor tests. */
export interface FaultyJournal extends Journal {
  /** Every append that reached the journal, in order, whether it failed or not. */
  readonly appends: readonly { persistenceId: string; expectedSeq: number; count: number }[];
  /** Every read's `fromSeq` and `limit`, in order. */
  readonly reads: readonly { fromSeq: number; limit: number }[];
  /** Makes the next `count` appends reject with `error`, writing nothing. */
  failAppends(error: unknown, count?: number): void;
  /** Makes the next `count` reads reject with `error`. */
  failReads(error: unknown, count?: number): void;
  /**
   * Holds the next append until the returned deferred resolves. It's written only then, so a
   * test controls exactly how long it's in flight. Rejecting the deferred fails the append.
   */
  holdNextAppend(): Deferred<void>;
  /** Replaces the next read's result with what `edit` makes of it. */
  editNextRead(edit: (events: readonly StoredEvent[]) => readonly StoredEvent[]): void;
}

/** Wraps `inner`, passing every call through unless a fault is armed. */
export function faultyJournal(inner: Journal): FaultyJournal {
  const appends: { persistenceId: string; expectedSeq: number; count: number }[] = [];
  const reads: { fromSeq: number; limit: number }[] = [];
  const appendFaults: unknown[] = [];
  const readFaults: unknown[] = [];
  const holds: Deferred<void>[] = [];
  const edits: ((events: readonly StoredEvent[]) => readonly StoredEvent[])[] = [];

  return {
    appends,
    reads,
    async append(persistenceId: string, expectedSeq: number, events: readonly NewEvent[]) {
      appends.push({ persistenceId, expectedSeq, count: events.length });
      const hold = holds.shift();
      if (hold !== undefined) await hold.promise;
      if (appendFaults.length > 0) throw appendFaults.shift();
      await inner.append(persistenceId, expectedSeq, events);
    },
    async read(persistenceId: string, fromSeq: number, limit: number) {
      reads.push({ fromSeq, limit });
      if (readFaults.length > 0) {
        await Promise.resolve();
        throw readFaults.shift();
      }
      const events = await inner.read(persistenceId, fromSeq, limit);
      const edit = edits.shift();
      return edit === undefined ? events : edit(events);
    },
    readByTag: (tag, afterOffset, limit) => inner.readByTag(tag, afterOffset, limit),
    failAppends(error, count = 1) {
      for (let i = 0; i < count; i++) appendFaults.push(error);
    },
    failReads(error, count = 1) {
      for (let i = 0; i < count; i++) readFaults.push(error);
    },
    holdNextAppend() {
      const hold = deferred();
      holds.push(hold);
      return hold;
    },
    editNextRead(edit) {
      edits.push(edit);
    },
  };
}
