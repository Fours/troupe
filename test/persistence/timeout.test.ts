import { describe, expect, it } from 'vitest';
import { persistentActor } from '../../src/persistence/actor.js';
import { PersistenceTimeoutError } from '../../src/persistence/errors.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { projection } from '../../src/persistence/projection.js';
import type { Journal, OffsetStore, Persistence } from '../../src/persistence/types.js';
import { simulatedDatabase } from '../../src/rehearsal/database.js';
import { RunLoop } from '../../src/rehearsal/loop.js';
import { supervise, type SupervisorStrategy } from '../../src/supervision.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import { seededRandom } from '../../src/testkit/random.js';
import type { SystemEvent } from '../../src/types.js';
import { account, type Receipt } from '../helpers/account.js';
import { deferred } from '../helpers/deferred.js';
import { faultyJournal } from '../helpers/faulty-journal.js';
import { faultySnapshots } from '../helpers/faulty-snapshots.js';

// Milestone 5, T4 (decision 0036): journal, snapshot and offset calls time out on the actor's
// scheduler. The testkit's settle waits real turns for a busy actor, and throws when one stays
// busy, so these tests drive the kit's clock with Rehearsal's run loop, which lets time move on
// while an actor awaits.

const ID = 'account-1';
const TIMEOUT = 1_000;
const clock = () => 1_000;

function setup(opts: { supervision?: SupervisorStrategy } = {}) {
  const kit = createTestKit();
  const loop = new RunLoop(kit.scheduler);
  const spawn = (persistence: Persistence, extra: Parameters<typeof account>[1] = {}) =>
    kit.system.spawn(account(persistence, { timeoutMs: TIMEOUT, ...extra }), 'acct', {
      supervision: opts.supervision ?? supervise.stop(),
    });
  return { kit, loop, spawn };
}

const failures = (kit: TestKit) =>
  kit.events.filter((e): e is Extract<SystemEvent, { type: 'failed' }> => e.type === 'failed');

const timeoutOf = (kit: TestKit, i = 0): PersistenceTimeoutError => {
  const error = failures(kit)[i]?.error;
  expect(error).toBeInstanceOf(PersistenceTimeoutError);
  return error as PersistenceTimeoutError;
};

/** A store whose calls never answer, counting how many were made. */
function hanging<T extends object>(names: readonly (keyof T)[], inner: T) {
  const calls: string[] = [];
  const out = { ...inner } as Record<string, unknown>;
  for (const name of names) {
    out[name as string] = () => {
      calls.push(name as string);
      return new Promise(() => {});
    };
  }
  return { store: out as T, calls };
}

