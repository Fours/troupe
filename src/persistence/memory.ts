import { checkKeys } from '../checks.js';
import {
  checkAppend,
  checkId,
  checkOffsetSave,
  checkRead,
  checkReadByTag,
  serializeSnapshot,
  wallClock,
} from './backend.js';
import { JournalConflictError } from './errors.js';
import type {
  Journal,
  OffsetStore,
  Persistence,
  Snapshot,
  SnapshotStore,
  StoredEvent,
} from './types.js';

/** The in-memory backend's stores, plus a view of every event for tests and the inspector. */
export interface InMemoryPersistence extends Required<Persistence> {
  /** Every stored event, in offset order, or only `persistenceId`'s when it's given. */
  events(persistenceId?: string): readonly StoredEvent[];
}

const OPTIONS = new Set(['clock']);

/** An event as stored: the event itself is JSON text, so no caller's reference can reach it. */
interface Row {
  readonly persistenceId: string;
  readonly seq: number;
  readonly offset: number;
  readonly timestamp: number;
  readonly version: number;
  readonly tags: readonly string[];
  readonly json: string;
}

interface SnapshotRow {
  readonly seq: number;
  readonly version: number;
  readonly timestamp: number;
  readonly json: string;
}

/**
 * A backend that keeps everything in memory, for tests, demos and the browser. It works on any
 * JavaScript runtime. Every call resolves on a microtask, and nothing waits on time.
 *
 * Events and snapshot states round-trip through JSON, as on the SQL backends, so a test on this
 * backend sees what Postgres would give back.
 *
 * @param opts.clock The wall clock for timestamps, in integer ms. Defaults to `Date.now`.
 */
export function inMemoryPersistence(opts: { clock?: () => number } = {}): InMemoryPersistence {
  checkKeys(opts, OPTIONS, 'inMemoryPersistence');
  // The default wall clock for timestamps, which never order anything (decision 0015).
  // eslint-disable-next-line no-restricted-properties
  const { clock = Date.now } = opts;
  const now = wallClock(clock, 'inMemoryPersistence');

  const all: Row[] = [];
  const streams = new Map<string, Row[]>();
  const byTag = new Map<string, Row[]>();
  const snapshots = new Map<string, SnapshotRow>();
  const offsets = new Map<string, number>();
  let lastOffset = 0;

  const journal: Journal = {
    async append(persistenceId, expectedSeq, events) {
      // Check and serialize the whole batch before touching the stream, so it's all or none.
      const batch = checkAppend(persistenceId, expectedSeq, events);
      await Promise.resolve();
      const stream = streams.get(persistenceId) ?? [];
      if (stream.length !== expectedSeq) {
        throw new JournalConflictError(persistenceId, expectedSeq);
      }
      if (batch.length === 0) return;
      const timestamp = now();
      for (const { version, tags, json } of batch) {
        const row: Row = {
          persistenceId,
          seq: stream.length + 1,
          offset: ++lastOffset,
          timestamp,
          version,
          tags,
          json,
        };
        stream.push(row);
        all.push(row);
        for (const tag of tags) {
          const rows = byTag.get(tag);
          if (rows === undefined) byTag.set(tag, [row]);
          else rows.push(row);
        }
      }
      streams.set(persistenceId, stream);
    },

    async read(persistenceId, fromSeq, limit) {
      checkRead(persistenceId, fromSeq, limit);
      await Promise.resolve();
      const stream = streams.get(persistenceId) ?? [];
      return stream.slice(fromSeq - 1, fromSeq - 1 + limit).map(toStored);
    },

    async readByTag(tag, afterOffset, limit) {
      checkReadByTag(tag, afterOffset, limit);
      await Promise.resolve();
      const rows = byTag.get(tag) ?? [];
      const start = firstAfter(rows, afterOffset);
      return rows.slice(start, start + limit).map(toStored);
    },
  };

  const snapshotStore: SnapshotStore = {
    async save(persistenceId, snapshot) {
      const { seq, version, json } = serializeSnapshot(persistenceId, snapshot);
      await Promise.resolve();
      const stored = snapshots.get(persistenceId);
      // Saves don't hold the mailbox, so an older one can land after a newer one.
      if (stored !== undefined && stored.seq > seq) return;
      snapshots.set(persistenceId, { seq, version, timestamp: now(), json });
    },

    async load(persistenceId) {
      checkId(persistenceId, 'snapshots.load: persistenceId');
      await Promise.resolve();
      const stored = snapshots.get(persistenceId);
      if (stored === undefined) return undefined;
      const snapshot: Snapshot = {
        seq: stored.seq,
        version: stored.version,
        state: JSON.parse(stored.json),
        timestamp: stored.timestamp,
      };
      return snapshot;
    },
  };

  const offsetStore: OffsetStore = {
    async load(name) {
      checkId(name, 'offsets.load: name');
      await Promise.resolve();
      return offsets.get(name) ?? 0;
    },

    async save(name, offset) {
      checkOffsetSave(name, offset);
      await Promise.resolve();
      offsets.set(name, offset);
    },
  };

  return {
    journal,
    snapshots: snapshotStore,
    offsets: offsetStore,
    events: (persistenceId) =>
      (persistenceId === undefined ? all : (streams.get(persistenceId) ?? [])).map(toStored),
  };
}

/** A fresh copy each time, so nothing a reader holds can change what's stored. */
function toStored(row: Row): StoredEvent {
  return {
    persistenceId: row.persistenceId,
    seq: row.seq,
    offset: row.offset,
    timestamp: row.timestamp,
    version: row.version,
    tags: [...row.tags],
    event: JSON.parse(row.json),
  };
}

/** The index of the first row with an offset above `offset`. Rows are in offset order. */
function firstAfter(rows: readonly Row[], offset: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // mid is within [lo, hi), so the row exists.
    if ((rows[mid] as Row).offset <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
