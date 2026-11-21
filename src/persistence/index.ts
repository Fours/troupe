// The /persistence entry point: runs on any JavaScript runtime. Export only from here.
export { JournalConflictError, JournalSequenceError } from './errors.js';
export { inMemoryPersistence, type InMemoryPersistence } from './memory.js';
export type {
  Journal,
  NewEvent,
  NewSnapshot,
  OffsetStore,
  Persistence,
  Snapshot,
  SnapshotStore,
  StoredEvent,
} from './types.js';
