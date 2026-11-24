// What both Postgres backends share, never exported from an entry point: the pool's shape, the
// transaction runner, the advisory lock's keys and the integer reader. The journal
// (/persistence/postgres) and the shard store (/cluster/postgres) run on the same pool (0017).
import { describe } from '../../checks.js';
import { fnv1a } from '../../hash.js';

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

// The first key of the schema's advisory lock: "TRUP". The second is the schema's hash, so each
// schema in a database has its own lock. Journal appends take it (decision 0016), and so does
// every setup(), so two backends setting up one schema at once don't race to create it.
export const LOCK_CLASS = 0x54525550;

/** Takes the advisory lock `($1, $2)` until the transaction ends. */
export const LOCK = 'SELECT pg_advisory_xact_lock($1, $2)';

/** Throws unless `pool` has the two methods a {@link PgPool} needs. */
export function checkPool(pool: unknown, where: string): asserts pool is PgPool {
  const ok =
    typeof pool === 'object' &&
    pool !== null &&
    typeof (pool as Partial<PgPool>).query === 'function' &&
    typeof (pool as Partial<PgPool>).connect === 'function';
  if (!ok) {
    throw new TypeError(`${where}: pool must have query() and connect(), like pg.Pool`);
  }
}

/**
 * Runs `work` in a read-committed transaction on one connection. Read committed, whatever the
 * database's default, so each statement sees what committed before it, including while this
 * one waited for a lock. A connection whose rollback fails is discarded, not reused.
 */
export async function transaction<T>(
  pool: PgPool,
  work: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let result: T;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    result = await work(client);
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
  return result;
}

/**
 * A 32-bit FNV-1a hash of `text`, as a signed integer for Postgres's `int4`. Computed here, not by
 * Postgres's undocumented `hashtext`, so every process agrees on it, whatever the server version.
 * A collision only makes two journals share a lock.
 */
export function schemaHash(text: string): number {
  return fnv1a(text) | 0;
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
    throw new TypeError(`Postgres: expected an integer from the database, got ${describe(value)}`);
  }
  return n;
}
