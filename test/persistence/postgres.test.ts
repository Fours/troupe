// The Postgres backend without a database: option checks, typing, and the paths a real server
// can't easily be made to take. The contract and concurrency tests are in test/integration/.
import type pg from 'pg';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { JournalConflictError } from '@kylewillett/troupe/persistence';
import {
  postgresPersistence,
  type PgPool,
  type PgPoolClient,
} from '@kylewillett/troupe/persistence/postgres';
import { schemaHash, toInt } from '../../src/persistence/postgres/pool.js';
import { isSchemaName, postgresSchemaSql } from '../../src/persistence/postgres/schema.js';
import { DEFAULT_POSTGRES_URL, postgresUrl } from '../helpers/postgres.js';

/** A pool that records every query, and answers or fails as `respond` says. */
function fakePool(respond: (text: string) => unknown = () => ({ rows: [] })) {
  const log: string[] = [];
  const released: (boolean | Error | undefined)[] = [];
  let connects = 0;
  const run = (text: string) => {
    log.push(text.split(/\s+/).slice(0, 2).join(' '));
    // A throw from respond becomes a rejection, as a driver's would.
    return new Promise<{ rows: unknown[] }>((resolve) => {
      resolve(respond(text) as { rows: unknown[] });
    });
  };
  const client: PgPoolClient = {
    query: (text) => run(text),
    release: (destroy) => {
      released.push(destroy);
    },
  };
  const pool: PgPool = {
    query: (text) => run(text),
    connect: () => {
      connects += 1;
      return Promise.resolve(client);
    },
  };
  return { pool, log, released, connects: () => connects };
}

const ev = { event: 1, version: 1, tags: [] };

