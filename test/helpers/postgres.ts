// Postgres for the integration tests: where it is, fresh schemas to keep tests apart, and a pool
// wrapper that holds a COMMIT or any other statement, so a test can interleave two calls exactly.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PgPool, PgPoolClient } from '@kylewillett/troupe/persistence/postgres';
import { deferred } from './deferred.js';

/** The test database from docker-compose.test.yml. */
export const DEFAULT_POSTGRES_URL = 'postgres://troupe:troupe@localhost:5440/troupe';

/**
 * The integration tests' database: `TROUPE_POSTGRES_URL`, or the compose database. In CI the
 * variable is required, so a misconfigured run fails instead of skipping or reaching some other
 * database.
 */
export function postgresUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env['TROUPE_POSTGRES_URL'];
  if (url !== undefined && url !== '') return url;
  const ci = env['CI'];
  if (ci !== undefined && ci !== '' && ci !== 'false') {
    throw new Error(
      'TROUPE_POSTGRES_URL must be set when CI is set: the integration tests need a database, ' +
        'and fail rather than skip without one.',
    );
  }
  return DEFAULT_POSTGRES_URL;
}

/** A pool on the test database. The caller ends it. */
export function testPool(opts: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({
    connectionString: postgresUrl(process.env),
    connectionTimeoutMillis: 5_000,
    ...opts,
  });
}

/** A schema name no other test uses. */
export function freshSchema(): string {
  return `troupe_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Drops a test schema and everything in it. */
export async function dropSchema(pool: PgPool, schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/** A held statement: `reached` resolves when a query gets to it, and `release` sends it on. */
export interface HeldCommit {
  readonly reached: Promise<void>;
  release(): void;
}

/** A pool whose next matching statement the test can hold before it reaches the server. */
export interface HoldingPool {
  readonly pool: PgPool;
  /** Holds the next transaction's COMMIT, after everything before it has run. */
  holdNextCommit(): HeldCommit;
  /** Holds the next statement, on the pool or a checked-out client, for which `match` is true. */
  holdNext(match: (text: string) => boolean): HeldCommit;
}

/**
 * Wraps a pool so the test can hold a statement before it's sent: the next transaction's COMMIT,
 * or any statement it picks. Everything else passes straight through. It works because the
 * backends ask only for the shape of a pool.
 */
export function holdingPool(pool: pg.Pool): HoldingPool {
  const holds: {
    match: (text: string) => boolean;
    reached: () => void;
    released: Promise<void>;
  }[] = [];
  const wait = async (text: string): Promise<void> => {
    const i = holds.findIndex((hold) => hold.match(text));
    if (i === -1) return;
    const [hold] = holds.splice(i, 1);
    hold?.reached();
    await hold?.released;
  };
  const wrapClient = (client: pg.PoolClient): PgPoolClient => ({
    async query(text, values) {
      await wait(text);
      return client.query(text, values);
    },
    release: (destroy) => {
      client.release(destroy);
    },
  });
  const holdNext = (match: (text: string) => boolean): HeldCommit => {
    const reached = deferred();
    const released = deferred();
    holds.push({
      match,
      reached: () => {
        reached.resolve();
      },
      released: released.promise,
    });
    return {
      reached: reached.promise,
      release: () => {
        released.resolve();
      },
    };
  };
  return {
    pool: {
      query: async (text, values) => {
        await wait(text);
        return pool.query(text, values);
      },
      connect: async () => wrapClient(await pool.connect()),
    },
    holdNextCommit: () => holdNext((text) => text === 'COMMIT'),
    holdNext,
  };
}
