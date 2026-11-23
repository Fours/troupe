// The Postgres shard store without a database: option checks, the shipped SQL, and the paths a
// real server can't easily be made to take. The contract and the races are in test/integration/.
import { describe, expect, it } from 'vitest';
import { postgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import type { PgPool, PgPoolClient } from '@kylewillett/troupe/persistence/postgres';
import {
  shardStoreSchemaSql,
  shardStoreSchemaStatements,
} from '../../src/cluster/postgres/schema.js';

/** A pool that answers each query from `respond`, and records the first two words of each. */
function fakePool(respond: (text: string) => unknown[] = () => []) {
  const log: string[] = [];
  let connects = 0;
  const run = (text: string) => {
    log.push(text.split(/\s+/).slice(0, 2).join(' '));
    return Promise.resolve({ rows: respond(text) });
  };
  const client: PgPoolClient = { query: (text) => run(text), release: () => {} };
  const pool: PgPool = {
    query: (text) => run(text),
    connect: () => {
      connects += 1;
      return Promise.resolve(client);
    },
  };
  return { pool, log, connects: () => connects };
}

describe('postgresShardStore without a database', () => {
  it('throws TypeError for invalid options, before using the pool', () => {
    const { pool, connects } = fakePool();
    expect(() => postgresShardStore({ pool, sceme: 'x' } as never)).toThrow(
      new TypeError('postgresShardStore: unknown option "sceme"'),
    );
    expect(() => postgresShardStore(null as never)).toThrow(TypeError);
    expect(() => postgresShardStore({} as never)).toThrow(
      new TypeError('postgresShardStore: pool must have query() and connect(), like pg.Pool'),
    );
    for (const schema of ['', 'Troupe', '1st', 'a-b', 'a"b', 'x'.repeat(64), 7]) {
      expect(() => postgresShardStore({ pool, schema } as never)).toThrow(TypeError);
    }
    expect(connects()).toBe(0);
  });

  it('rejects bad arguments before it sends anything', async () => {
    const { pool, log, connects } = fakePool();
    const store = postgresShardStore({ pool });
    await expect(store.acquire('', 'a#1', 100)).rejects.toThrow(TypeError);
    await expect(store.renewAll('a#1', 0)).rejects.toThrow(TypeError);
    await expect(store.release('show/1', 'a#1', 0)).rejects.toThrow(TypeError);
    await expect(store.holders(7 as never)).rejects.toThrow(TypeError);
    await expect(store.remember('show/1', '')).rejects.toThrow(TypeError);
    await expect(store.forget('', 'x')).rejects.toThrow(TypeError);
    await expect(store.remembered('a\u0000')).rejects.toThrow(TypeError);
    expect(log).toEqual([]);
    expect(connects()).toBe(0);
  });

  it('reads tokens however the pool parses bigint', async () => {
    for (const token of ['3', 3, 3n]) {
      const { pool } = fakePool((text) => (text.startsWith('INSERT') ? [{ token }] : []));
      expect(await postgresShardStore({ pool }).acquire('show/1', 'a#1', 100)).toEqual({
        acquired: true,
        token: 3,
      });
    }
  });

  it('tries again when a lease it lost a race for is free by the time it reads the winner', async () => {
    let reads = 0;
    const { pool, log } = fakePool((text) => {
      if (text.startsWith('INSERT')) return reads < 2 ? [] : [{ token: '4' }];
      if (text.startsWith('SELECT holder')) {
        reads += 1;
        // First the row is gone (dropped by hand, say), then it's there but expired.
        return reads === 1 ? [] : [{ holder: 'b#2', live: false }];
      }
      return [];
    });
    expect(await postgresShardStore({ pool }).acquire('show/1', 'a#1', 100)).toEqual({
      acquired: true,
      token: 4,
    });
    expect(log.filter((l) => l.startsWith('INSERT'))).toHaveLength(3);
  });

  it('gives up after a few tries, and reports whoever holds the row', async () => {
    const { pool, log } = fakePool((text) =>
      text.startsWith('SELECT holder') ? [{ holder: 'b#2', live: false }] : [],
    );
    expect(await postgresShardStore({ pool }).acquire('show/1', 'a#1', 100)).toEqual({
      acquired: false,
      holder: 'b#2',
    });
    expect(log.filter((l) => l.startsWith('INSERT'))).toHaveLength(3);
    expect(log.at(-1)).toBe('COMMIT');
  });

  it('runs acquire and renewAll in read-committed transactions, whatever the default', async () => {
    const { pool, log } = fakePool((text) => (text.startsWith('INSERT') ? [{ token: 1 }] : []));
    const store = postgresShardStore({ pool });
    await store.acquire('show/1', 'a#1', 100);
    await store.renewAll('a#1', 100);
    expect(log).toEqual([
      'BEGIN ISOLATION',
      'INSERT INTO',
      'COMMIT',
      'BEGIN ISOLATION',
      'UPDATE "troupe".shard_leases',
      'COMMIT',
    ]);
  });

  it('sorts renewed names by code point, as the in-memory store does', async () => {
    const { pool } = fakePool((text) =>
      text.startsWith('UPDATE') ? [{ name: 'b' }, { name: 'B' }, { name: 'a' }] : [],
    );
    expect(await postgresShardStore({ pool }).renewAll('a#1', 100)).toEqual(['B', 'a', 'b']);
  });

  it('ships its SQL as one script, in the schema it’s given', () => {
    expect(shardStoreSchemaSql('troupe')).toBe(
      `${shardStoreSchemaStatements('troupe').join(';\n\n')};\n`,
    );
    expect(shardStoreSchemaSql('other')).toContain(
      'CREATE TABLE IF NOT EXISTS "other".shard_leases',
    );
    expect(shardStoreSchemaSql('other')).not.toContain('"troupe"');
  });
});
