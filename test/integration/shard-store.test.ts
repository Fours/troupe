// Milestone 4, T5: the Postgres shard store against a real server (decision 0029). The contract,
// two pools racing for one lease, a renewal held past the TTL, and setup() run at once.
import { afterAll, describe, expect, it } from 'vitest';
import type { AcquireResult } from '@kylewillett/troupe/cluster';
import { postgresShardStore, type PostgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import { postgresPersistence, type PgPool } from '@kylewillett/troupe/persistence/postgres';
import { shardStoreContract } from '../cluster/shard-store-contract.js';
import { dropSchema, freshSchema, holdingPool, testPool } from '../helpers/postgres.js';

// Two pools, as two nodes would have. Each test gets a schema of its own.
const poolA = testPool({ max: 4 });
const poolB = testPool({ max: 4 });
const schemas: string[] = [];
afterAll(async () => {
  for (const schema of schemas.splice(0)) await dropSchema(poolA, schema);
  await Promise.all([poolA.end(), poolB.end()]);
});

async function fresh(pool: PgPool = poolA, schema = freshSchema()): Promise<PostgresShardStore> {
  if (!schemas.includes(schema)) schemas.push(schema);
  const store = postgresShardStore({ pool, schema });
  await store.setup();
  return store;
}

/** Lets `ms` pass on the database's clock, which is the only one the store reads. */
async function elapse(ms: number): Promise<void> {
  await poolA.query('SELECT pg_sleep($1::double precision / 1000)', [ms]);
}

shardStoreContract('postgres', {
  // Real time passes between round trips, so the contract's times need room: a TTL of 500 ms,
  // checked 200 ms inside it or 50 ms past it.
  unitMs: 50,
  create: async () => ({ store: await fresh(), elapse }),
});

/** Waits until a connection is blocked on a row lock in `schema`'s lease table. */
async function waitingForRowLock(schema: string): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    const { rows } = await poolA.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND position($1 in query) > 0`,
      [`"${schema}".shard_leases`],
    );
    if (rows[0]?.n !== '0') return;
  }
  throw new Error('no connection ever waited for the lease row');
}

describe('postgresShardStore', () => {
  it('never lets two pools racing for one lease both win, free or released', async () => {
    const schema = freshSchema();
    const a = await fresh(poolA, schema);
    const b = await fresh(poolB, schema);
    const won = (results: readonly AcquireResult[]) => results.filter((r) => r.acquired);
    for (let round = 0; round < 200; round++) {
      const lease = `race/${String(round)}`;
      // A free lease: both try to insert the row.
      const first = await Promise.all([
        a.acquire(lease, 'a#1', 10_000),
        b.acquire(lease, 'b#2', 10_000),
      ]);
      expect(won(first), lease).toHaveLength(1);
      const winner = first[0].acquired ? 'a#1' : 'b#2';
      const loser = first.find((r) => !r.acquired);
      expect(loser).toEqual({ acquired: false, holder: winner });
      expect(won(first)[0]).toEqual({ acquired: true, token: 1 });

      // A released lease: both try to update the row.
      await (winner === 'a#1' ? a : b).release(lease, winner, 1);
      const second = await Promise.all([
        a.acquire(lease, 'a#1', 10_000),
        b.acquire(lease, 'b#2', 10_000),
      ]);
      expect(won(second), lease).toHaveLength(1);
      expect(won(second)[0]).toEqual({ acquired: true, token: 2 });
    }
  });

  it('refuses a renewal that reaches it after the TTL on its clock, once the lease has moved', async () => {
    const schema = freshSchema();
    const holding = holdingPool(poolA);
    const a = await fresh(holding.pool, schema);
    const b = await fresh(poolB, schema);
    await a.acquire('show/1', 'a#1', 300);
    // a sends its renewal in time, but it's held on the way, before Postgres sees it.
    const hold = holding.holdNext(
      (text) => text.startsWith('UPDATE') && text.includes('RETURNING name'),
    );
    const renewal = a.renewAll('a#1', 300);
    await hold.reached;
    await elapse(350);
    expect(await b.acquire('show/1', 'b#2', 10_000)).toEqual({ acquired: true, token: 2 });
    hold.release();
    expect(await renewal).toEqual([]);
    expect(await a.holders('show/')).toEqual([{ lease: 'show/1', holder: 'b#2' }]);
  });

  it('gives a lease away once a renewal held at COMMIT past the TTL lets go of its row', async () => {
    const schema = freshSchema();
    const holding = holdingPool(poolA);
    const a = await fresh(holding.pool, schema);
    const b = await fresh(poolB, schema);
    await a.acquire('show/1', 'a#1', 300);
    // The renewal's UPDATE runs, setting the expiry from Postgres's clock now, and its COMMIT is
    // held. b's acquire has to wait for the row.
    const hold = holding.holdNextCommit();
    const renewal = a.renewAll('a#1', 300);
    await hold.reached;
    const taken = b.acquire('show/1', 'b#2', 10_000);
    await waitingForRowLock(schema);
    await elapse(350);
    hold.release();
    // Postgres renewed it, so a hears yes. But the expiry it set is already past on Postgres's
    // clock when b checks again, so b takes the lease. a's own deadline, noted before it sent
    // the renewal, has passed too, so a doesn't treat the yes as its own (leases.test.ts).
    expect(await renewal).toEqual(['show/1']);
    expect(await taken).toEqual({ acquired: true, token: 2 });
    expect(await a.holders('show/')).toEqual([{ lease: 'show/1', holder: 'b#2' }]);
  });

  it('is safe to set up twice at once, alongside the journal on the same schema', async () => {
    // A few schemas, since a race that this lock prevents only sometimes shows.
    for (let i = 0; i < 5; i++) {
      const schema = freshSchema();
      schemas.push(schema);
      const stores = [
        postgresShardStore({ pool: poolA, schema }),
        postgresShardStore({ pool: poolB, schema }),
      ];
      const journals = [
        postgresPersistence({ pool: poolA, schema }),
        postgresPersistence({ pool: poolB, schema }),
      ];
      await Promise.all([...stores, ...journals].map((x) => x.setup()));
      await stores[0]?.acquire('show/1', 'a#1', 10_000);
      await stores[0]?.remember('show/1', 'hamlet');
      await journals[0]?.journal.append('hamlet', 0, [{ event: 1, version: 1, tags: [] }]);
      // In turn, on a schema with data in it, which setup must leave alone.
      for (const x of [...stores, ...journals]) await x.setup();
      expect(await stores[1]?.holders('')).toEqual([{ lease: 'show/1', holder: 'a#1' }]);
      expect(await stores[1]?.remembered('show/1')).toEqual(['hamlet']);
      expect(await journals[1]?.journal.read('hamlet', 1, 10)).toHaveLength(1);
    }
  });

  it('keeps two stores apart in one database with schema', async () => {
    const red = await fresh();
    const blue = await fresh(poolB);
    await red.acquire('show/1', 'a#1', 10_000);
    await blue.remember('show/1', 'lear');
    expect(await blue.holders('')).toEqual([]);
    expect(await blue.acquire('show/1', 'b#2', 10_000)).toEqual({ acquired: true, token: 1 });
    expect(await red.remembered('show/1')).toEqual([]);
  });
});
