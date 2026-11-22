import { describe, expect, it } from 'vitest';
import { AskTimeoutError } from '../../src/errors.js';
import { internalsOf } from '../../src/internal.js';
import { persistentActor } from '../../src/persistence/actor.js';
import { JournalConflictError, JournalSequenceError } from '../../src/persistence/errors.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import type { Persistence } from '../../src/persistence/types.js';
import { supervise, type SupervisorStrategy } from '../../src/supervision.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { account, type AccountCmd, type Receipt } from '../helpers/account.js';
import { faultyJournal } from '../helpers/faulty-journal.js';
import { track } from '../helpers/track.js';

const ID = 'account-1';

/** A clock for the journal's timestamps, so nothing reads the wall clock. */
const clock = () => 1_000;

function setup(opts: { supervision?: SupervisorStrategy; log?: string[] } = {}) {
  const store = inMemoryPersistence({ clock });
  const journal = faultyJournal(store.journal);
  const persistence: Persistence = { journal };
  const kit = createTestKit();
  const log = opts.log ?? [];
  const spawn = (name = 'acct', supervision = opts.supervision) =>
    kit.system.spawn(
      account(persistence, { log }),
      name,
      supervision === undefined ? undefined : { supervision },
    );
  return { store, journal, persistence, kit, log, spawn };
}

const ofType = <T extends SystemEvent['type']>(kit: TestKit, type: T) =>
  kit.events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);

function deposit(amount: number, replyTo: ActorRef<Receipt>): AccountCmd {
  return { type: 'deposit', amount, replyTo };
}