describe('postgresPersistence without a database', () => {
  it('throws TypeError for invalid options, before using the pool', () => {
    const { pool, connects } = fakePool();
    expect(() => postgresPersistence({ pool, sceme: 'x' } as never)).toThrow(
      new TypeError('postgresPersistence: unknown option "sceme"'),
    );
    expect(() => postgresPersistence(null as never)).toThrow(TypeError);
    expect(() => postgresPersistence({} as never)).toThrow(TypeError);
    expect(() => postgresPersistence({ pool: { query: () => 1 } } as never)).toThrow(
      new TypeError('postgresPersistence: pool must have query() and connect(), like pg.Pool'),
    );
    for (const schema of ['', 'Troupe', '1st', 'a-b', 'a b', 'a"b', 'x'.repeat(64), 7]) {
      expect(() => postgresPersistence({ pool, schema } as never)).toThrow(TypeError);
    }
    expect(() => postgresPersistence({ pool, clock: 5 } as never)).toThrow(TypeError);
    expect(connects()).toBe(0);
  });

  it('accepts schema names Postgres keeps as they are', () => {
    for (const name of ['troupe', '_x', 'a1_b2', 'x'.repeat(63)])
      expect(isSchemaName(name)).toBe(true);
    expect(postgresSchemaSql('shop')).toContain('CREATE TABLE IF NOT EXISTS "shop".events');
    expect(postgresSchemaSql()).toContain('CREATE SCHEMA IF NOT EXISTS "troupe"');
  });

  it('runs an append in a read-committed transaction that takes the lock before the check', async () => {
    const { pool, log, released } = fakePool((text) =>
      text.includes('MAX(seq)') ? { rows: [{ seq: '0' }] } : { rows: [] },
    );
    await postgresPersistence({ pool, clock: () => 1 }).journal.append('a', 0, [ev]);
    expect(log).toEqual([
      'BEGIN ISOLATION',
      'SELECT pg_advisory_xact_lock($1,',
      'SELECT COALESCE(MAX(seq),',
      'WITH inserted',
      'COMMIT',
    ]);
    expect(released).toEqual([undefined]);
  });

  it('turns a unique violation into JournalConflictError, as a backstop to the check', async () => {
    const { pool, log, released } = fakePool((text) => {
      if (text.includes('MAX(seq)')) return { rows: [{ seq: 0 }] };
      if (text.startsWith('WITH'))
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { rows: [] };
    });
    const append = postgresPersistence({ pool, clock: () => 1 }).journal.append('a', 0, [ev]);
    await expect(append).rejects.toBeInstanceOf(JournalConflictError);
    await expect(append).rejects.toMatchObject({ persistenceId: 'a', expectedSeq: 0 });
    expect(log.at(-1)).toBe('ROLLBACK');
    // The rollback worked, so the connection goes back to the pool.
    expect(released).toEqual([false]);
  });

  it('discards a connection whose rollback fails, and rejects with the first error', async () => {
    const lost = new Error('connection lost');
    const { pool, released } = fakePool((text) => {
      if (text.startsWith('BEGIN')) return { rows: [] };
      throw lost;
    });
    await expect(postgresPersistence({ pool }).journal.append('a', 0, [ev])).rejects.toBe(lost);
    expect(released).toEqual([true]);
  });

  it('writes nothing and opens no transaction when the clock fails', async () => {
    const { pool, connects } = fakePool();
    const append = postgresPersistence({ pool, clock: () => 1.5 }).journal.append('a', 0, [ev]);
    await expect(append).rejects.toThrow(
      'postgresPersistence: clock() must be a non-negative integer, got 1.5',
    );
    expect(connects()).toBe(0);
  });

  it('reads integers in any form a pool parses them to, and rejects anything else', async () => {
    expect([toInt('42'), toInt(42), toInt(42n), toInt('9007199254740991')]).toEqual([
      42,
      42,
      42,
      Number.MAX_SAFE_INTEGER,
    ]);
    for (const bad of ['9007199254740992', '1.5', 'x', null, undefined, {}]) {
      expect(() => toInt(bad)).toThrow(TypeError);
    }
    const { pool } = fakePool(() => ({ rows: [{ global_offset: 'nope' }] }));
    await expect(postgresPersistence({ pool }).offsets.load('x')).rejects.toThrow(TypeError);
  });

  it('gives each schema its own lock key, the same in every process', () => {
    expect(schemaHash('troupe')).toBe(schemaHash('troupe'));
    expect(schemaHash('troupe')).not.toBe(schemaHash('troupe_b'));
    // FNV-1a's published test vectors, as signed 32-bit integers.
    expect(schemaHash('') >>> 0).toBe(0x811c9dc5);
    expect(schemaHash('a') >>> 0).toBe(0xe40c292c);
    expect(schemaHash('foobar') >>> 0).toBe(0xbf9cf968);
    expect(Number.isSafeInteger(schemaHash('x'.repeat(63)))).toBe(true);
    expect(Math.abs(schemaHash('troupe'))).toBeLessThan(2 ** 31 + 1);
  });

  it('types a pg Pool and PoolClient as a PgPool and PgPoolClient', () => {
    expectTypeOf<pg.Pool>().toExtend<PgPool>();
    expectTypeOf<pg.PoolClient>().toExtend<PgPoolClient>();
  });
});

describe('the integration tests’ database URL', () => {
  it('is TROUPE_POSTGRES_URL when set, CI or not', () => {
    const url = 'postgres://u:p@db:5432/x';
    expect(postgresUrl({ TROUPE_POSTGRES_URL: url })).toBe(url);
    expect(postgresUrl({ TROUPE_POSTGRES_URL: url, CI: 'true' })).toBe(url);
  });

  it('defaults to the compose database outside CI', () => {
    expect(postgresUrl({})).toBe(DEFAULT_POSTGRES_URL);
    expect(postgresUrl({ CI: '', TROUPE_POSTGRES_URL: '' })).toBe(DEFAULT_POSTGRES_URL);
    expect(postgresUrl({ CI: 'false' })).toBe(DEFAULT_POSTGRES_URL);
  });

  it('fails, rather than skipping, when CI is set and TROUPE_POSTGRES_URL isn’t', () => {
    expect(() => postgresUrl({ CI: 'true' })).toThrow(/TROUPE_POSTGRES_URL must be set/);
    expect(() => postgresUrl({ CI: '1', TROUPE_POSTGRES_URL: '' })).toThrow(
      /TROUPE_POSTGRES_URL must be set/,
    );
  });
});
