import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  JournalConflictError,
  type NewEvent,
  type StoredEvent,
} from '@kylewillett/troupe/persistence';
import {
  postgresPersistence,
  type PgPool,
  type PostgresPersistence,
} from '@kylewillett/troupe/persistence/postgres';
import { schemaHash } from '../../src/persistence/postgres/postgres.js';
import { journalContract } from '../persistence/contract.js';
import { dropSchema, freshSchema, holdingPool, testPool } from '../helpers/postgres.js';

// Two pools, as two processes would have. Each test gets schemas of its own.
const poolA = testPool({ max: 6 });
const poolB = testPool({ max: 6 });
const schemas: string[] = [];
afterAll(async () => {
  for (const schema of schemas.splice(0)) await dropSchema(poolA, schema);
  await Promise.all([poolA.end(), poolB.end()]);
});

/** A backend on a fresh, set-up schema, dropped after the file. */
async function fresh(
  opts: { pool?: PgPool; schema?: string; clock?: () => number } = {},
): Promise<PostgresPersistence> {
  const schema = opts.schema ?? freshSchema();
  if (!schemas.includes(schema)) schemas.push(schema);
  const p = postgresPersistence({ pool: opts.pool ?? poolA, schema, ...pick(opts) });
  await p.setup();
  return p;
}
const pick = (opts: { clock?: () => number }) => (opts.clock ? { clock: opts.clock } : {});

journalContract('postgres', {
  create: ({ clock }) => fresh({ clock }),
});

const ev = (event: unknown, tags: readonly string[] = []): NewEvent => ({
  event,
  version: 1,
  tags,
});

const seqs = (events: readonly StoredEvent[]) => events.map((e) => e.seq);