describe('persistentActor', () => {
  it('persists a command’s events, then replies with the new state', async () => {
    const { store, kit, spawn } = setup();
    const replies = kit.probe<Receipt>('replies');
    const ref = spawn();
    ref.tell(deposit(10, replies.ref));
    ref.tell({ type: 'depositTwice', amount: 5, replyTo: replies.ref });
    await kit.settle();

    replies.expectMessage({ ok: true, balance: 10 });
    replies.expectMessage({ ok: true, balance: 20 });
    expect(
      store.events(ID).map(({ seq, event, version, tags }) => ({ seq, event, version, tags })),
    ).toEqual([
      { seq: 1, event: { type: 'deposited', amount: 10 }, version: 1, tags: [] },
      { seq: 2, event: { type: 'deposited', amount: 5 }, version: 1, tags: [] },
      { seq: 3, event: { type: 'deposited', amount: 5 }, version: 1, tags: [] },
    ]);
    await kit.shutdown();
  });

  it('persists nothing for reply and none, and doesn’t hold the mailbox for them', async () => {
    const { store, journal, kit, spawn } = setup();
    const balances = kit.probe<number>('balances');
    const receipts = kit.probe<Receipt>('receipts');
    const ref = spawn();
    await kit.settle();

    ref.tell({ type: 'balance', replyTo: balances.ref });
    ref.tell({ type: 'noop' });
    ref.tell({ type: 'withdraw', amount: 5, replyTo: receipts.ref });
    ref.tell({ type: 'balance', replyTo: balances.ref });
    // One synchronous pass, with no promise allowed to settle: every reply is already there.
    kit.scheduler.runReady();
    expect(balances.messages()).toEqual([0, 0]);
    receipts.expectMessage({ ok: false, reason: 'insufficient funds' });
    expect(journal.appends).toEqual([]);
    expect(store.events()).toEqual([]);

    // A persist, by contrast, can't finish in a synchronous pass.
    ref.tell(deposit(1, receipts.ref));
    kit.scheduler.runReady();
    receipts.expectNoMessage();
    await kit.settle();
    receipts.expectMessage({ ok: true, balance: 1 });
    await kit.shutdown();
  });

  it('holds commands sent during a persist, then runs them in order', async () => {
    const { journal, kit, spawn } = setup();
    const receipts = kit.probe<Receipt>('receipts');
    const balances = kit.probe<number>('balances');
    const ref = spawn();
    await kit.settle();

    const hold = journal.holdNextAppend();
    ref.tell(deposit(10, receipts.ref));
    kit.scheduler.runReady();
    expect(journal.appends).toHaveLength(1);

    ref.tell(deposit(5, receipts.ref));
    ref.tell({ type: 'withdraw', amount: 3, replyTo: receipts.ref });
    ref.tell({ type: 'balance', replyTo: balances.ref });
    for (let i = 0; i < 10; i++) {
      kit.scheduler.runReady();
      await Promise.resolve();
    }
    // Still waiting on the first write: nothing else has run.
    expect(journal.appends).toHaveLength(1);
    receipts.expectNoMessage();
    balances.expectNoMessage();

    hold.resolve();
    await kit.settle();
    expect(receipts.messages()).toEqual([
      { ok: true, balance: 10 },
      { ok: true, balance: 15 },
      { ok: true, balance: 12 },
    ]);
    balances.expectMessage(12);
    expect(journal.appends.map((a) => a.expectedSeq)).toEqual([0, 1, 2]);
    await kit.shutdown();
  });

  it('holds commands sent right after spawn until recovery is done', async () => {
    const { store, kit, log, spawn } = setup();
    await store.journal.append(ID, 0, [
      { event: { type: 'deposited', amount: 20 }, version: 1, tags: [] },
      { event: { type: 'deposited', amount: 10 }, version: 1, tags: [] },
    ]);
    const balances = kit.probe<number>('balances');
    const receipts = kit.probe<Receipt>('receipts');
    const ref = spawn();
    ref.tell({ type: 'balance', replyTo: balances.ref });
    ref.tell(deposit(5, receipts.ref));
    ref.tell({ type: 'balance', replyTo: balances.ref });
    await kit.settle();

    expect(balances.messages()).toEqual([30, 35]);
    receipts.expectMessage({ ok: true, balance: 35 });
    expect(log[0]).toBe('recoveryCompleted 2, balance 30');
    const order = kit.events.map((e) => e.type).filter((t) => t !== 'spawned');
    expect(order).toEqual(['recovered', 'persisted']);
    await kit.shutdown();
  });

  it('reads the journal in pages of 256 during recovery', async () => {
    const { store, journal, kit, spawn } = setup();
    const one = { event: { type: 'deposited', amount: 1 }, version: 1, tags: [] };
    await store.journal.append(
      ID,
      0,
      Array.from({ length: 600 }, () => one),
    );
    const balances = kit.probe<number>('balances');
    spawn().tell({ type: 'balance', replyTo: balances.ref });
    await kit.settle();

    balances.expectMessage(600);
    expect(journal.reads).toEqual([
      { fromSeq: 1, limit: 256 },
      { fromSeq: 257, limit: 256 },
      { fromSeq: 513, limit: 256 },
    ]);
    await kit.shutdown();
  });

  describe('recovery', () => {
    it('rebuilds the state in a new incarnation', async () => {
      const { kit, log, spawn } = setup({ supervision: supervise.restart() });
      const receipts = kit.probe<Receipt>('receipts');
      const balances = kit.probe<number>('balances');
      const ref = spawn();
      ref.tell(deposit(10, receipts.ref));
      ref.tell(deposit(20, receipts.ref));
      ref.tell({ type: 'crash' });
      ref.tell({ type: 'balance', replyTo: balances.ref });
      await kit.settle();

      balances.expectMessage(30);
      expect(ofType(kit, 'restarted')).toHaveLength(1);
      expect(ofType(kit, 'recovered').map((e) => e.lastSeq)).toEqual([0, 2]);
      // preRestart saw the old state, and the new incarnation recovered the same one.
      expect(log).toEqual([
        'recoveryCompleted 0, balance 0',
        'preRestart, balance 30',
        'recoveryCompleted 2, balance 30',
      ]);
      await kit.shutdown();
    });

    it('rebuilds the state in a new system on the same backend', async () => {
      const store = inMemoryPersistence({ clock });
      const first = createTestKit();
      const receipts = first.probe<Receipt>('receipts');
      const ref = first.system.spawn(account(store), 'acct');
      ref.tell(deposit(10, receipts.ref));
      ref.tell({ type: 'withdraw', amount: 4, replyTo: receipts.ref });
      await first.settle();
      receipts.expectMessage({ ok: true, balance: 10 });
      receipts.expectMessage({ ok: true, balance: 6 });
      await first.shutdown();

      const second = createTestKit();
      const balances = second.probe<number>('balances');
      const seqs = second.probe<number>('seqs');
      const again = second.system.spawn(account(store), 'acct');
      again.tell({ type: 'balance', replyTo: balances.ref });
      again.tell({ type: 'lastSeq', replyTo: seqs.ref });
      await second.settle();
      balances.expectMessage(6);
      seqs.expectMessage(2);
      await second.shutdown();
    });
  });

  it('runs thenReply, thenRun and thenStop in chained order, after the write', async () => {
    const { journal, kit, log, spawn } = setup();
    const replies = kit.probe<string>('replies');
    const ref = spawn();
    await kit.settle();
    log.length = 0;

    const hold = journal.holdNextAppend();
    ref.tell({ type: 'close', replyTo: replies.ref });
    for (let i = 0; i < 10; i++) {
      kit.scheduler.runReady();
      await Promise.resolve();
    }
    // The write is in flight: no step has run, and the actor hasn't stopped.
    expect(log).toEqual([]);
    replies.expectNoMessage();
    expect(ofType(kit, 'stopped')).toEqual([]);

    hold.resolve();
    await kit.settle();
    // run 1 saw the state after the event. thenStop takes effect after the command, so the step
    // chained after it still ran.
    expect(log).toEqual([
      'run 1: closed true',
      'run 2',
      'run 3, after thenStop',
      'postStop, balance 0',
    ]);
    replies.expectMessage('closed');
    const types = kit.events.map((e) => e.type);
    expect(types.indexOf('persisted')).toBeLessThan(types.indexOf('stopped'));
    expect(ofType(kit, 'stopped')).toEqual([expect.objectContaining({ path: '/user/acct' })]);
    await kit.shutdown();
  });

  describe('failures go to supervision', () => {
    /**
     * Sends a command as an ask under a restart strategy, after a deposit of 10. The command fails
     * and is dropped, so its asker times out, and the restarted actor carries on with what the
     * journal holds.
     */
    async function failingCommand(
      cmd: (replyTo: ActorRef<Receipt>) => AccountCmd,
      arm: (journal: ReturnType<typeof faultyJournal>) => void = () => {},
    ) {
      const { store, journal, kit, spawn } = setup({ supervision: supervise.restart() });
      const receipts = kit.probe<Receipt>('receipts');
      const balances = kit.probe<number>('balances');
      const ref = spawn();
      ref.tell(deposit(10, receipts.ref));
      await kit.settle();
      arm(journal);

      const asked = track(ref.ask<Receipt>(cmd, { timeoutMs: 100 }));
      ref.tell({ type: 'balance', replyTo: balances.ref });
      await kit.advance(100);

      expect(asked.state).toBe('rejected');
      expect(asked.error).toBeInstanceOf(AskTimeoutError);
      const failed = ofType(kit, 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.directive).toBe('restart');
      expect(ofType(kit, 'restarted')).toHaveLength(1);
      const result = {
        error: failed[0]?.error,
        journal,
        events: store.events(ID),
        balance: balances.expectMessage(),
      };
      await kit.shutdown();
      return result;
    }

    it('a throw in onCommand', async () => {
      const { error, balance } = await failingCommand(() => ({ type: 'crash' }));
      expect(error).toEqual(new Error('crash requested'));
      expect(balance).toBe(10);
    });

    it('a throw in a step after a persist, once the event is written', async () => {
      const { error, events, balance } = await failingCommand(() => ({
        type: 'stepThrows',
        persist: true,
      }));
      expect(error).toEqual(new Error('step failed'));
      // The write succeeded before the step ran, so the journal has the event, and recovery
      // applies it.
      expect(events).toHaveLength(2);
      expect(balance).toBe(11);
    });

    it('a throw in a step with no events', async () => {
      const { error, balance } = await failingCommand(() => ({
        type: 'stepThrows',
        persist: false,
      }));
      expect(error).toEqual(new Error('step failed'));
      expect(balance).toBe(10);
    });

    it('a throw in onEvent, after the write', async () => {
      // Under the default stop strategy: the event is in the journal now, so a restart would
      // replay it and fail again, forever. That's why onEvent must not throw for an accepted event.
      const { store, kit, spawn } = setup();
      const ref = spawn();
      const asked = track(ref.ask<Receipt>(() => ({ type: 'poison' }), { timeoutMs: 100 }));
      await kit.advance(100);
      expect(asked.error).toBeInstanceOf(AskTimeoutError);
      const failed = ofType(kit, 'failed');
      expect(failed.map((e) => [e.error, e.directive])).toEqual([
        [new Error('poisoned event'), 'stop'],
      ]);
      expect(ofType(kit, 'persisted')).toEqual([]);
      expect(store.events(ID)).toHaveLength(1);
      await kit.shutdown();
    });

    it('a rejected append, which applies nothing', async () => {
      const { error, events, balance } = await failingCommand(
        (replyTo) => deposit(99, replyTo),
        (journal) => {
          journal.failAppends(new Error('disk full'));
        },
      );
      expect(error).toEqual(new Error('disk full'));
      expect(events).toHaveLength(1);
      expect(balance).toBe(10);
    });

    it('an event that isn’t JSON, before anything is appended', async () => {
      const { error, journal, balance } = await failingCommand(() => ({ type: 'notJson' }));
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toMatch(/account-1: event 0 is not a JSON value: \$\.amount is NaN/);
      // Only the first deposit reached the journal.
      expect(journal.appends).toHaveLength(1);
      expect(balance).toBe(10);
    });

    it('a value from onCommand that no builder made', async () => {
      const { error } = await failingCommand(() => ({ type: 'notAnEffect' }));
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toMatch(/onCommand must return an effect/);
    });

    it.each(['reply', 'thenReply', 'thenRun'] as const)('a bad argument to %s', async (how) => {
      const { error } = await failingCommand(() => ({ type: 'misuse', how }));
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toContain(`${how}:`);
    });

    it('a failed read during recovery, as a failure in the start', async () => {
      const { journal, kit, log, spawn } = setup({ supervision: supervise.restart() });
      const balances = kit.probe<number>('balances');
      journal.failReads(new Error('journal down'));
      const ref = spawn();
      ref.tell({ type: 'balance', replyTo: balances.ref });
      await kit.settle();

      expect(ofType(kit, 'failed').map((e) => e.error)).toEqual([new Error('journal down')]);
      // No state came of the failed start, so preRestart was skipped, and the command waited.
      expect(log).toEqual(['recoveryCompleted 0, balance 0']);
      balances.expectMessage(0);
      await kit.shutdown();
    });

    it('an event out of sequence during recovery', async () => {
      const { store, journal, kit, spawn } = setup();
      await store.journal.append(ID, 0, [
        { event: { type: 'deposited', amount: 1 }, version: 1, tags: [] },
        { event: { type: 'deposited', amount: 2 }, version: 1, tags: [] },
      ]);
      journal.editNextRead((events) => events.slice(1));
      spawn();
      await kit.settle();

      const [failed] = ofType(kit, 'failed');
      expect(failed?.error).toBeInstanceOf(JournalSequenceError);
      expect(failed?.error).toMatchObject({ persistenceId: ID, expected: 1, got: 2 });
      expect(failed?.directive).toBe('stop');
      expect(ofType(kit, 'recovered')).toEqual([]);
      await kit.shutdown();
    });
  });

  it('two writers: the loser fails with JournalConflictError, then recovers the winner’s events', async () => {
    const { store, kit, spawn } = setup({ supervision: supervise.restart() });
    const receipts = kit.probe<Receipt>('receipts');
    const balances = kit.probe<number>('balances');
    const a = spawn('a');
    const b = spawn('b');
    await kit.settle();

    a.tell(deposit(10, receipts.ref));
    await kit.settle();
    receipts.expectMessage({ ok: true, balance: 10 });

    // b recovered before a's write, so it appends at 0 and loses.
    const lost = track(b.ask<Receipt>((replyTo) => deposit(5, replyTo), { timeoutMs: 100 }));
    await kit.advance(100);
    expect(lost.error).toBeInstanceOf(AskTimeoutError);
    const [failed] = ofType(kit, 'failed');
    expect(failed?.path).toBe('/user/b');
    expect(failed?.error).toBeInstanceOf(JournalConflictError);
    expect(failed?.error).toMatchObject({ persistenceId: ID, expectedSeq: 0 });

    // After its restart, b sees a's event and writes after it.
    b.tell({ type: 'balance', replyTo: balances.ref });
    b.tell(deposit(5, receipts.ref));
    await kit.settle();
    balances.expectMessage(10);
    receipts.expectMessage({ ok: true, balance: 15 });

    expect(store.events(ID).map((e) => [e.seq, e.event])).toEqual([
      [1, { type: 'deposited', amount: 10 }],
      [2, { type: 'deposited', amount: 5 }],
    ]);
    await kit.shutdown();
  });

  it('publishes persisted and recovered with the right sequence numbers', async () => {
    const { store, kit, log, spawn } = setup();
    await store.journal.append(ID, 0, [
      { event: { type: 'deposited', amount: 1 }, version: 1, tags: [] },
      { event: { type: 'deposited', amount: 2 }, version: 1, tags: [] },
    ]);
    const receipts = kit.probe<Receipt>('receipts');
    const seqs = kit.probe<number>('seqs');
    const ref = spawn();
    ref.tell({ type: 'lastSeq', replyTo: seqs.ref });
    ref.tell(deposit(3, receipts.ref));
    ref.tell({ type: 'depositTwice', amount: 4, replyTo: receipts.ref });
    ref.tell({ type: 'lastSeq', replyTo: seqs.ref });
    await kit.settle();

    const strip = (event: SystemEvent) => {
      const { seq, at, ...rest } = event;
      expect([typeof seq, typeof at]).toEqual(['number', 'number']);
      return rest;
    };
    expect(ofType(kit, 'recovered').map(strip)).toEqual([
      { type: 'recovered', path: '/user/acct', persistenceId: ID, snapshotSeq: 0, lastSeq: 2 },
    ]);
    expect(ofType(kit, 'persisted').map(strip)).toEqual([
      { type: 'persisted', path: '/user/acct', persistenceId: ID, fromSeq: 3, toSeq: 3 },
      { type: 'persisted', path: '/user/acct', persistenceId: ID, fromSeq: 4, toSeq: 5 },
    ]);
    expect(seqs.messages()).toEqual([2, 5]);
    expect(log).toEqual(['recoveryCompleted 2, balance 3']);
    await kit.shutdown();
  });

  it('fails the start when onSignal throws on recoveryCompleted', async () => {
    const kit = createTestKit();
    const def = persistentActor<never, never, null>({
      id: ID,
      persistence: inMemoryPersistence({ clock }),
      initial: null,
      onCommand: (_s, _c, { none }) => none(),
      onEvent: (s) => s,
      onSignal: () => {
        throw new Error('no timers today');
      },
    });
    kit.system.spawn(def, 'acct');
    await kit.settle();
    expect(ofType(kit, 'failed').map((e) => e.error)).toEqual([new Error('no timers today')]);
    await kit.shutdown();
  });

  describe('options', () => {
    const persistence = inMemoryPersistence({ clock });
    const valid = {
      id: ID,
      persistence,
      initial: 0,
      onCommand: () => {
        throw new Error('unused');
      },
      onEvent: (s: number) => s,
    };
    /** The valid definition with `key` absent, not just undefined. */
    const without = (key: keyof typeof valid) =>
      Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));

    it.each<[string, unknown, RegExp]>([
      ['not an object', null, /options must be an object/],
      ['an unknown key', { ...valid, tags: () => [] }, /unknown option "tags"/],
      [
        'snapshots without a snapshot store',
        { ...valid, persistence: { journal: persistence.journal }, snapshots: { every: 10 } },
        /snapshots needs persistence.snapshots/,
      ],
      [
        'a snapshot store without load',
        {
          ...valid,
          persistence: { journal: persistence.journal, snapshots: { save() {} } },
          snapshots: { every: 10 },
        },
        /snapshots needs persistence.snapshots/,
      ],
      ['snapshots that isn’t an object', { ...valid, snapshots: 10 }, /options must be an object/],
      [
        'an unknown snapshot option',
        { ...valid, snapshots: { every: 10, keep: 2 } },
        /snapshots: unknown option "keep"/,
      ],
      ['no every', { ...valid, snapshots: {} }, /snapshots.every must be a positive integer/],
      ['an every of 0', { ...valid, snapshots: { every: 0 } }, /got 0/],
      ['a fractional every', { ...valid, snapshots: { every: 1.5 } }, /got 1.5/],
      [
        'a snapshot version of 0',
        { ...valid, snapshots: { every: 10, version: 0 } },
        /snapshots.version must be a positive integer, got 0/,
      ],
      ['an empty id', { ...valid, id: '' }, /id must be a string of 1 to 255 characters/],
      ['an id that is too long', { ...valid, id: 'x'.repeat(256) }, /got one of 256/],
      ['an id that isn’t a string', { ...valid, id: 7 }, /got 7/],
      ['no persistence', without('persistence'), /persistence must have a journal/],
      [
        'a journal without read',
        { ...valid, persistence: { journal: { append() {} } } },
        /journal/,
      ],
      ['a journal that isn’t an object', { ...valid, persistence: { journal: 1 } }, /journal/],
      ['no initial', without('initial'), /no initial/],
      ['no onCommand', without('onCommand'), /onCommand must be a function/],
      ['an onEvent that isn’t a function', { ...valid, onEvent: 1 }, /onEvent must be a function/],
      [
        'an onSignal that isn’t a function',
        { ...valid, onSignal: 1 },
        /onSignal must be a function/,
      ],
    ])('throws TypeError for %s', (_what, def, message) => {
      expect(() => persistentActor(def as never)).toThrow(TypeError);
      expect(() => persistentActor(def as never)).toThrow(message);
    });

    it('accepts snapshots with a store, with or without a version', () => {
      expect(() => persistentActor({ ...valid, snapshots: { every: 1 } })).not.toThrow();
      expect(() =>
        persistentActor({ ...valid, snapshots: { every: 5, version: 3 } }),
      ).not.toThrow();
    });

    it('accepts an id of 255 characters', () => {
      expect(() => persistentActor({ ...valid, id: 'x'.repeat(255) })).not.toThrow();
    });
  });

  it('keeps its internals off contexts the system didn’t make', () => {
    expect(() => internalsOf({})).toThrow(TypeError);
  });
});
