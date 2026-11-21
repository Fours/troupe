// The storage interfaces every persistence backend implements. They're promise-based and know
// nothing about Node, so any runtime, and milestone 5's simulated journal, can implement them.

/** An event to append: a JSON value, with its version and tags (decision 0014). */
export interface NewEvent {
  /** The event itself. Must be a JSON value. */
  readonly event: unknown;
  /** The event's schema version, a positive integer. */
  readonly version: number;
  /** The tags projections follow the event by. No duplicates. */
  readonly tags: readonly string[];
}

/** An event as the journal stores it. */
export interface StoredEvent extends NewEvent {
  /** The event stream it belongs to. */
  readonly persistenceId: string;
  /** Its place in the stream: 1, 2, 3, ... with no gaps. */
  readonly seq: number;
  /**
   * Its place in the whole journal. Offsets increase but may skip numbers. Once a reader has seen
   * offset n, no event with a lower offset can appear later.
   */
  readonly offset: number;
  /** Wall-clock ms from the backend's clock, when it was appended. For people, never for ordering. */
  readonly timestamp: number;
}

/** Where events are kept: one stream per persistence id, each guarded by a sequence check. */
export interface Journal {
  /**
   * Appends events after `expectedSeq`, all or none. Rejects with `JournalConflictError` when the
   * stream's last sequence number isn't `expectedSeq`, and writes nothing. `expectedSeq: 0`
   * creates the stream.
   */
  append(persistenceId: string, expectedSeq: number, events: readonly NewEvent[]): Promise<void>;
  /** The stream's events from `fromSeq` on, in order, at most `limit`. */
  read(persistenceId: string, fromSeq: number, limit: number): Promise<readonly StoredEvent[]>;
  /** Events with `tag`, after `afterOffset`, in offset order, at most `limit`. */
  readByTag(tag: string, afterOffset: number, limit: number): Promise<readonly StoredEvent[]>;
}

/** A snapshot to save. The backend stamps its timestamp from its own clock (decision 0015). */
export interface NewSnapshot {
  /** The sequence number of the last event the state includes. */
  readonly seq: number;
  /** The snapshot's schema version, a positive integer. */
  readonly version: number;
  /** The actor's state. Must be a JSON value. */
  readonly state: unknown;
}

/** A snapshot as the store keeps it. */
export interface Snapshot extends NewSnapshot {
  /** Wall-clock ms from the backend's clock, when it was saved. */
  readonly timestamp: number;
}

/** Keeps the latest snapshot of each persistence id. */
export interface SnapshotStore {
  /** Saves a snapshot. Ignored if the stored one has a higher `seq`. */
  save(persistenceId: string, snapshot: NewSnapshot): Promise<void>;
  /** The latest snapshot, if there is one. */
  load(persistenceId: string): Promise<Snapshot | undefined>;
}

/** Keeps how far each projection has read. */
export interface OffsetStore {
  /** The stored offset for a projection, 0 if none. */
  load(name: string): Promise<number>;
  /** Stores a projection's offset, replacing the one before. */
  save(name: string, offset: number): Promise<void>;
}

/** One backend's stores. */
export interface Persistence {
  /** Where events are kept. */
  readonly journal: Journal;
  /** Where snapshots are kept. Needed for snapshotting. */
  readonly snapshots?: SnapshotStore;
  /** Where projection offsets are kept. Needed for projections. */
  readonly offsets?: OffsetStore;
}
