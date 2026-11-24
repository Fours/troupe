// The /persistence entry point: runs on any JavaScript runtime. Export only from here.
export {
  persistentActor,
  type Effect,
  type EventOptions,
  type PersistentActorDef,
  type PersistentContext,
  type PersistentSignal,
  type PersistentState,
} from './actor.js';
export {
  EventValidationError,
  EventVersionError,
  JournalConflictError,
  JournalSequenceError,
  PersistenceTimeoutError,
  type PersistenceOperation,
} from './errors.js';
export { inMemoryPersistence, type InMemoryPersistence } from './memory.js';
export { projection, type ProjectionOptions, type ProjectionState } from './projection.js';
export type { StandardSchemaV1 } from './standard-schema.js';
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
