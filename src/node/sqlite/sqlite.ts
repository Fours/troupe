import { DatabaseSync } from 'node:sqlite';
import { checkKeys } from '../../checks.js';
import {
  checkAppend,
  checkId,
  checkOffsetSave,
  checkRead,
  checkReadByTag,
  serializeSnapshot,
  wallClock,
} from '../../persistence/backend.js';
import { JournalConflictError } from '../../persistence/errors.js';
import type {
  Journal,
  OffsetStore,
  Persistence,
  Snapshot,
  SnapshotStore,
  StoredEvent,
} from '../../persistence/types.js';
import { SQLITE_SCHEMA } from './schema.js';

/** The SQLite backend's stores, which share one connection. */
export interface SqlitePersistence extends Required<Persistence> {
  /** Closes the connection. Calls made after it reject. Closing twice does nothing. */
  close(): void;
}

const OPTIONS = new Set(['path', 'clock']);

// How long an append waits for another connection's write lock before it fails. node:sqlite is
// synchronous, so the wait blocks this thread.
const BUSY_TIMEOUT_MS = 5_000;

// SQLITE_CONSTRAINT_UNIQUE, the extended result code node:sqlite reports as `errcode`.
const UNIQUE_VIOLATION = 2067;

interface EventRow {
  readonly persistence_id: string;
  readonly seq: number;
  readonly global_offset: number;
  readonly timestamp: number;
  readonly version: number;
  readonly tags: string;
  readonly event: string;
}

interface SnapshotRow {
  readonly seq: number;
  readonly version: number;
  readonly timestamp: number;
  readonly state: string;
}

const EVENT_COLUMNS =
  'e.persistence_id, e.seq, e.global_offset, e.timestamp, e.version, e.tags, e.event';

/**
 * A backend on SQLite, through Node's built-in `node:sqlite`, so it adds no dependency. Node only.
 *
 * File databases use WAL mode. An append runs in a `BEGIN IMMEDIATE` transaction, which takes the
 * database's write lock before it checks the stream's last sequence number, so two connections,
 * in one process or several, can't both win. The loser rejects with `JournalConflictError`.
 *
 * `node:sqlite` is synchronous: each call does its work before it returns its promise, and an
 * append waits up to 5 s, blocking the thread, for another connection's write lock. On Node 22,
 * the first load prints an experimental warning. Node 24 and later don't.
 *
 * @param opts.path A database file, created if it's missing, or `":memory:"`.
 * @param opts.clock The wall clock for timestamps, in integer ms. Defaults to `Date.now`.
 */
