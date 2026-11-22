import { checkKeys, describe } from '../../checks.js';
import {
  checkAppend,
  checkId,
  checkOffsetSave,
  checkRead,
  checkReadByTag,
  serializeSnapshot,
  wallClock,
} from '../backend.js';
import { JournalConflictError } from '../errors.js';
import type {
  Journal,
  OffsetStore,
  Persistence,
  Snapshot,
  SnapshotStore,
  StoredEvent,
} from '../types.js';
import { DEFAULT_SCHEMA, isSchemaName, postgresSchemaStatements } from './schema.js';

/**
 * Something that runs a parameterized query, as `pg`'s pool and clients do. Only `rows` is read.
 */
export interface PgQueryable {
  /** Runs `text` with `$1`, `$2`, ... bound to `values`. */
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

/** One connection checked out of a {@link PgPool}, as `pg`'s `PoolClient` is. */
export interface PgPoolClient extends PgQueryable {
  /** Returns the connection to the pool, or with `true` or an error, discards it. */
  release(destroy?: boolean | Error): void;
}

/**
 * A pool of Postgres connections, typed by shape so this entry point never imports `pg`
 * (decision 0017). A `pg` `Pool` fits, and so does any pool with the same two methods.
 */
export interface PgPool extends PgQueryable {
  /** Checks out one connection, for a transaction. */
  connect(): Promise<PgPoolClient>;
}

/** The Postgres backend's stores, which share the caller's pool. */
export interface PostgresPersistence extends Required<Persistence> {
  /**
   * Creates the schema and tables if they're missing. Safe to run on every start, and from
   * several processes at once. Skip it if you manage migrations yourself: the SQL ships as
   * `dist/persistence/postgres/schema.sql`.
   */
  setup(): Promise<void>;
}

const OPTIONS = new Set(['pool', 'schema', 'clock']);

// The first key of the journal's advisory lock: "TRUP". The second is the schema's hash, so each
// journal in a database has its own lock.
const LOCK_CLASS = 0x54525550;

// Postgres's SQLSTATE for a unique violation.
const UNIQUE_VIOLATION = '23505';

interface EventRow {
  readonly persistence_id: string;
  readonly seq: unknown;
  readonly global_offset: unknown;
  readonly timestamp: unknown;
  readonly version: unknown;
  readonly tags: string;
  readonly event: string;
}

interface SnapshotRow {
  readonly seq: unknown;
  readonly version: unknown;
  readonly timestamp: unknown;
  readonly state: string;
}

/**
 * A backend on Postgres, through the caller's own `pg`-compatible pool, so it adds no dependency
 * and runs wherever the pool does. Tables live in `schema`, so two journals can share a database.
 * Call `setup()` once to create them, or create them yourself.
 *
 * An append runs in a transaction that takes a journal-wide advisory lock, then checks the
 * stream's last sequence number. Two writers, in one process or several, can't both win, and the
 * loser rejects with `JournalConflictError`. The lock also makes offsets commit in order, so a
 * projection never misses an event (decision 0016). It serializes every append in the journal.
 *
 * Events and states are stored as `json`, so they come back deep-equal to what went in, and
 * reads parse the text themselves, so the pool's type parsers don't matter.
 *
 * @param opts.pool The pool to run on. The backend never ends it.
 * @param opts.schema The schema for the tables: lower-case letters, digits and `_`. Default
 *   `troupe`.
 * @param opts.clock The wall clock for timestamps, in integer ms. Defaults to `Date.now`.
 */
export function postgresPersistence(opts: {
  pool: PgPool;
  schema?: string;
  clock?: () => number;
}): PostgresPersistence {
  checkKeys(opts, OPTIONS, 'postgresPersistence');
  // The default wall clock for timestamps, which never order anything (decision 0015).
  // eslint-disable-next-line no-restricted-properties
  const { pool, schema = DEFAULT_SCHEMA, clock = Date.now } = opts;
  checkPool(pool);
  if (!isSchemaName(schema)) {
    throw new TypeError(
      'postgresPersistence: schema must be lower-case letters, digits and _, starting with a ' +
        `letter or _, at most 63, got ${describe(schema)}`,
    );
  }
  const now = wallClock(clock, 'postgresPersistence');
  const s = `"${schema}"`;
  const lockKey = schemaHash(schema);

  const COLUMNS =
    'e.persistence_id, e.seq, e.global_offset, e.timestamp, e.version, ' +
    'e.tags::text AS tags, e.event::text AS event';
  const LOCK = 'SELECT pg_advisory_xact_lock($1, $2)';
  const LAST_SEQ = `SELECT COALESCE(MAX(seq), 0) AS seq FROM ${s}.events WHERE persistence_id = $1`;
  // One statement for the whole batch, so the lock is held for as few round trips as possible.
  // ORDER BY n draws the batch's offsets in its order.
  const INSERT = `WITH inserted AS (
      INSERT INTO ${s}.events (persistence_id, seq, version, timestamp, event, tags)
      SELECT $1, $2::bigint + b.n, b.version, $3, b.event::json, b.tags::json
      FROM unnest($4::bigint[], $5::text[], $6::text[]) WITH ORDINALITY AS b(version, event, tags, n)
      ORDER BY b.n
      RETURNING global_offset, tags
    )
    INSERT INTO ${s}.event_tags (tag, global_offset)
    SELECT json_array_elements_text(tags), global_offset FROM inserted`;
  const READ = `SELECT ${COLUMNS} FROM ${s}.events e
    WHERE e.persistence_id = $1 AND e.seq >= $2 ORDER BY e.seq LIMIT $3`;
  const READ_TAG = `SELECT ${COLUMNS} FROM ${s}.event_tags t
    JOIN ${s}.events e ON e.global_offset = t.global_offset
    WHERE t.tag = $1 AND t.global_offset > $2 ORDER BY t.global_offset LIMIT $3`;
  // Saves don't hold the mailbox, so an older one can land after a newer one: keep the higher seq.
  const SAVE_SNAPSHOT = `INSERT INTO ${s}.snapshots (persistence_id, seq, version, timestamp, state)
    VALUES ($1, $2, $3, $4, $5::json) ON CONFLICT (persistence_id) DO UPDATE SET
    seq = excluded.seq, version = excluded.version, timestamp = excluded.timestamp,
    state = excluded.state WHERE excluded.seq >= ${s}.snapshots.seq`;
  const LOAD_SNAPSHOT = `SELECT seq, version, timestamp, state::text AS state
    FROM ${s}.snapshots WHERE persistence_id = $1`;
  const LOAD_OFFSET = `SELECT global_offset FROM ${s}.offsets WHERE name = $1`;
  const SAVE_OFFSET = `INSERT INTO ${s}.offsets (name, global_offset) VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET global_offset = excluded.global_offset`;

  /**
   * Runs `work` in a read-committed transaction on one connection. Read committed, whatever the
   * database's default, so each statement sees what committed before it, including while this
   * one waited for the lock. A connection whose rollback fails is discarded, not reused.
   */
  async function transaction(work: (client: PgPoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      const rolledBack = await client.query('ROLLBACK').then(
        () => true,
        () => false,
      );
      client.release(!rolledBack);
      throw error;
    }
    client.release();
  }

  /** Runs one query on the pool, and returns its rows. */
  async function rows<T>(text: string, values: unknown[]): Promise<T[]> {
    const result = await pool.query(text, values);
    return result.rows as T[];
  }

  const journal: Journal = {
    async append(persistenceId, expectedSeq, events) {
      // Check and serialize the whole batch before the transaction, so it's all or none.
      const batch = checkAppend(persistenceId, expectedSeq, events);
      const timestamp = batch.length === 0 ? 0 : now();
      try {
        await transaction(async (client) => {
          await client.query(LOCK, [LOCK_CLASS, lockKey]);
          // The check runs under the lock, so no other writer can append between it and the
          // insert. This also rejects an expectedSeq ahead of the stream.
          const [last] = (await client.query(LAST_SEQ, [persistenceId])).rows as { seq: unknown }[];
          if (toInt(last?.seq) !== expectedSeq) {
            throw new JournalConflictError(persistenceId, expectedSeq);
          }
          if (batch.length === 0) return;
          await client.query(INSERT, [
            persistenceId,
            expectedSeq,
            timestamp,
            batch.map((e) => e.version),
            batch.map((e) => e.json),
            batch.map((e) => JSON.stringify(e.tags)),
          ]);
        });
      } catch (error) {
        // The lock settles every race, so this is a backstop: the unique key on
        // (persistence_id, seq) still says the stream already has that event.
        if (isUniqueViolation(error)) throw new JournalConflictError(persistenceId, expectedSeq);
        throw error;
      }
    },

    async read(persistenceId, fromSeq, limit) {
      checkRead(persistenceId, fromSeq, limit);
      return (await rows<EventRow>(READ, [persistenceId, fromSeq, limit])).map(toStored);
    },

    async readByTag(tag, afterOffset, limit) {
      checkReadByTag(tag, afterOffset, limit);
      return (await rows<EventRow>(READ_TAG, [tag, afterOffset, limit])).map(toStored);
    },
  };

  const snapshots: SnapshotStore = {
    async save(persistenceId, snapshot) {
      const { seq, version, json } = serializeSnapshot(persistenceId, snapshot);
      await pool.query(SAVE_SNAPSHOT, [persistenceId, seq, version, now(), json]);
    },

    async load(persistenceId) {
      checkId(persistenceId, 'snapshots.load: persistenceId');
      const [row] = await rows<SnapshotRow>(LOAD_SNAPSHOT, [persistenceId]);
      if (row === undefined) return undefined;
      const loaded: Snapshot = {
        seq: toInt(row.seq),
        version: toInt(row.version),
        state: JSON.parse(row.state),
        timestamp: toInt(row.timestamp),
      };
      return loaded;
    },
  };

  const offsets: OffsetStore = {
    async load(name) {
      checkId(name, 'offsets.load: name');
      const [row] = await rows<{ global_offset: unknown }>(LOAD_OFFSET, [name]);
      return row === undefined ? 0 : toInt(row.global_offset);
    },

    async save(name, offset) {
      checkOffsetSave(name, offset);
      await pool.query(SAVE_OFFSET, [name, offset]);
    },
  };

  return {
    journal,
    snapshots,
    offsets,
    async setup() {
      // Under the journal's lock, so two processes starting at once don't race to create the
      // same table, which IF NOT EXISTS alone doesn't prevent.
      await transaction(async (client) => {
        await client.query(LOCK, [LOCK_CLASS, lockKey]);
        for (const statement of postgresSchemaStatements(schema)) await client.query(statement);
      });
    },
  };
}

function checkPool(pool: unknown): void {
  const ok =
    typeof pool === 'object' &&
    pool !== null &&
    typeof (pool as Partial<PgPool>).query === 'function' &&
    typeof (pool as Partial<PgPool>).connect === 'function';
  if (!ok) {
    throw new TypeError('postgresPersistence: pool must have query() and connect(), like pg.Pool');
  }
}

/**
 * A 32-bit FNV-1a hash of `text`, as a signed integer for Postgres's `int4`. Computed here, not by
 * Postgres's undocumented `hashtext`, so every process agrees on it, whatever the server version.
 * A collision only makes two journals share a lock.
 */
export function schemaHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * A `bigint` column as a JavaScript number. `pg` returns them as strings by default, and other
 * pools may parse them as numbers or bigints. The journal only stores safe integers.
 */
export function toInt(value: unknown): number {
  const n =
    typeof value === 'string' || typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN;
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(
      `postgresPersistence: expected an integer from the database, got ${describe(value)}`,
    );
  }
  return n;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

function toStored(row: EventRow): StoredEvent {
  return {
    persistenceId: row.persistence_id,
    seq: toInt(row.seq),
    offset: toInt(row.global_offset),
    timestamp: toInt(row.timestamp),
    version: toInt(row.version),
    tags: JSON.parse(row.tags) as string[],
    event: JSON.parse(row.event),
  };
}