describe('postgresPersistence', () => {
  it('is safe to set up twice, in turn and at once', async () => {
    const schema = freshSchema();
    schemas.push(schema);
    const first = postgresPersistence({ pool: poolA, schema });
    const second = postgresPersistence({ pool: poolB, schema });
    // At once: without the lock, two CREATE TABLE IF NOT EXISTS can race and one fails.
    await Promise.all([first.setup(), second.setup()]);
    await first.journal.append('a', 0, [ev(1, ['t'])]);
    // In turn, on a schema that already has data, which setup must leave alone.
    await first.setup();
    await second.setup();
    expect(seqs(await second.journal.read('a', 1, 10))).toEqual([1]);
    expect((await second.journal.readByTag('t', 0, 10)).map((e) => e.event)).toEqual([1]);
  });

  it('keeps two journals apart in one database with schema', async () => {
    const red = await fresh();
    const blue = await fresh({ pool: poolB });
    await red.journal.append('a', 0, [ev('red', ['t'])]);
    await blue.journal.append('a', 0, [ev('blue 1', ['t']), ev('blue 2', ['t'])]);
    await red.snapshots.save('a', { seq: 1, version: 1, state: 'red' });
    await blue.offsets.save('p', 2);

    expect((await red.journal.read('a', 1, 10)).map((e) => e.event)).toEqual(['red']);
    expect((await blue.journal.read('a', 1, 10)).map((e) => e.event)).toEqual(['blue 1', 'blue 2']);
    expect((await red.journal.readByTag('t', 0, 10)).map((e) => e.event)).toEqual(['red']);
    // Each journal has its own offsets, so both start at 1.
    expect((await blue.journal.readByTag('t', 0, 10)).map((e) => e.offset)).toEqual([1, 2]);
    expect(await blue.snapshots.load('a')).toBeUndefined();
    expect(await red.offsets.load('p')).toBe(0);
    await expect(red.journal.append('a', 2, [ev('x')])).rejects.toBeInstanceOf(
      JournalConflictError,
    );
  });

  it('keeps one stream intact when two pools append to it at once, many times', async () => {
    const schema = freshSchema();
    const a = await fresh({ pool: poolA, schema });
    const b = postgresPersistence({ pool: poolB, schema });
    const outcomes: unknown[] = [];
    let wins = 0;

    // Each writer behaves like a persistent actor: it appends after the last seq it knows of,
    // and after a conflict, reads to catch up.
    const writer = async (p: PostgresPersistence, name: string) => {
      let known = 0;
      for (let i = 0; i < 25; i++) {
        try {
          await p.journal.append('show', known, [ev(`${name}-${String(i)}`)]);
          known += 1;
          wins += 1;
          outcomes.push('ok');
        } catch (error) {
          outcomes.push(error);
          known = (await p.journal.read('show', 1, 10_000)).length;
        }
      }
    };
    await Promise.all(
      [a, a, a, b, b, b].map((p, i) => writer(p, `${p === a ? 'a' : 'b'}${String(i)}`)),
    );

    const errors = outcomes.filter((o) => o !== 'ok');
    // There was real contention, and every loss was a conflict, never anything else.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e instanceof JournalConflictError)).toBe(true);
    const stream = await b.journal.read('show', 1, 10_000);
    expect(seqs(stream)).toEqual(stream.map((_, i) => i + 1));
    expect(stream).toHaveLength(wins);
    // No event was written twice.
    expect(new Set(stream.map((e) => e.event)).size).toBe(wins);
    // Every connection went back to its pool.
    expect(poolA.waitingCount + poolB.waitingCount).toBe(0);
    expect(poolA.idleCount).toBe(poolA.totalCount);
    expect(poolB.idleCount).toBe(poolB.totalCount);
  });

  it('commits offsets in order: a later append waits for an earlier one to commit', async () => {
    const schema = freshSchema();
    const held = holdingPool(poolA);
    const first = await fresh({ pool: held.pool, schema });
    const second = postgresPersistence({ pool: poolB, schema });
    const reader = postgresPersistence({ pool: poolB, schema });

    // The first append draws its offset, then stops before COMMIT.
    const hold = held.holdNextCommit();
    const firstDone = first.journal.append('a', 0, [ev('first', ['t'])]);
    await hold.reached;

    // The second append, on another stream and pool, needs no conflict to settle. With the lock,
    // it waits for the first. Without it, it commits a higher offset first.
    const secondDone = second.journal.append('b', 0, [ev('second', ['t'])]);
    const outcome = await Promise.race([
      secondDone.then(() => 'committed' as const),
      waitingForLock(schema).then(() => 'waiting' as const),
    ]);
    const seen = await reader.journal.readByTag('t', 0, 10);
    hold.release();
    await Promise.all([firstDone, secondDone]);

    expect(outcome).toBe('waiting');
    expect(seen).toEqual([]);
    const after = await reader.journal.readByTag('t', 0, 10);
    expect(after.map((e) => e.event)).toEqual(['first', 'second']);
    const [one, two] = after.map((e) => e.offset);
    expect(one).toBeLessThan(two as number);
  });

  it('checks the stream after the lock wait, even when the database defaults to serializable', async () => {
    // Under repeatable read or serializable, a transaction's snapshot is taken before it waits for
    // the lock, so its check would miss what committed meanwhile. The backend asks for read
    // committed whatever the default.
    const strict = testPool({ max: 2, options: '-c default_transaction_isolation=serializable' });
    try {
      const schema = freshSchema();
      const held = holdingPool(poolA);
      const first = await fresh({ pool: held.pool, schema });
      const second = postgresPersistence({ pool: strict, schema });

      const hold = held.holdNextCommit();
      const firstDone = first.journal.append('a', 0, [ev('first')]);
      await hold.reached;
      // Appends after the first one's event, which hasn't committed yet: it must wait, then win.
      const secondDone = second.journal.append('a', 1, [ev('second')]);
      await waitingForLock(schema);
      hold.release();
      await Promise.all([firstDone, secondDone]);

      expect((await first.journal.read('a', 1, 10)).map((e) => e.event)).toEqual([
        'first',
        'second',
      ]);
    } finally {
      await strict.end();
    }
  });

  it('never shows a follower an offset lower than one it has seen, under load', async () => {
    const schema = freshSchema();
    const a = await fresh({ pool: poolA, schema });
    const b = postgresPersistence({ pool: poolB, schema });
    const reader = postgresPersistence({ pool: poolB, schema });

    // An object, so TypeScript doesn't narrow the flag the writers clear to always true.
    const state = { writing: true };
    const writer = async (p: PostgresPersistence, stream: string) => {
      let seq = 0;
      for (let i = 0; i < 20; i++) {
        const batch = i % 3 === 0 ? [ev(i, ['all']), ev(i, ['all'])] : [ev(i, ['all'])];
        await p.journal.append(stream, seq, batch);
        seq += batch.length;
      }
    };
    const writers = Promise.all(
      [a, a, a, a, b, b, b, b].map((p, i) => writer(p, `stream-${String(i)}`)),
    ).finally(() => {
      state.writing = false;
    });

    // Reads the whole tag each time, so an event that commits below what was seen shows up.
    let seen = new Set<number>();
    let highest = 0;
    const late: number[] = [];
    let polls = 0;
    const poll = async () => {
      const now = (await reader.journal.readByTag('all', 0, 100_000)).map((e) => e.offset);
      for (const offset of now) if (!seen.has(offset) && offset < highest) late.push(offset);
      seen = new Set(now);
      highest = Math.max(highest, ...now);
      polls += 1;
    };
    while (state.writing) await poll();
    await writers;
    // Once more, since the last poll may have started before the last commit.
    await poll();

    expect(late).toEqual([]);
    expect(seen.size).toBe(8 * (20 + 7));
    // The follower read many times while the writers were busy, or the check means nothing.
    expect(polls).toBeGreaterThan(10);
  });

  it('works with a pool that parses bigints and json itself', async () => {
    // A pool whose type parsers turn int8 into BigInt, json into objects, and leave everything
    // else as text. The backend casts json to text and accepts any integer form, so it doesn't
    // care.
    const parsing = testPool({
      max: 2,
      types: {
        getTypeParser: ((oid: number) => {
          if (oid === 20) return (text: string) => BigInt(text);
          if (oid === 114) return (text: string) => JSON.parse(text) as unknown;
          return (text: string) => text;
        }) as typeof pg.types.getTypeParser,
      },
    });
    try {
      const p = await fresh({ pool: parsing, clock: () => 7 });
      await p.journal.append('a', 0, [ev({ n: 1 }, ['t'])]);
      await p.snapshots.save('a', { seq: 1, version: 2, state: { n: 1 } });
      await p.offsets.save('x', 3);
      expect(await p.journal.read('a', 1, 1)).toEqual([
        {
          persistenceId: 'a',
          seq: 1,
          offset: 1,
          timestamp: 7,
          version: 1,
          tags: ['t'],
          event: { n: 1 },
        },
      ]);
      expect(await p.snapshots.load('a')).toEqual({
        seq: 1,
        version: 2,
        state: { n: 1 },
        timestamp: 7,
      });
      expect(await p.offsets.load('x')).toBe(3);
    } finally {
      await parsing.end();
    }
  });

  it('accepts an empty batch at the right expectedSeq, and writes nothing', async () => {
    const p = await fresh();
    await p.journal.append('a', 0, []);
    await p.journal.append('a', 0, [ev(1)]);
    await expect(p.journal.append('a', 0, [])).rejects.toBeInstanceOf(JournalConflictError);
    expect(seqs(await p.journal.read('a', 1, 10))).toEqual([1]);
  });

  it('stamps events with Date.now by default', async () => {
    const p = await fresh();
    const before = Date.now();
    await p.journal.append('a', 0, [ev(1)]);
    const after = Date.now();
    const [event] = await p.journal.read('a', 1, 1);
    expect(event?.timestamp).toBeGreaterThanOrEqual(before);
    expect(event?.timestamp).toBeLessThanOrEqual(after);
  });

  it('rejects calls before setup with the database’s error', async () => {
    const p = postgresPersistence({ pool: poolA, schema: freshSchema() });
    await expect(p.journal.read('a', 1, 1)).rejects.toThrow(/does not exist/);
    await expect(p.journal.append('a', 0, [ev(1)])).rejects.toThrow(/does not exist/);
  });

  it('rejects invalid arguments with TypeError, before touching the database', async () => {
    const { journal, snapshots, offsets } = await fresh();
    const calls: Promise<unknown>[] = [
      journal.append('', 0, []),
      journal.append('a', -1, []),
      journal.append('a', 0, [{ event: 1, version: 1, tags: ['a\u0000b'] }]),
      journal.read('a\u0000', 1, 1),
      journal.read('a', 1, 0),
      journal.readByTag('\ud800', 0, 1),
      snapshots.save('a', null as never),
      snapshots.load(''),
      offsets.save('x', 1.5),
      offsets.load(''),
    ];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(TypeError);
  });
});

/** Resolves once some connection is waiting for `schema`'s journal lock. */
async function waitingForLock(schema: string): Promise<void> {
  // The two-key form of an advisory lock shows its keys as classid and objid, as unsigned oids.
  const objid = schemaHash(schema) >>> 0;
  for (let i = 0; i < 5_000; i++) {
    const { rows } = await poolA.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
         AND classid = $1::bigint::oid AND objid = $2::bigint::oid AND objsubid = 2`,
      [0x54525550, objid],
    );
    if (rows[0]?.n !== '0') return;
  }
  throw new Error('no connection ever waited for the journal lock');
}
