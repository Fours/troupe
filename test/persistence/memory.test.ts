import { describe, expect, it } from 'vitest';
import { inMemoryPersistence, type NewEvent } from '@kylewillett/troupe/persistence';
import { journalContract } from './contract.js';

journalContract('in-memory', { create: ({ clock }) => inMemoryPersistence({ clock }) });

const ev = (event: unknown, tags: readonly string[] = []): NewEvent => ({
  event,
  version: 1,
  tags,
});

describe('inMemoryPersistence', () => {
  it('lists every event in offset order, or one stream’s', async () => {
    const p = inMemoryPersistence({ clock: () => 7 });
    await p.journal.append('a', 0, [ev('a1')]);
    await p.journal.append('b', 0, [ev('b1', ['t'])]);
    await p.journal.append('a', 1, [ev('a2')]);
    expect(p.events().map((e) => e.event)).toEqual(['a1', 'b1', 'a2']);
    expect(p.events('a').map((e) => e.event)).toEqual(['a1', 'a2']);
    expect(p.events('nobody')).toEqual([]);
    expect(p.events('b')).toEqual([
      { persistenceId: 'b', seq: 1, offset: 2, timestamp: 7, version: 1, tags: ['t'], event: 'b1' },
    ]);
  });

  it('gives events() copies, so a caller can’t change what’s stored', async () => {
    const p = inMemoryPersistence();
    await p.journal.append('a', 0, [ev({ n: 1 })]);
    (p.events()[0]?.event as { n: number }).n = 2;
    expect(p.events()[0]?.event).toEqual({ n: 1 });
  });

  it('stamps events with Date.now by default', async () => {
    const p = inMemoryPersistence();
    const before = Date.now();
    await p.journal.append('a', 0, [ev(1)]);
    const after = Date.now();
    const [event] = p.events();
    expect(event?.timestamp).toBeGreaterThanOrEqual(before);
    expect(event?.timestamp).toBeLessThanOrEqual(after);
  });

  it('resolves without waiting on time', async () => {
    const p = inMemoryPersistence();
    // A microtask-only chain: if any call waited on a timer, the first macrotask would win.
    let macrotask = false;
    setTimeout(() => (macrotask = true), 0);
    await p.journal.append('a', 0, [ev(1, ['t'])]);
    await p.journal.read('a', 1, 1);
    await p.journal.readByTag('t', 0, 1);
    await p.snapshots.save('a', { seq: 1, version: 1, state: 1 });
    await p.snapshots.load('a');
    await p.offsets.save('x', 1);
    await p.offsets.load('x');
    expect(macrotask).toBe(false);
  });

  it('throws TypeError for invalid options', () => {
    expect(() => inMemoryPersistence({ clok: Date.now } as never)).toThrow(
      new TypeError('inMemoryPersistence: unknown option "clok"'),
    );
    expect(() => inMemoryPersistence({ clock: 5 } as never)).toThrow(TypeError);
    expect(() => inMemoryPersistence(null as never)).toThrow(TypeError);
  });

  it('rejects an append when the clock gives something other than integer ms', async () => {
    const p = inMemoryPersistence({ clock: () => 1.5 });
    await expect(p.journal.append('a', 0, [ev(1)])).rejects.toThrow(
      'inMemoryPersistence: clock() must be a non-negative integer, got 1.5',
    );
    expect(p.events()).toEqual([]);
  });

  it('rejects invalid arguments with TypeError', async () => {
    const { journal, snapshots, offsets } = inMemoryPersistence();
    const calls: Promise<unknown>[] = [
      journal.append('', 0, []),
      journal.append('a', -1, []),
      journal.append('a', 0.5, []),
      journal.append('a', 0, 'nope' as never),
      journal.append('a', 0, [null as never]),
      journal.append('a', 0, [{ event: 1, version: 0, tags: [] }]),
      journal.append('a', 0, [{ event: 1, version: 1 } as never]),
      journal.append('a', 0, [{ event: 1, version: 1, tags: [''] }]),
      journal.append('a', 0, [{ event: 1, version: 1, tags: [3] as never }]),
      journal.read('a', 0, 1),
      journal.read('a', 1, 0),
      journal.read(7 as never, 1, 1),
      journal.readByTag('', 0, 1),
      journal.readByTag('t', -1, 1),
      journal.readByTag('t', 0, 0),
      snapshots.save('a', null as never),
      snapshots.save('a', { seq: 0, version: 1, state: 1 }),
      snapshots.save('a', { seq: 1, version: 0, state: 1 }),
      snapshots.load(''),
      offsets.save('x', -1),
      offsets.save('', 1),
      offsets.load(''),
    ];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(TypeError);
  });

  it('names where an event stops being JSON', async () => {
    const { journal } = inMemoryPersistence();
    await expect(journal.append('a', 0, [ev(1), ev({ at: [1, new Date(0)] })])).rejects.toThrow(
      'append: events[1].event is not JSON: $.at[1] is not a plain object (Date)',
    );
  });

  it('accepts an empty batch at the right expectedSeq, and writes nothing', async () => {
    const p = inMemoryPersistence();
    await p.journal.append('a', 0, []);
    await p.journal.append('a', 0, [ev(1)]);
    await expect(p.journal.append('a', 0, [])).rejects.toMatchObject({
      name: 'JournalConflictError',
    });
    expect(p.events().map((e) => e.seq)).toEqual([1]);
  });
});