export function sqlitePersistence(opts: { path: string; clock?: () => number }): SqlitePersistence {
  checkKeys(opts, OPTIONS, 'sqlitePersistence');
  // The default wall clock for timestamps, which never order anything (decision 0015).
  // eslint-disable-next-line no-restricted-properties
  const { path, clock = Date.now } = opts;
  checkId(path, 'sqlitePersistence: path');
  const now = wallClock(clock, 'sqlitePersistence');

  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    // A no-op for ":memory:", which has no file to log to.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SQLITE_SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }
  let open = true;

  /**
   * Runs synchronous `work` and settles a promise with its result, so a throw, from a check or
   * from SQLite, becomes a rejection, as the store interfaces promise. After `close()`, it rejects
   * with one message on every Node version, rather than whatever node:sqlite says.
   */
  function attempt<T>(work: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      if (!open) throw new Error('sqlitePersistence: the database is closed');
      resolve(work());
    });
  }

  const lastSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM troupe_events WHERE persistence_id = ?',
  );
  const insertEvent = db.prepare(
    'INSERT INTO troupe_events (persistence_id, seq, version, timestamp, event, tags) ' +
      'VALUES (?, ?, ?, ?, ?, ?) RETURNING global_offset',
  );
  const insertTag = db.prepare('INSERT INTO troupe_event_tags (tag, global_offset) VALUES (?, ?)');
  const readStream = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM troupe_events e ` +
      'WHERE e.persistence_id = ? AND e.seq >= ? ORDER BY e.seq LIMIT ?',
  );
  const readTag = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM troupe_event_tags t ` +
      'JOIN troupe_events e ON e.global_offset = t.global_offset ' +
      'WHERE t.tag = ? AND t.global_offset > ? ORDER BY t.global_offset LIMIT ?',
  );
  // Saves don't hold the mailbox, so an older one can land after a newer one: keep the higher seq.
  const saveSnapshot = db.prepare(
    'INSERT INTO troupe_snapshots (persistence_id, seq, version, timestamp, state) ' +
      'VALUES (?, ?, ?, ?, ?) ON CONFLICT (persistence_id) DO UPDATE SET ' +
      'seq = excluded.seq, version = excluded.version, timestamp = excluded.timestamp, ' +
      'state = excluded.state WHERE excluded.seq >= troupe_snapshots.seq',
  );
  const loadSnapshot = db.prepare(
    'SELECT seq, version, timestamp, state FROM troupe_snapshots WHERE persistence_id = ?',
  );
  const loadOffset = db.prepare('SELECT global_offset FROM troupe_offsets WHERE name = ?');
  const saveOffset = db.prepare(
    'INSERT INTO troupe_offsets (name, global_offset) VALUES (?, ?) ' +
      'ON CONFLICT (name) DO UPDATE SET global_offset = excluded.global_offset',
  );

  /** Runs `work` in a transaction that holds the write lock from its start. */
  function writeTransaction(work: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const journal: Journal = {
    append: (persistenceId, expectedSeq, events) =>
      attempt(() => {
        // Check and serialize the whole batch before the transaction, so it's all or none.
        const batch = checkAppend(persistenceId, expectedSeq, events);
        try {
          writeTransaction(() => {
            // The check runs under the write lock, so no other writer can append between it and
            // the inserts. This also rejects an expectedSeq ahead of the stream.
            const { seq } = lastSeq.get(persistenceId) as { seq: number };
            if (seq !== expectedSeq) throw new JournalConflictError(persistenceId, expectedSeq);
            if (batch.length === 0) return;
            const timestamp = now();
            batch.forEach(({ version, tags, json }, i) => {
              const { global_offset } = insertEvent.get(
                persistenceId,
                expectedSeq + i + 1,
                version,
                timestamp,
                json,
                JSON.stringify(tags),
              ) as { global_offset: number };
              for (const tag of tags) insertTag.run(tag, global_offset);
            });
          });
        } catch (error) {
          // The lock check settles every race, so this is a backstop: the unique key on
          // (persistence_id, seq) still says the stream already has that event.
          if (isUniqueViolation(error)) throw new JournalConflictError(persistenceId, expectedSeq);
          throw error;
        }
      }),

    read: (persistenceId, fromSeq, limit) =>
      attempt(() => {
        checkRead(persistenceId, fromSeq, limit);
        return (readStream.all(persistenceId, fromSeq, limit) as unknown as EventRow[]).map(
          toStored,
        );
      }),

    readByTag: (tag, afterOffset, limit) =>
      attempt(() => {
        checkReadByTag(tag, afterOffset, limit);
        return (readTag.all(tag, afterOffset, limit) as unknown as EventRow[]).map(toStored);
      }),
  };

  const snapshots: SnapshotStore = {
    save: (persistenceId, snapshot) =>
      attempt(() => {
        const { seq, version, json } = serializeSnapshot(persistenceId, snapshot);
        saveSnapshot.run(persistenceId, seq, version, now(), json);
      }),

    load: (persistenceId) =>
      attempt(() => {
        checkId(persistenceId, 'snapshots.load: persistenceId');
        const row = loadSnapshot.get(persistenceId) as SnapshotRow | undefined;
        if (row === undefined) return undefined;
        const loaded: Snapshot = {
          seq: row.seq,
          version: row.version,
          state: JSON.parse(row.state),
          timestamp: row.timestamp,
        };
        return loaded;
      }),
  };

  const offsets: OffsetStore = {
    load: (name) =>
      attempt(() => {
        checkId(name, 'offsets.load: name');
        const row = loadOffset.get(name) as { global_offset: number } | undefined;
        return row?.global_offset ?? 0;
      }),

    save: (name, offset) =>
      attempt(() => {
        checkOffsetSave(name, offset);
        saveOffset.run(name, offset);
      }),
  };

  return {
    journal,
    snapshots,
    offsets,
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errcode?: unknown }).errcode === UNIQUE_VIOLATION
  );
}

function toStored(row: EventRow): StoredEvent {
  return {
    persistenceId: row.persistence_id,
    seq: row.seq,
    offset: row.global_offset,
    timestamp: row.timestamp,
    version: row.version,
    tags: JSON.parse(row.tags) as string[],
    event: JSON.parse(row.event),
  };
}
