import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JournalConflictError,
  projection,
  type NewEvent,
  type StoredEvent,
} from '@kylewillett/troupe/persistence';
import { sqlitePersistence, type SqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { createTestKit } from '@kylewillett/troupe/testkit';
import { journalContract } from '../persistence/contract.js';

/** A fresh directory per call, removed after each test. */
const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'troupe-sqlite-'));
  dirs.push(dir);
  return join(dir, 'journal.db');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const close = (p: object) => {
  (p as SqlitePersistence).close();
};

journalContract('sqlite :memory:', {
  create: ({ clock }) => sqlitePersistence({ path: ':memory:', clock }),
  dispose: close,
});

journalContract('sqlite file', {
  create: ({ clock }) => sqlitePersistence({ path: tempFile(), clock }),
  dispose: close,
});

const ev = (event: unknown, tags: readonly string[] = []): NewEvent => ({
  event,
  version: 1,
  tags,
});

const summary = (events: readonly StoredEvent[]) =>
  events.map((e) => [e.persistenceId, e.seq, e.event]);

describe('sqlitePersistence', () => {
  it('uses WAL mode for a file database', () => {
    const path = tempFile();
    const p = sqlitePersistence({ path });
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      raw.close();
      p.close();
    }
  });

  it('keeps one stream intact across two instances on one file, and rejects the stale one', async () => {
    const path = tempFile();
    const first = sqlitePersistence({ path, clock: () => 1 });
    const second = sqlitePersistence({ path, clock: () => 2 });
    try {
      // Both writers start out believing the stream is empty.
      await first.journal.append('show', 0, [ev('held', ['shows']), ev('confirmed', ['shows'])]);
      const stale = second.journal.append('show', 0, [ev('held by second', ['shows'])]);
      await expect(stale).rejects.toBeInstanceOf(JournalConflictError);
      await expect(stale).rejects.toMatchObject({ persistenceId: 'show', expectedSeq: 0 });

      // The loser recovers by reading, then appends after what it found.
      expect(summary(await second.journal.read('show', 1, 10))).toEqual([
        ['show', 1, 'held'],
        ['show', 2, 'confirmed'],
      ]);
      await second.journal.append('show', 2, [ev('released', ['shows'])]);
      // Now the first instance is the stale one.
      await expect(first.journal.append('show', 2, [ev('late')])).rejects.toBeInstanceOf(
        JournalConflictError,
      );

      const fromFirst = await first.journal.read('show', 1, 10);
      expect(summary(fromFirst)).toEqual([
        ['show', 1, 'held'],
        ['show', 2, 'confirmed'],
        ['show', 3, 'released'],
      ]);
      expect(fromFirst.map((e) => e.timestamp)).toEqual([1, 1, 2]);
      const tagged = await first.journal.readByTag('shows', 0, 10);
      expect(tagged.map((e) => e.seq)).toEqual([1, 2, 3]);
      const offsets = tagged.map((e) => e.offset);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
      expect(new Set(offsets).size).toBe(3);
    } finally {
      first.close();
      second.close();
    }
  });

  it('finds everything a closed instance wrote when the file is reopened', async () => {
    const path = tempFile();
    const before = sqlitePersistence({ path, clock: () => 10 });
    await before.journal.append('a', 0, [ev({ n: 1 }, ['t']), ev({ n: 2 })]);
    await before.journal.append('b', 0, [ev({ n: 1 }, ['t'])]);
    await before.snapshots.save('a', { seq: 2, version: 3, state: { total: 3 } });
    await before.offsets.save('totals', 2);
    const lastOffset = (await before.journal.readByTag('t', 0, 10)).at(-1)?.offset ?? 0;
    before.close();

    const after = sqlitePersistence({ path, clock: () => 20 });
    try {
      const events = await after.journal.read('a', 1, 10);
      expect(events).toEqual([
        {
          persistenceId: 'a',
          seq: 1,
          offset: 1,
          timestamp: 10,
          version: 1,
          tags: ['t'],
          event: { n: 1 },
        },
        {
          persistenceId: 'a',
          seq: 2,
          offset: 2,
          timestamp: 10,
          version: 1,
          tags: [],
          event: { n: 2 },
        },
      ]);
      expect(summary(await after.journal.readByTag('t', 0, 10))).toEqual([
        ['a', 1, { n: 1 }],
        ['b', 1, { n: 1 }],
      ]);
      expect(await after.snapshots.load('a')).toEqual({
        seq: 2,
        version: 3,
        state: { total: 3 },
        timestamp: 10,
      });
      expect(await after.offsets.load('totals')).toBe(2);

      // The reopened journal carries on: the stream from its last seq, offsets past the old ones.
      await expect(after.journal.append('a', 0, [ev('x')])).rejects.toBeInstanceOf(
        JournalConflictError,
      );
      await after.journal.append('a', 2, [ev({ n: 3 }, ['t'])]);
      const [third] = await after.journal.readByTag('t', lastOffset, 10);
      expect(third).toMatchObject({ persistenceId: 'a', seq: 3, timestamp: 20 });
      expect(third?.offset).toBeGreaterThan(lastOffset);
    } finally {
      after.close();
    }
  });

  it('resumes a projection from the offset a closed instance stored', async () => {
    const path = tempFile();
    const seen: string[] = [];
    const run = async (persistence: SqlitePersistence) => {
      const kit = createTestKit();
      kit.system.spawn(
        projection({
          name: 'log',
          persistence,
          tag: 't',
          handle: (e) => {
            seen.push(e.event as string);
          },
        }),
        'log',
      );
      await kit.settle();
      await kit.shutdown();
    };

    const before = sqlitePersistence({ path });
    await before.journal.append('a', 0, [ev('one', ['t']), ev('two', ['t'])]);
    await run(before);
    before.close();

    const after = sqlitePersistence({ path });
    await after.journal.append('a', 2, [ev('three', ['t'])]);
    await run(after);
    after.close();
    expect(seen).toEqual(['one', 'two', 'three']);
  });

  it('rejects calls after close, and closing twice does nothing', async () => {
    const p = sqlitePersistence({ path: ':memory:' });
    p.close();
    p.close();
    const closed = 'sqlitePersistence: the database is closed';
    await expect(p.journal.append('a', 0, [ev(1)])).rejects.toThrow(closed);
    await expect(p.journal.read('a', 1, 1)).rejects.toThrow(closed);
    await expect(p.journal.readByTag('t', 0, 1)).rejects.toThrow(closed);
    await expect(p.snapshots.save('a', { seq: 1, version: 1, state: 1 })).rejects.toThrow(closed);
    await expect(p.snapshots.load('a')).rejects.toThrow(closed);
    await expect(p.offsets.save('x', 1)).rejects.toThrow(closed);
    await expect(p.offsets.load('x')).rejects.toThrow(closed);
  });

  it('rolls back an append whose clock fails, and writes nothing', async () => {
    let time = 1.5;
    const p = sqlitePersistence({ path: ':memory:', clock: () => time });
    try {
      await expect(p.journal.append('a', 0, [ev(1, ['t'])])).rejects.toThrow(
        'sqlitePersistence: clock() must be a non-negative integer, got 1.5',
      );
      expect(await p.journal.read('a', 1, 10)).toEqual([]);
      time = 5;
      await p.journal.append('a', 0, [ev(1, ['t'])]);
      expect((await p.journal.readByTag('t', 0, 10)).map((e) => e.seq)).toEqual([1]);
    } finally {
      p.close();
    }
  });

  it('accepts an empty batch at the right expectedSeq, and writes nothing', async () => {
    const p = sqlitePersistence({ path: ':memory:' });
    try {
      await p.journal.append('a', 0, []);
      await p.journal.append('a', 0, [ev(1)]);
      await expect(p.journal.append('a', 0, [])).rejects.toBeInstanceOf(JournalConflictError);
      expect((await p.journal.read('a', 1, 10)).map((e) => e.seq)).toEqual([1]);
    } finally {
      p.close();
    }
  });

  it('stamps events with Date.now by default', async () => {
    const p = sqlitePersistence({ path: ':memory:' });
    try {
      const before = Date.now();
      await p.journal.append('a', 0, [ev(1)]);
      const after = Date.now();
      const [event] = await p.journal.read('a', 1, 1);
      expect(event?.timestamp).toBeGreaterThanOrEqual(before);
      expect(event?.timestamp).toBeLessThanOrEqual(after);
    } finally {
      p.close();
    }
  });

  it('throws TypeError for invalid options, before opening anything', () => {
    expect(() => sqlitePersistence({ path: ':memory:', clok: Date.now } as never)).toThrow(
      new TypeError('sqlitePersistence: unknown option "clok"'),
    );
    expect(() => sqlitePersistence({} as never)).toThrow(TypeError);
    expect(() => sqlitePersistence({ path: '' })).toThrow(TypeError);
    expect(() => sqlitePersistence({ path: ':memory:', clock: 5 } as never)).toThrow(TypeError);
    expect(() => sqlitePersistence(null as never)).toThrow(TypeError);
  });

  it('throws when the file can’t be opened', () => {
    expect(() => sqlitePersistence({ path: join(tempFile(), 'no', 'such', 'dir.db') })).toThrow();
  });

  it('rejects invalid arguments with TypeError', async () => {
    const p = sqlitePersistence({ path: ':memory:' });
    const { journal, snapshots, offsets } = p;
    try {
      const calls: Promise<unknown>[] = [
        journal.append('', 0, []),
        journal.append('a', -1, []),
        journal.append('a', 0, 'nope' as never),
        journal.append('a', 0, [{ event: 1, version: 1, tags: [''] }]),
        journal.read('a', 0, 1),
        journal.read('a', 1, 0),
        journal.readByTag('', 0, 1),
        journal.readByTag('t', -1, 1),
        snapshots.save('a', null as never),
        snapshots.save('', { seq: 1, version: 1, state: 1 }),
        snapshots.load(''),
        offsets.save('x', -1),
        offsets.load(''),
      ];
      for (const call of calls) await expect(call).rejects.toBeInstanceOf(TypeError);
    } finally {
      p.close();
    }
  });
});
