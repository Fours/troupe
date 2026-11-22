// Postgres for the integration tests: where it is, fresh schemas to keep tests apart, and a pool
// wrapper that holds a COMMIT, so a test can interleave two transactions exactly.
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

/** A held COMMIT: `reached` resolves when a transaction gets to it, and `release` lets it run. */
export interface HeldCommit {
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * Wraps a pool so the test can hold the next transaction's COMMIT. Everything else passes
 * straight through. It works because the backend asks only for the shape of a pool.
 */
export function holdingPool(pool: pg.Pool): { pool: PgPool; holdNextCommit(): HeldCommit } {
  const holds: { reached: () => void; released: Promise<void> }[] = [];
  const wrapClient = (client: pg.PoolClient): PgPoolClient => ({
    async query(text, values) {
      if (text === 'COMMIT') {
        const hold = holds.shift();
        if (hold !== undefined) {
          hold.reached();
          await hold.released;
        }
      }
      return client.query(text, values);
    },
    release: (destroy) => {
      client.release(destroy);
    },
  });
  return {
    pool: {
      query: (text, values) => pool.query(text, values),
      connect: async () => wrapClient(await pool.connect()),
    },
    holdNextCommit() {
      const reached = deferred();
      const released = deferred();
      holds.push({
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
    },
  };
}
