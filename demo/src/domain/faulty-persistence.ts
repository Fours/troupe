// The demo's storage: the in-memory backend, behind a switch that takes the journal down.
import {
  inMemoryPersistence,
  type Journal,
  type Persistence,
} from '@kylewillett/troupe/persistence';

/** What every journal call rejects with while the journal is down. */
export class JournalDownError extends Error {
  /** Always `"JournalDownError"`. */
  override readonly name = 'JournalDownError';
}

/** The in-memory backend, with a switch. */
export interface FaultyPersistence extends Persistence {
  /** Whether the journal is down. */
  readonly isDown: boolean;
  /** From now on, every append and read rejects with {@link JournalDownError}. */
  down(): void;
  /** Lets calls through again. */
  up(): void;
}

/**
 * An in-memory journal whose every append, read and tag read fails while it's down. Its
 * timestamps come from `clock`, the system's virtual time, so they're the same on every run.
 * There are no snapshots, and no offsets: each system keeps its own (see `salesBoard`).
 */
export function faultyPersistence(clock: () => number): FaultyPersistence {
  const inner = inMemoryPersistence({ clock }).journal;
  let isDown = false;
  const check = (call: string): void => {
    if (isDown) throw new JournalDownError(`the journal is down: ${call} failed`);
  };
  const journal: Journal = {
    append: async (persistenceId, expectedSeq, events) => {
      check('append');
      await inner.append(persistenceId, expectedSeq, events);
    },
    read: async (persistenceId, fromSeq, limit) => {
      check('read');
      return inner.read(persistenceId, fromSeq, limit);
    },
    readByTag: async (tag, afterOffset, limit) => {
      check('readByTag');
      return inner.readByTag(tag, afterOffset, limit);
    },
  };
  return {
    journal,
    get isDown() {
      return isDown;
    },
    down() {
      isDown = true;
    },
    up() {
      isDown = false;
    },
  };
}
