// The scenarios' own guards. The scenarios themselves run on real time, so they're exercised by
// `npm run bench -- --quick` in CI, not here (the tests use virtual time only).
import { describe, expect, it } from 'vitest';
import { check, lockSwitch, param, scenarios } from '../../bench/scenarios.ts';
import type { PgPool } from '@kylewillett/troupe/persistence/postgres';

describe('param', () => {
  it('reads a non-negative integer', () => {
    expect(param({ messages: 10 }, 'messages')).toBe(10);
    expect(param({ actors: 0 }, 'actors')).toBe(0);
  });

  it('refuses a missing or unusable value, so a misspelt size fails', () => {
    expect(() => param({ messages: 10 }, 'mesages')).toThrow(TypeError);
    expect(() => param({ n: 1.5 }, 'n')).toThrow(TypeError);
    expect(() => param({ n: -1 }, 'n')).toThrow(TypeError);
  });
});

describe('check', () => {
  it('throws unless the work happened', () => {
    expect(() => {
      check('replies', 10, 10);
    }).not.toThrow();
    expect(() => {
      check('replies', 9, 10);
    }).toThrow('replies: expected 10, got 9');
  });
});

describe('lockSwitch', () => {
  function fakePool() {
    const seen: string[] = [];
    let released = 0;
    const pool: PgPool = {
      query: (text) => {
        seen.push(`pool: ${text}`);
        return Promise.resolve({ rows: [] });
      },
      connect: () =>
        Promise.resolve({
          query: (text: string) => {
            seen.push(`client: ${text}`);
            return Promise.resolve({ rows: [{ ok: true }] });
          },
          release: () => {
            released += 1;
          },
        }),
    };
    return { pool, seen, released: () => released };
  }

  it('skips only the advisory lock when the lock is off', async () => {
    const { pool, seen, released } = fakePool();
    const client = await lockSwitch(pool, false).connect();
    expect((await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1, 2])).rows).toEqual([]);
    await client.query('SELECT 1');
    client.release();
    expect(seen).toEqual(['client: SELECT 1']);
    expect(released()).toBe(1);
  });

  it('passes everything through when the lock is on', async () => {
    const { pool, seen } = fakePool();
    const wrapped = lockSwitch(pool, true);
    const client = await wrapped.connect();
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1, 2]);
    await wrapped.query('SELECT 2');
    expect(seen).toEqual(['client: SELECT pg_advisory_xact_lock($1, $2)', 'pool: SELECT 2']);
  });
});

describe('scenarios', () => {
  const all = scenarios({
    tmpDir: '/nonexistent',
    pool: () => {
      throw new Error('no pool in unit tests');
    },
  });

  it('covers every row of the spec table', () => {
    expect(new Set(all.map((s) => s.group))).toEqual(
      new Set([
        'Ping-pong',
        'Ask',
        'Fan-out',
        'Spawn and stop',
        'Message events',
        'Journal appends',
      ]),
    );
    expect(all.map((s) => s.name)).toEqual([
      'ping-pong',
      'ping-pong-noyield',
      'ask',
      'fan-out',
      'fan-out-noyield',
      'spawn-stop',
      'events-none',
      'events-plain',
      'events-messages',
      'journal-memory-1',
      'journal-memory-100',
      'journal-sqlite-1',
      'journal-sqlite-100',
      'journal-postgres-1',
      'journal-postgres-100',
      'journal-postgres-100-nolock',
    ]);
  });

  it('runs the spec sizes in full', () => {
    const size = (name: string) => all.find((s) => s.name === name)?.full;
    expect(size('ping-pong')).toEqual({ messages: 1_000_000 });
    expect(size('ask')).toEqual({ asks: 100_000 });
    expect(size('fan-out')).toEqual({ children: 10_000, rounds: 100 });
    expect(size('spawn-stop')).toEqual({ actors: 10_000 });
    expect(size('journal-postgres-100')).toMatchObject({ streams: 100 });
  });

  it('gives --quick only the in-memory scenarios', () => {
    const quick = all.filter((s) => s.quick !== undefined).map((s) => s.name);
    expect(quick.some((n) => n.includes('sqlite') || n.includes('postgres'))).toBe(false);
    expect(quick).toContain('journal-memory-100');
    expect(quick).toHaveLength(11);
  });
});