describe('persistent actor timeouts', () => {
  it('fails a hung append with PersistenceTimeoutError after timeoutMs, and sends no reply', async () => {
    const { kit, loop, spawn } = setup();
    const store = inMemoryPersistence({ clock });
    const journal = faultyJournal(store.journal);
    const ref = spawn({ journal });
    const replies = kit.probe<Receipt>('replies');
    await loop.settle();
    const hold = journal.holdNextAppend();
    ref.tell({ type: 'deposit', amount: 10, replyTo: replies.ref });

    await loop.advance(TIMEOUT - 1);
    expect(failures(kit)).toEqual([]);
    await loop.advance(1);
    const error = timeoutOf(kit);
    expect(error).toMatchObject({
      name: 'PersistenceTimeoutError',
      id: ID,
      operation: 'append',
      timeoutMs: TIMEOUT,
    });
    expect(error.message).toBe(`append for "${ID}" did not answer within 1000 ms`);
    expect(failures(kit)[0]?.path).toBe('/user/acct');

    // The append lands after all: its answer is dropped, so still no reply.
    hold.resolve();
    await loop.advance(TIMEOUT);
    replies.expectNoMessage();
    expect(store.events(ID)).toHaveLength(1);
  });

  it('defaults to 10 s', async () => {
    const { kit, loop } = setup();
    const store = inMemoryPersistence({ clock });
    const journal = faultyJournal(store.journal);
    const ref = kit.system.spawn(account({ journal }), 'acct', { supervision: supervise.stop() });
    await loop.settle();
    journal.holdNextAppend();
    ref.tell({ type: 'deposit', amount: 1, replyTo: kit.probe<Receipt>().ref });
    await loop.advance(9_999);
    expect(failures(kit)).toEqual([]);
    await loop.advance(1);
    expect(timeoutOf(kit).timeoutMs).toBe(10_000);
  });

  it('after a timed-out append that committed, recovers with its events', async () => {
    const { kit, loop, spawn } = setup({ supervision: supervise.restart() });
    const db = simulatedDatabase({ scheduler: kit.scheduler, random: seededRandom(7) });
    const ref = spawn(db.connect('node-1').persistence);
    const replies = kit.probe<Receipt>('replies');
    ref.tell({ type: 'deposit', amount: 10, replyTo: replies.ref });
    await loop.advance(100);
    replies.expectMessage({ ok: true, balance: 10 });

    // Applied, and its answer lost: the caller can't know.
    const stopLosing = db.loseReplies();
    ref.tell({ type: 'deposit', amount: 5, replyTo: replies.ref });
    await loop.advance(TIMEOUT);
    stopLosing();
    expect(timeoutOf(kit).operation).toBe('append');
    expect(db.events(ID)).toHaveLength(2);
    replies.expectNoMessage();

    await loop.advance(100);
    ref.tell({ type: 'deposit', amount: 1, replyTo: replies.ref });
    await loop.advance(100);
    replies.expectMessage({ ok: true, balance: 16 });
    expect(db.events(ID).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('after a timed-out append that never committed, recovers without it', async () => {
    const { kit, loop, spawn } = setup({ supervision: supervise.restart() });
    const store = inMemoryPersistence({ clock });
    const journal = faultyJournal(store.journal);
    const ref = spawn({ journal });
    const replies = kit.probe<Receipt>('replies');
    ref.tell({ type: 'deposit', amount: 10, replyTo: replies.ref });
    await loop.settle();
    replies.expectMessage({ ok: true, balance: 10 });

    // Never written, and never answered.
    journal.holdNextAppend();
    ref.tell({ type: 'deposit', amount: 5, replyTo: replies.ref });
    await loop.advance(TIMEOUT);
    expect(timeoutOf(kit).operation).toBe('append');
    replies.expectNoMessage();

    ref.tell({ type: 'deposit', amount: 1, replyTo: replies.ref });
    await loop.advance(100);
    replies.expectMessage({ ok: true, balance: 11 });
    expect(store.events(ID).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('fails a recovery whose read hangs', async () => {
    const { kit, loop, spawn } = setup();
    const store = inMemoryPersistence({ clock });
    const { store: journal, calls } = hanging<Journal>(['read'], store.journal);
    spawn({ journal });
    await loop.advance(TIMEOUT);
    expect(calls).toEqual(['read']);
    expect(timeoutOf(kit).operation).toBe('read');
  });

  it('replays every event when the snapshot load hangs', async () => {
    const { kit, loop, spawn } = setup();
    const store = inMemoryPersistence({ clock });
    await store.journal.append(ID, 0, [
      { event: { type: 'deposited', amount: 4 }, version: 1, tags: [] },
    ]);
    const { store: snapshots } = hanging(['load'], store.snapshots);
    const ref = spawn({ journal: store.journal, snapshots }, { snapshots: { every: 10 } });
    const balances = kit.probe<number>('balances');
    ref.tell({ type: 'balance', replyTo: balances.ref });
    await loop.advance(TIMEOUT);
    balances.expectMessage(4);
    expect(failures(kit)).toEqual([]);
    expect(kit.logs.map((l) => l.msg)).toContain(
      `${ID}: loading the snapshot failed, so recovery replays every event`,
    );
  });

  it('logs a snapshot save that hangs, and stops counting it as busy work', async () => {
    const { kit, loop, spawn } = setup();
    const store = inMemoryPersistence({ clock });
    const snapshots = faultySnapshots(store.snapshots);
    const ref = spawn({ journal: store.journal, snapshots }, { snapshots: { every: 1 } });
    const replies = kit.probe<Receipt>('replies');
    snapshots.holdNextSave();
    ref.tell({ type: 'deposit', amount: 3, replyTo: replies.ref });
    await loop.advance(TIMEOUT);
    replies.expectMessage({ ok: true, balance: 3 });
    expect(kit.logs.find((l) => l.msg === `${ID}: saving the snapshot at 1 failed`)).toMatchObject({
      level: 'warn',
      fields: { error: { operation: 'saveSnapshot' } },
    });
    // Nothing is left busy, so the testkit's own settle finishes.
    await kit.settle();
  });

  it('rejects a timeoutMs that isn’t a positive integer', () => {
    const persistence = inMemoryPersistence({ clock });
    for (const timeoutMs of [0, -1, 1.5, Infinity, '1000', null]) {
      expect(() => account(persistence, { timeoutMs: timeoutMs as number })).toThrow(
        /persistentActor: timeoutMs must be a positive integer/,
      );
    }
    expect(() =>
      persistentActor({
        id: 'x',
        persistence,
        initial: 0,
        onCommand: (_s, _c: never, { none }) => none(),
        onEvent: (s) => s,
        timeoutMs: 1,
      }),
    ).not.toThrow();
  });
});

describe('projection timeouts', () => {
  const backoff = supervise.restartWithBackoff({ minMs: 500, maxMs: 500, randomFactor: 0 });

  function follow(kit: TestKit, persistence: Persistence) {
    const seen: number[] = [];
    kit.system.spawn(
      projection({
        name: 'totals',
        persistence,
        tag: 'account',
        timeoutMs: TIMEOUT,
        pollMs: 10_000,
        handle: (event) => {
          seen.push(event.offset);
        },
      }),
      'proj',
      { supervision: backoff },
    );
    return seen;
  }

  async function tagged(persistence: Persistence, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await persistence.journal.append(ID, i, [
        { event: { type: 'deposited', amount: 1 }, version: 1, tags: ['account'] },
      ]);
    }
  }

  it('retries a read that hangs after its backoff', async () => {
    const kit = createTestKit();
    const loop = new RunLoop(kit.scheduler);
    const store = inMemoryPersistence({ clock });
    await tagged(store, 2);
    let hangs = 1;
    const reads: number[] = [];
    const journal: Journal = {
      ...store.journal,
      readByTag: (tag, after, limit) => {
        reads.push(kit.scheduler.now());
        if (hangs-- > 0) return new Promise(() => {});
        return store.journal.readByTag(tag, after, limit);
      },
    };
    const seen = follow(kit, { journal, offsets: store.offsets });
    await loop.advance(TIMEOUT);
    expect(timeoutOf(kit)).toMatchObject({ id: 'totals', operation: 'readByTag' });
    expect(reads).toEqual([0]);
    await loop.advance(499);
    expect(reads).toEqual([0]);
    await loop.advance(1);
    expect(reads).toEqual([0, TIMEOUT + 500]);
    expect(seen).toEqual([1, 2]);
  });

  it('retries an offset save that hangs after its backoff, and handles the batch again', async () => {
    const kit = createTestKit();
    const loop = new RunLoop(kit.scheduler);
    const store = inMemoryPersistence({ clock });
    await tagged(store, 2);
    const hold = deferred();
    let hangs = 1;
    const offsets: OffsetStore = {
      load: (name) => store.offsets.load(name),
      save: (name, offset) => (hangs-- > 0 ? hold.promise : store.offsets.save(name, offset)),
    };
    const seen = follow(kit, { journal: store.journal, offsets });
    await loop.advance(TIMEOUT);
    expect(timeoutOf(kit)).toMatchObject({ id: 'totals', operation: 'saveOffset' });
    expect(seen).toEqual([1, 2]);
    await loop.advance(500);
    // At least once: the batch whose save never answered runs again.
    expect(seen).toEqual([1, 2, 1, 2]);
    expect(await store.offsets.load('totals')).toBe(2);
  });

  it('fails a start whose offset load hangs', async () => {
    const kit = createTestKit();
    const loop = new RunLoop(kit.scheduler);
    const store = inMemoryPersistence({ clock });
    const { store: offsets } = hanging<OffsetStore>(['load'], store.offsets);
    follow(kit, { journal: store.journal, offsets });
    await loop.advance(TIMEOUT);
    expect(timeoutOf(kit).operation).toBe('loadOffset');
  });

  it('rejects a timeoutMs that isn’t a positive integer', () => {
    const persistence = inMemoryPersistence({ clock });
    for (const timeoutMs of [0, 2.5, '1']) {
      expect(() =>
        projection({ name: 'p', persistence, tag: 't', handle: () => {}, timeoutMs } as never),
      ).toThrow(/projection: timeoutMs must be a positive integer/);
    }
  });
});
