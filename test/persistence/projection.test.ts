import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { persistentActor } from '../../src/persistence/actor.js';
import { inMemoryPersistence, type InMemoryPersistence } from '../../src/persistence/memory.js';
import { projection, type ProjectionOptions } from '../../src/persistence/projection.js';
import type {
  Journal,
  OffsetStore,
  Persistence,
  StoredEvent,
} from '../../src/persistence/types.js';
import { supervise } from '../../src/supervision.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { account, type AccountEvent, type Receipt } from '../helpers/account.js';

/** A clock for the backend's timestamps, so nothing reads the wall clock. */
const clock = () => 1_000;

/** Every account event is tagged `account`, and withdrawals `withdrawal` too. */
const accountTags = (event: AccountEvent): readonly string[] =>
  event.type === 'withdrawn' ? ['account', 'withdrawal'] : ['account'];

const ofType = <T extends SystemEvent['type']>(kit: TestKit, type: T) =>
  kit.events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);

/** A journal that records each `readByTag`'s offset. */
function countingJournal(inner: Journal): Journal & { readonly tagReads: number[] } {
  const tagReads: number[] = [];
  return {
    tagReads,
    append: (id, seq, events) => inner.append(id, seq, events),
    read: (id, from, limit) => inner.read(id, from, limit),
    readByTag: (tag, after, limit) => {
      tagReads.push(after);
      return inner.readByTag(tag, after, limit);
    },
  };
}

/** An offset store that records saves, and fails the next `failSaves` saves or `failLoads` loads. */
function recordingOffsets(inner: OffsetStore) {
  const saves: { name: string; offset: number }[] = [];
  const faults = { saves: 0, loads: 0 };
  const store: OffsetStore = {
    async load(name) {
      if (faults.loads > 0) {
        faults.loads--;
        throw new Error('load failed');
      }
      return inner.load(name);
    },
    async save(name, offset) {
      if (faults.saves > 0) {
        faults.saves--;
        throw new Error('save failed');
      }
      saves.push({ name, offset });
      await inner.save(name, offset);
    },
  };
  return { store, saves, faults };
}

/** Accounts that tag their events, and a way to deposit into them. */
function accounts(kit: TestKit, store: InMemoryPersistence, ids: readonly string[]) {
  const receipts = kit.probe<Receipt>();
  const refs = new Map(
    ids.map((id) => [id, kit.system.spawn(account(store, { id, tags: accountTags }), id)]),
  );
  const tell = (id: string, type: 'deposit' | 'withdraw', amount = 1) => {
    (refs.get(id) as ActorRef<never>).tell({ type, amount, replyTo: receipts.ref } as never);
  };
  return { tell };
}

/** Spawns a projection that records what it handles. */
function follow(
  kit: TestKit,
  persistence: Persistence,
  opts: Partial<ProjectionOptions> = {},
  actorName = 'proj',
) {
  const seen: StoredEvent[] = [];
  const ref = kit.system.spawn(
    projection({
      name: 'totals',
      persistence,
      tag: 'account',
      handle: (event) => {
        seen.push(event);
      },
      ...opts,
    }),
    actorName,
    { supervision: supervise.restart() },
  );
  return { seen, ref };
}

const offsetsOf = (events: readonly StoredEvent[]) => events.map((e) => e.offset);
const tagged = (store: InMemoryPersistence, tag: string) =>
  store.events().filter((e) => e.tags.includes(tag));

