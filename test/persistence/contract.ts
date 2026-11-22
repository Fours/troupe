// The journal contract: what every persistence backend must do. Each backend's test file calls
// journalContract with a factory, so in-memory, SQLite and Postgres are held to the same rules.
import { describe, expect, it } from 'vitest';
import {
  JournalConflictError,
  type NewEvent,
  type Persistence,
} from '@kylewillett/troupe/persistence';

/** How the contract makes and disposes of a fresh, empty backend for each test. */
export interface ContractBackend {
  create(opts: { clock: () => number }): Required<Persistence> | Promise<Required<Persistence>>;
  dispose?(persistence: Required<Persistence>): void | Promise<void>;
}

/** A clock the test moves by hand. */
function testClock(start = 1_700_000_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

const seqs = (events: readonly { seq: number }[]) => events.map((e) => e.seq);

const ev = (event: unknown, tags: readonly string[] = [], version = 1): NewEvent => ({
  event,
  version,
  tags,
});

export function journalContract(name: string, backend: ContractBackend): void {
  describe(`${name}: journal contract`, () => {
    async function withBackend(
      test: (p: Required<Persistence>, clock: ReturnType<typeof testClock>) => Promise<void>,
    ): Promise<void> {
      const clock = testClock();
      const p = await backend.create({ clock: clock.now });
      try {
        await test(p, clock);
      } finally {
        await backend.dispose?.(p);
      }
    }

    describe('append and read', () => {
      it('numbers a stream from 1 with no gaps', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev({ n: 1 }), ev({ n: 2 })]);
          await journal.append('a', 2, [ev({ n: 3 })]);
          const events = await journal.read('a', 1, 100);
          expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
          expect(events.map((e) => e.event)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
          expect(events.every((e) => e.persistenceId === 'a')).toBe(true);
        }));

      it('reads from fromSeq, at most limit', () =>
        withBackend(async ({ journal }) => {
          await journal.append(
            'a',
            0,
            [1, 2, 3, 4, 5].map((n) => ev(n)),
          );
          expect((await journal.read('a', 2, 2)).map((e) => e.seq)).toEqual([2, 3]);
          expect((await journal.read('a', 4, 100)).map((e) => e.seq)).toEqual([4, 5]);
          expect(await journal.read('a', 6, 100)).toEqual([]);
        }));

      it('reads nothing from a stream that was never written', () =>
        withBackend(async ({ journal }) => {
          expect(await journal.read('nobody', 1, 10)).toEqual([]);
        }));

      it('keeps streams independent', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev('a1')]);
          await journal.append('b', 0, [ev('b1'), ev('b2')]);
          await journal.append('a', 1, [ev('a2')]);
          const a = await journal.read('a', 1, 10);
          const b = await journal.read('b', 1, 10);
          expect(a.map((e) => [e.seq, e.event])).toEqual([
            [1, 'a1'],
            [2, 'a2'],
          ]);
          expect(b.map((e) => [e.seq, e.event])).toEqual([
            [1, 'b1'],
            [2, 'b2'],
          ]);
        }));

      it('stores each event’s version and tags', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev('x', ['t1', 't2'], 3), ev('y')]);
          const [x, y] = await journal.read('a', 1, 10);
          expect(x).toMatchObject({ version: 3, tags: ['t1', 't2'] });
          expect(y).toMatchObject({ version: 1, tags: [] });
        }));
    });

    describe('conflicts', () => {
      it('rejects a stale expectedSeq with JournalConflictError and writes nothing', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev(1), ev(2)]);
          const stale = journal.append('a', 1, [ev('x', ['t']), ev('y', ['t']), ev('z')]);
          await expect(stale).rejects.toBeInstanceOf(JournalConflictError);
          await expect(stale).rejects.toMatchObject({ persistenceId: 'a', expectedSeq: 1 });
          expect((await journal.read('a', 1, 10)).map((e) => e.event)).toEqual([1, 2]);
          expect(await journal.readByTag('t', 0, 10)).toEqual([]);
        }));

      it('rejects an expectedSeq ahead of the stream', () =>
        withBackend(async ({ journal }) => {
          await expect(journal.append('a', 3, [ev(1)])).rejects.toBeInstanceOf(
            JournalConflictError,
          );
          expect(await journal.read('a', 1, 10)).toEqual([]);
        }));

      it('lets only one of two appends at the same expectedSeq win', () =>
        withBackend(async ({ journal }) => {
          const results = await Promise.allSettled([
            journal.append('a', 0, [ev('first'), ev('first again')]),
            journal.append('a', 0, [ev('second')]),
          ]);
          const won = results.filter((r) => r.status === 'fulfilled');
          const lost = results.filter((r) => r.status === 'rejected');
          expect(won).toHaveLength(1);
          expect(lost).toHaveLength(1);
          expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(JournalConflictError);
          const seqs = (await journal.read('a', 1, 10)).map((e) => e.seq);
          expect(seqs).toEqual(seqs.map((_, i) => i + 1));
        }));
    });

    describe('batches', () => {
      it('writes nothing when one event in the batch is invalid', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev('kept')]);
          const bad = journal.append('a', 1, [ev('ok', ['t']), ev({ when: new Date(0) }, ['t'])]);
          await expect(bad).rejects.toBeInstanceOf(TypeError);
          expect((await journal.read('a', 1, 10)).map((e) => e.event)).toEqual(['kept']);
          expect(await journal.readByTag('t', 0, 10)).toEqual([]);
          // The stream is still at 1, so the next append there succeeds.
          await journal.append('a', 1, [ev('next')]);
          expect((await journal.read('a', 1, 10)).map((e) => e.seq)).toEqual([1, 2]);
        }));

      it('rejects duplicate tags on one event', () =>
        withBackend(async ({ journal }) => {
          await expect(journal.append('a', 0, [ev('x', ['t', 't'])])).rejects.toBeInstanceOf(
            TypeError,
          );
          expect(await journal.read('a', 1, 10)).toEqual([]);
        }));
    });

    describe('offsets and tags', () => {
      it('increases offsets across streams', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev('a1'), ev('a2')]);
          await journal.append('b', 0, [ev('b1')]);
          await journal.append('a', 2, [ev('a3')]);
          const order = [
            ...(await journal.read('a', 1, 10)),
            ...(await journal.read('b', 1, 10)),
          ].sort((x, y) => x.offset - y.offset);
          expect(order.map((e) => e.event)).toEqual(['a1', 'a2', 'b1', 'a3']);
          const offsets = order.map((e) => e.offset);
          expect(new Set(offsets).size).toBe(offsets.length);
        }));

      it('reads one tag’s events after an offset, in offset order, up to limit', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev('a1', ['red']), ev('a2', ['blue']), ev('a3', ['red'])]);
          await journal.append('b', 0, [ev('b1', ['red', 'blue']), ev('b2')]);
          await journal.append('a', 3, [ev('a4', ['red'])]);

          const red = await journal.readByTag('red', 0, 100);
          expect(red.map((e) => e.event)).toEqual(['a1', 'a3', 'b1', 'a4']);
          expect(red.map((e) => e.offset)).toEqual(
            [...red.map((e) => e.offset)].sort((x, y) => x - y),
          );
          expect(red.every((e) => e.tags.includes('red'))).toBe(true);
          expect(red.map((e) => [e.persistenceId, e.seq])).toEqual([
            ['a', 1],
            ['a', 3],
            ['b', 1],
            ['a', 4],
          ]);

          const [, second] = red;
          const after = await journal.readByTag('red', (second as { offset: number }).offset, 1);
          expect(after.map((e) => e.event)).toEqual(['b1']);
          expect((await journal.readByTag('red', 0, 2)).map((e) => e.event)).toEqual(['a1', 'a3']);
          expect((await journal.readByTag('blue', 0, 100)).map((e) => e.event)).toEqual([
            'a2',
            'b1',
          ]);
          expect(await journal.readByTag('green', 0, 100)).toEqual([]);
          const last = red.at(-1)?.offset ?? 0;
          expect(await journal.readByTag('red', last, 100)).toEqual([]);
        }));
    });

    describe('timestamps', () => {
      it('come from the given clock', () =>
        withBackend(async ({ journal, snapshots }, clock) => {
          const start = clock.now();
          await journal.append('a', 0, [ev(1), ev(2)]);
          clock.advance(1_500);
          await journal.append('a', 2, [ev(3)]);
          clock.advance(250);
          await snapshots.save('a', { seq: 3, version: 1, state: {} });
          const events = await journal.read('a', 1, 10);
          expect(events.map((e) => e.timestamp)).toEqual([start, start, start + 1_500]);
          expect((await snapshots.load('a'))?.timestamp).toBe(start + 1_750);
        }));
    });

    describe('JSON round trips', () => {
      const value = {
        text: 'héllo "quoted"  ',
        int: 42,
        negative: -7,
        float: 0.1,
        big: Number.MAX_SAFE_INTEGER,
        flags: [true, false, null],
        nested: { list: [{ a: 1 }, [], {}], empty: '' },
        'odd key': 1,
        // Postgres's jsonb rejects these two, which is why the backend stores json (0017).
        nul: 'a\u0000b',
        lone: '\ud800',
        pair: '🎭',
      };

      it('gives events back deep-equal to what went in', () =>
        withBackend(async ({ journal }) => {
          await journal.append('a', 0, [ev(value), ev('plain'), ev(3), ev(null), ev([1, 'two'])]);
          const events = await journal.read('a', 1, 10);
          expect(events.map((e) => e.event)).toEqual([value, 'plain', 3, null, [1, 'two']]);
        }));

      it('gives snapshot states back deep-equal to what went in', () =>
        withBackend(async ({ snapshots }) => {
          await snapshots.save('a', { seq: 1, version: 2, state: value });
          expect(await snapshots.load('a')).toMatchObject({ seq: 1, version: 2, state: value });
        }));

      it('keeps stored events safe from references the caller kept', () =>
        withBackend(async ({ journal }) => {
          const event = { items: [1, 2] };
          const tags = ['t'];
          await journal.append('a', 0, [{ event, version: 1, tags }]);
          event.items.push(3);
          tags.push('u');
          const [read] = await journal.read('a', 1, 1);
          (read?.event as { items: number[] }).items.push(4);
          (read?.tags as string[]).push('v');
          const [again] = await journal.read('a', 1, 1);
          expect(again).toMatchObject({ event: { items: [1, 2] }, tags: ['t'] });
          const [byTag] = await journal.readByTag('t', 0, 1);
          expect(byTag).toMatchObject({ event: { items: [1, 2] }, tags: ['t'] });
          expect(await journal.readByTag('u', 0, 1)).toEqual([]);
        }));

      it('keeps stored snapshots safe from references the caller kept', () =>
        withBackend(async ({ snapshots }) => {
          const state = { seats: ['A1'] };
          await snapshots.save('a', { seq: 1, version: 1, state });
          state.seats.push('A2');
          const loaded = await snapshots.load('a');
          (loaded?.state as { seats: string[] }).seats.push('A3');
          expect((await snapshots.load('a'))?.state).toEqual({ seats: ['A1'] });
        }));

      it('rejects events and states that aren’t JSON, with TypeError', () =>
        withBackend(async ({ journal, snapshots }) => {
          for (const bad of [undefined, NaN, Infinity, 1n, () => 1, new Map(), { a: undefined }]) {
            await expect(journal.append('a', 0, [ev(bad)])).rejects.toBeInstanceOf(TypeError);
            await expect(
              snapshots.save('a', { seq: 1, version: 1, state: bad }),
            ).rejects.toBeInstanceOf(TypeError);
          }
          expect(await journal.read('a', 1, 10)).toEqual([]);
          expect(await snapshots.load('a')).toBeUndefined();
        }));
    });

    describe('ids and tags', () => {
      it('accept any well-formed string, astral characters included', () =>
        withBackend(async ({ journal, snapshots, offsets }) => {
          await journal.append('🎭 show', 0, [ev(1, ['🎟️', 'ticket'])]);
          await snapshots.save('🎭 show', { seq: 1, version: 1, state: 1 });
          await offsets.save('🎭 log', 1);
          expect(seqs(await journal.read('🎭 show', 1, 10))).toEqual([1]);
          expect(seqs(await journal.readByTag('🎟️', 0, 10))).toEqual([1]);
          expect((await snapshots.load('🎭 show'))?.seq).toBe(1);
          expect(await offsets.load('🎭 log')).toBe(1);
        }));

      it('reject U+0000 and lone surrogates with TypeError, which no database stores as they are', () =>
        withBackend(async ({ journal, snapshots, offsets }) => {
          for (const bad of ['a\u0000b', '\ud800', 'x\udc00']) {
            const calls: Promise<unknown>[] = [
              journal.append(bad, 0, [ev(1)]),
              journal.append('a', 0, [ev(1, [bad])]),
              journal.read(bad, 1, 10),
              journal.readByTag(bad, 0, 10),
              snapshots.save(bad, { seq: 1, version: 1, state: 1 }),
              snapshots.load(bad),
              offsets.save(bad, 1),
              offsets.load(bad),
            ];
            for (const call of calls) await expect(call).rejects.toBeInstanceOf(TypeError);
          }
          expect(await journal.read('a', 1, 10)).toEqual([]);
        }));
    });

    describe('snapshot store', () => {
      it('loads nothing before a save', () =>
        withBackend(async ({ snapshots }) => {
          expect(await snapshots.load('a')).toBeUndefined();
        }));

      it('loads the latest save, per persistence id', () =>
        withBackend(async ({ snapshots }) => {
          await snapshots.save('a', { seq: 3, version: 1, state: { n: 3 } });
          await snapshots.save('a', { seq: 6, version: 1, state: { n: 6 } });
          await snapshots.save('b', { seq: 1, version: 1, state: { n: 1 } });
          expect(await snapshots.load('a')).toMatchObject({ seq: 6, state: { n: 6 } });
          expect(await snapshots.load('b')).toMatchObject({ seq: 1, state: { n: 1 } });
        }));

      it('ignores a save with a lower seq', () =>
        withBackend(async ({ snapshots }) => {
          await snapshots.save('a', { seq: 6, version: 1, state: { n: 6 } });
          await snapshots.save('a', { seq: 3, version: 1, state: { n: 3 } });
          expect(await snapshots.load('a')).toMatchObject({ seq: 6, state: { n: 6 } });
        }));

      it('keeps the higher seq when two saves are in flight at once', () =>
        withBackend(async ({ snapshots }) => {
          await Promise.all([
            snapshots.save('a', { seq: 9, version: 1, state: { n: 9 } }),
            snapshots.save('a', { seq: 6, version: 1, state: { n: 6 } }),
          ]);
          expect(await snapshots.load('a')).toMatchObject({ seq: 9, state: { n: 9 } });
        }));
    });

    describe('offset store', () => {
      it('loads 0 before any save', () =>
        withBackend(async ({ offsets }) => {
          expect(await offsets.load('shows')).toBe(0);
        }));

      it('loads the last save, per name', () =>
        withBackend(async ({ offsets }) => {
          await offsets.save('shows', 5);
          await offsets.save('shows', 12);
          await offsets.save('sales', 3);
          expect(await offsets.load('shows')).toBe(12);
          expect(await offsets.load('sales')).toBe(3);
          await offsets.save('shows', 4);
          expect(await offsets.load('shows')).toBe(4);
        }));
    });
  });
}