describe('projection', () => {
  it('handles every tagged event once, in offset order, across several entities', async () => {
    const store = inMemoryPersistence({ clock });
    const kit = createTestKit();
    const { tell } = accounts(kit, store, ['a', 'b', 'c']);
    // An entity with another tag, which the projection must skip.
    kit.system.spawn(account(store, { id: 'other', tags: () => ['other'] }), 'other').tell({
      type: 'deposit',
      amount: 1,
      replyTo: kit.probe<Receipt>().ref,
    });
    for (const round of [1, 2, 3]) {
      for (const id of ['a', 'b', 'c']) tell(id, 'deposit', round);
      await kit.settle();
    }
    tell('b', 'withdraw');
    await kit.settle();

    // handle is async, and each call finishes before the next starts.
    const log: string[] = [];
    const seen: StoredEvent[] = [];
    kit.system.spawn(
      projection({
        name: 'totals',
        persistence: store,
        tag: 'account',
        batchSize: 2,
        handle: async (event) => {
          log.push(`start ${String(event.offset)}`);
          await Promise.resolve();
          await Promise.resolve();
          seen.push(event);
          log.push(`end ${String(event.offset)}`);
        },
      }),
      'proj',
    );
    await kit.settle();

    const expected = tagged(store, 'account');
    expect(expected).toHaveLength(10);
    expect(seen).toEqual(expected);
    expect(new Set(seen.map((e) => e.persistenceId))).toEqual(new Set(['a', 'b', 'c']));
    const offsets = offsetsOf(seen);
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y));
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(log).toEqual(offsets.flatMap((o) => [`start ${String(o)}`, `end ${String(o)}`]));
    // The tag the journal stored is what the projection followed.
    expect(seen.at(-1)?.tags).toEqual(['account', 'withdrawal']);
    await kit.shutdown();
  });

  it('saves its offset after each batch, and a new one with the same name starts after it', async () => {
    const store = inMemoryPersistence({ clock });
    const offsets = recordingOffsets(store.offsets);
    const persistence: Persistence = { journal: store.journal, offsets: offsets.store };

    const kit = createTestKit();
    const { tell } = accounts(kit, store, ['a', 'b']);
    for (let i = 0; i < 5; i++) tell(i % 2 === 0 ? 'a' : 'b', 'deposit');
    await kit.settle();
    const first = follow(kit, persistence, { batchSize: 2 });
    await kit.settle();

    const all = offsetsOf(tagged(store, 'account'));
    expect(offsetsOf(first.seen)).toEqual(all);
    // One save per non-empty batch, at its last offset: batches of 2, 2 and 1.
    expect(offsets.saves).toEqual([
      { name: 'totals', offset: all[1] },
      { name: 'totals', offset: all[3] },
      { name: 'totals', offset: all[4] },
    ]);
    await kit.shutdown();

    // A fresh system on the same store: the accounts recover, and two more events arrive.
    const kit2 = createTestKit();
    const more = accounts(kit2, store, ['a', 'b']);
    more.tell('a', 'deposit');
    more.tell('b', 'deposit');
    await kit2.settle();
    const journal = countingJournal(store.journal);
    const second = follow(kit2, { journal, offsets: offsets.store });
    await kit2.settle();

    expect(journal.tagReads[0]).toBe(all[4]);
    expect(offsetsOf(second.seen)).toEqual(offsetsOf(tagged(store, 'account')).slice(5));
    expect(second.seen).toHaveLength(2);
    expect(await store.offsets.load('totals')).toBe(second.seen[1]?.offset);
    await kit2.shutdown();
  });

  it('reads again at once after a full batch, and waits pollMs after a short one', async () => {
    const store = inMemoryPersistence({ clock });
    const journal = countingJournal(store.journal);
    const kit = createTestKit();
    const { tell } = accounts(kit, store, ['a']);
    for (let i = 0; i < 4; i++) tell('a', 'deposit');
    await kit.settle();

    const start = kit.scheduler.now();
    const { seen } = follow(
      kit,
      { journal, offsets: store.offsets },
      { batchSize: 2, pollMs: 500 },
    );
    await kit.settle();
    // Two full batches, then an empty one, all without time passing.
    expect(seen).toHaveLength(4);
    expect(journal.tagReads).toHaveLength(3);
    expect(kit.scheduler.now()).toBe(start);

    tell('a', 'deposit');
    await kit.settle();
    expect(seen).toHaveLength(4);
    await kit.advance(499);
    expect(seen).toHaveLength(4);
    expect(journal.tagReads).toHaveLength(3);
    await kit.advance(1);
    expect(seen).toHaveLength(5);
    // A short batch of one, so the next read waits again.
    expect(journal.tagReads).toHaveLength(4);
    await kit.advance(500);
    expect(journal.tagReads).toHaveLength(5);
    await kit.shutdown();
  });

  it('restarts from the stored offset after handle fails, so the batch repeats', async () => {
    const store = inMemoryPersistence({ clock });
    const kit = createTestKit();
    const { tell } = accounts(kit, store, ['a']);
    for (let i = 0; i < 5; i++) tell('a', 'deposit');
    await kit.settle();
    const all = offsetsOf(tagged(store, 'account'));

    const seen: number[] = [];
    let failures = 1;
    kit.system.spawn(
      projection({
        name: 'totals',
        persistence: store,
        tag: 'account',
        batchSize: 3,
        handle: (event) => {
          if (event.offset === all[4] && failures > 0) {
            failures--;
            throw new Error('handle failed');
          }
          seen.push(event.offset);
        },
      }),
      'proj',
      { supervision: supervise.restart() },
    );
    await kit.settle();

    // The first batch (0-2) was saved. The second (3-4) failed at 4, and ran again from 3.
    expect(seen).toEqual([all[0], all[1], all[2], all[3], all[3], all[4]]);
    expect(ofType(kit, 'failed').map((e) => [e.path, (e.error as Error).message])).toEqual([
      ['/user/proj', 'handle failed'],
    ]);
    expect(ofType(kit, 'restarted').map((e) => e.path)).toEqual(['/user/proj']);
    expect(await store.offsets.load('totals')).toBe(all[4]);
    await kit.shutdown();
  });

  it('sends a failed load or save to supervision, and carries on after the restart', async () => {
    const store = inMemoryPersistence({ clock });
    const offsets = recordingOffsets(store.offsets);
    offsets.faults.loads = 1;
    offsets.faults.saves = 1;
    const kit = createTestKit();
    const { tell } = accounts(kit, store, ['a']);
    tell('a', 'deposit');
    tell('a', 'deposit');
    await kit.settle();

    const { seen } = follow(kit, { journal: store.journal, offsets: offsets.store });
    await kit.settle();

    expect(ofType(kit, 'failed').map((e) => (e.error as Error).message)).toEqual([
      'load failed',
      'save failed',
    ]);
    // The failed save means the batch is handled again: at least once.
    expect(seen).toHaveLength(4);
    expect(offsets.saves).toHaveLength(1);
    expect(await store.offsets.load('totals')).toBe(seen[3]?.offset);
    await kit.shutdown();
  });

  it('stops polling when it stops', async () => {
    const store = inMemoryPersistence({ clock });
    const journal = countingJournal(store.journal);
    const kit = createTestKit();
    const { ref } = follow(kit, { journal, offsets: store.offsets }, { pollMs: 100 });
    await kit.settle();
    expect(journal.tagReads).toHaveLength(1);
    kit.system.stop(ref);
    await kit.advance(1_000);
    expect(journal.tagReads).toHaveLength(1);
    await kit.shutdown();
  });

  it.each<[string, Record<string, unknown>]>([
    ['unknown fields', { extra: 1 }],
    ['an empty name', { name: '' }],
    ['a name over 255 characters', { name: 'n'.repeat(256) }],
    ['a name that is not a string', { name: 7 }],
    ['an invalid tag', { tag: 'two words' }],
    ['a tag starting with "$"', { tag: '$1' }],
    ['a tag over 64 characters', { tag: 't'.repeat(65) }],
    ['no offsets', { persistence: { journal: inMemoryPersistence({ clock }).journal } }],
    [
      'a journal without readByTag',
      { persistence: { journal: {}, offsets: { load() {}, save() {} } } },
    ],
    ['no persistence', { persistence: null }],
    ['a handle that is not a function', { handle: 'nope' }],
    ['a zero pollMs', { pollMs: 0 }],
    ['a fractional batchSize', { batchSize: 1.5 }],
  ])('throws TypeError for %s', (_name, override) => {
    const opts = {
      name: 'totals',
      persistence: inMemoryPersistence({ clock }),
      tag: 'account',
      handle: () => {},
      ...override,
    };
    expect(() => projection(opts as unknown as ProjectionOptions)).toThrow(TypeError);
  });
});

describe('tags', () => {
  it.each<[string, (event: AccountEvent) => readonly string[], RegExp]>([
    ['a tag with a space', () => ['two words'], /tags\(\) returned "two words" for event 0/],
    ['a tag starting with "$"', () => ['$1'], /tags\(\) returned "\$1"/],
    ['an empty tag', () => [''], /tags\(\) returned ""/],
    ['a tag over 64 characters', () => ['t'.repeat(65)], /tags\(\) returned/],
    ['a tag that is not a string', () => [7 as never], /tags\(\) returned 7/],
    ['a repeated tag', () => ['account', 'account'], /tags\(\) repeats "account"/],
    ['something other than an array', () => 'account' as never, /must return an array/],
  ])('fails the persist with TypeError for %s, writing nothing', async (_name, tags, message) => {
    const store = inMemoryPersistence({ clock });
    const kit = createTestKit();
    const replies = kit.probe<Receipt>();
    const ref = kit.system.spawn(account(store, { tags }), 'acct');
    ref.tell({ type: 'deposit', amount: 1, replyTo: replies.ref });
    await kit.settle();

    const [failed] = ofType(kit, 'failed');
    expect(failed?.error).toBeInstanceOf(TypeError);
    expect((failed?.error as Error).message).toMatch(message);
    expect(store.events()).toEqual([]);
    await kit.shutdown();
  });

  it('stores tags with each event, worked out from the schema output', async () => {
    const store = inMemoryPersistence({ clock });
    const kit = createTestKit();
    // The schema adds the size, and tags() reads it, so it must see the schema's output.
    const schema = z
      .object({ amount: z.number() })
      .transform((e) => ({ ...e, size: e.amount >= 100 ? 'big' : 'small' }));
    type Sized = z.output<typeof schema>;
    const ref = kit.system.spawn(
      persistentActor<number, Sized, number>({
        id: 'sized',
        persistence: store,
        initial: 0,
        events: { schema },
        onCommand: (_state, amount, { persist }) =>
          persist({ amount } as Sized, { amount: amount * 100 } as Sized),
        onEvent: (state, event) => state + event.amount,
        tags: (event) => ['sized', event.size],
      }),
      'sized',
    );
    ref.tell(1);
    await kit.settle();

    expect(store.events().map((e) => [e.event, e.tags])).toEqual([
      [{ amount: 1 }, ['sized', 'small']],
      [{ amount: 100 }, ['sized', 'big']],
    ]);
    expect((await store.journal.readByTag('big', 0, 10)).map((e) => e.seq)).toEqual([2]);
    await kit.shutdown();
  });

  it('throws TypeError from persistentActor for a tags that is not a function', () => {
    expect(() =>
      persistentActor({
        id: 'x',
        persistence: inMemoryPersistence({ clock }),
        initial: 0,
        onCommand: (_s, _c, { none }) => none(),
        onEvent: (s) => s,
        tags: 'account' as never,
      }),
    ).toThrow(/tags must be a function/);
  });
});
