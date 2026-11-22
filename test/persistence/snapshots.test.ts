import { describe, expect, it } from 'vitest';
import { persistentActor } from '../../src/persistence/actor.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import type { Persistence } from '../../src/persistence/types.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import type { ActorRef, SystemEvent } from '../../src/types.js';
import { account, type AccountCmd, type Receipt } from '../helpers/account.js';
import { faultyJournal } from '../helpers/faulty-journal.js';
import { faultySnapshots } from '../helpers/faulty-snapshots.js';

const ID = 'account-1';

/** A clock for the backend's timestamps, so nothing reads the wall clock. */
const clock = () => 1_000;

function setup(snapshots: { every: number; version?: number } = { every: 3 }) {
  const store = inMemoryPersistence({ clock });
  const journal = faultyJournal(store.journal);
  const snaps = faultySnapshots(store.snapshots);
  const persistence: Persistence = { journal, snapshots: snaps };
  const newKit = () => {
    const kit = createTestKit();
    const spawn = (opts: { version?: number } = {}) =>
      kit.system.spawn(
        account(persistence, {
          snapshots: opts.version === undefined ? snapshots : { ...snapshots, ...opts },
        }),
        'acct',
      );
    return { kit, spawn };
  };
  return { store, journal, snaps, persistence, newKit, ...newKit() };
}

const ofType = <T extends SystemEvent['type']>(kit: TestKit, type: T) =>
  kit.events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);

const deposit = (replyTo: ActorRef<Receipt>): AccountCmd => ({
  type: 'deposit',
  amount: 1,
  replyTo,
});
const depositTwice = (replyTo: ActorRef<Receipt>): AccountCmd => ({
  type: 'depositTwice',
  amount: 1,
  replyTo,
});

const logsAt = (kit: TestKit, level: string) =>
  kit.logs.filter((entry) => entry.level === level).map((entry) => entry.msg);

describe('snapshots', () => {
  it('saves at 3, 6 and 9 with every: 3, when a batch ends on a multiple', async () => {
    const { store, snaps, kit, spawn } = setup();
    const receipts = kit.probe<Receipt>();
    const ref = spawn();
    // Sequence numbers: 1, then 2-3, 4-5, 6, 7, 8-9, 10.
    for (const make of [
      deposit,
      depositTwice,
      depositTwice,
      deposit,
      deposit,
      depositTwice,
      deposit,
    ]) {
      ref.tell(make(receipts.ref));
    }
    await kit.settle();

    expect(snaps.saves.map((s) => s.seq)).toEqual([3, 6, 9]);
    expect(await store.snapshots.load(ID)).toEqual({
      seq: 9,
      version: 1,
      state: { balance: 9, closed: false },
      timestamp: 1_000,
    });
    // Events are never deleted after a snapshot.
    expect(store.events(ID).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await kit.shutdown();
  });

  it('saves at the new lastSeq when one persist crosses a multiple', async () => {
    const { snaps, kit, spawn } = setup();
    const receipts = kit.probe<Receipt>();
    const ref = spawn();
    // 1, 2, then 3-4 crosses 3, then 5-6 crosses 6.
    for (const make of [deposit, deposit, depositTwice, depositTwice]) ref.tell(make(receipts.ref));
    await kit.settle();

    expect(snaps.saves).toEqual([
      { seq: 4, version: 1, state: { balance: 4, closed: false } },
      { seq: 6, version: 1, state: { balance: 6, closed: false } },
    ]);
    await kit.shutdown();
  });

  it('recovers from the latest snapshot and replays only the events after it', async () => {
    const { store, journal, kit, spawn, newKit } = setup();
    const receipts = kit.probe<Receipt>();
    const ref = spawn();
    for (let i = 0; i < 4; i++) ref.tell(deposit(receipts.ref));
    await kit.settle();
    await kit.shutdown();
    // A snapshot whose state no replay could produce, so the balance shows where recovery began.
    await store.snapshots.save(ID, { seq: 3, version: 1, state: { balance: 100, closed: false } });

    const second = newKit();
    const reads = journal.reads.length;
    const balances = second.kit.probe<number>();
    second.spawn().tell({ type: 'balance', replyTo: balances.ref });
    await second.kit.settle();

    balances.expectMessage(101);
    expect(journal.reads.slice(reads)).toEqual([{ fromSeq: 4, limit: 256 }]);
    expect(ofType(second.kit, 'recovered')).toMatchObject([{ snapshotSeq: 3, lastSeq: 4 }]);
    await second.kit.shutdown();
  });

  it('ignores a snapshot with another version, and replays everything', async () => {
    const { store, journal, snaps, kit, spawn, newKit } = setup();
    const receipts = kit.probe<Receipt>();
    const ref = spawn();
    for (let i = 0; i < 4; i++) ref.tell(deposit(receipts.ref));
    await kit.settle();
    await kit.shutdown();
    expect(snaps.saves.map((s) => s.version)).toEqual([1]);

    // The state's shape changed, so the definition moved to version 2.
    const second = newKit();
    const reads = journal.reads.length;
    const balances = second.kit.probe<number>();
    const ref2 = second.spawn({ version: 2 });
    ref2.tell({ type: 'balance', replyTo: balances.ref });
    for (let i = 0; i < 2; i++) ref2.tell(deposit(second.kit.probe<Receipt>().ref));
    await second.kit.settle();

    balances.expectMessage(4);
    expect(journal.reads.slice(reads)).toEqual([{ fromSeq: 1, limit: 256 }]);
    expect(ofType(second.kit, 'recovered')).toMatchObject([{ snapshotSeq: 0, lastSeq: 4 }]);
    expect(logsAt(second.kit, 'info')).toContainEqual(
      expect.stringMatching(/ignoring the snapshot at 3, which has version 1, not 2/),
    );
    // New snapshots carry the new version.
    expect(await store.snapshots.load(ID)).toMatchObject({ seq: 6, version: 2 });
    await second.kit.shutdown();
  });

  it('logs a snapshot that fails to load at warn, and recovers by replaying every event', async () => {
    const { journal, snaps, kit, spawn, newKit } = setup();
    const receipts = kit.probe<Receipt>();
    const ref = spawn();
    for (let i = 0; i < 4; i++) ref.tell(deposit(receipts.ref));
    await kit.settle();
    await kit.shutdown();

    snaps.failLoads(new Error('snapshot store down'));
    const second = newKit();
    const reads = journal.reads.length;
    const balances = second.kit.probe<number>();
    second.spawn().tell({ type: 'balance', replyTo: balances.ref });
    await second.kit.settle();

    balances.expectMessage(4);
    expect(journal.reads.slice(reads)).toEqual([{ fromSeq: 1, limit: 256 }]);
    expect(ofType(second.kit, 'recovered')).toMatchObject([{ snapshotSeq: 0, lastSeq: 4 }]);
    expect(ofType(second.kit, 'failed')).toEqual([]);
    const warning = second.kit.logs.find((entry) => entry.level === 'warn');
    expect(warning?.msg).toMatch(/loading the snapshot failed, so recovery replays every event/);
    expect(warning?.fields).toMatchObject({ path: '/user/acct', persistenceId: ID });
    expect((warning?.fields?.error as Error).message).toBe('snapshot store down');
    await second.kit.shutdown();
  });

  it('logs a snapshot that fails to save at warn, and carries on', async () => {
    const { store, snaps, kit, spawn } = setup();
    const receipts = kit.probe<Receipt>();
    const ref = spawn();
    snaps.failSaves(new Error('disk full'));
    for (let i = 0; i < 4; i++) ref.tell(deposit(receipts.ref));
    await kit.settle();

    expect(receipts.messages().map((r) => r.ok && r.balance)).toEqual([1, 2, 3, 4]);
    expect(snaps.saves.map((s) => s.seq)).toEqual([3]);
    expect(await store.snapshots.load(ID)).toBeUndefined();
    expect(ofType(kit, 'failed')).toEqual([]);
    const warning = kit.logs.find((entry) => entry.level === 'warn');
    expect(warning?.msg).toMatch(/saving the snapshot at 3 failed/);
    expect(warning?.fields).toMatchObject({ persistenceId: ID, seq: 3 });
    await kit.shutdown();
  });

  it('logs a state that isn’t JSON at error, and saves nothing', async () => {
    const store = inMemoryPersistence({ clock });
    const snaps = faultySnapshots(store.snapshots);
    const kit = createTestKit();
    const replies = kit.probe<number>();
    // A Date in the state breaks decision 0001: JSON would hand back a string.
    const ref = kit.system.spawn(
      persistentActor<ActorRef<number>, { type: 'ticked' }, { n: number; at?: Date }>({
        id: 'clock-1',
        persistence: { journal: store.journal, snapshots: snaps },
        initial: { n: 0 },
        snapshots: { every: 1 },
        onCommand: (_state, replyTo, { persist }) =>
          persist({ type: 'ticked' }).thenReply(replyTo, (s) => s.n),
        onEvent: (state) => ({ n: state.n + 1, at: new Date(0) }),
      }),
      'clock',
    );
    ref.tell(replies.ref);
    ref.tell(replies.ref);
    await kit.settle();

    expect(replies.messages()).toEqual([1, 2]);
    expect(snaps.saves).toEqual([]);
    expect(ofType(kit, 'failed')).toEqual([]);
    const errors = kit.logs.filter((entry) => entry.level === 'error');
    expect(errors.map((e) => e.msg)).toEqual([
      expect.stringMatching(/state is not a JSON value, so no snapshot was saved: \$\.at/),
      expect.stringMatching(/state is not a JSON value/),
    ]);
    expect(errors[0]?.fields).toMatchObject({
      path: '/user/clock',
      persistenceId: 'clock-1',
      seq: 1,
    });
    await kit.shutdown();
  });

  it('doesn’t hold the mailbox for a slow save, and settle() waits for it', async () => {
    const { store, kit, spawn, snaps } = setup();
    const receipts = kit.probe<Receipt>();
    const balances = kit.probe<number>();
    const ref = spawn();
    const held = snaps.holdNextSave();
    for (let i = 0; i < 3; i++) ref.tell(deposit(receipts.ref));
    let settled = false;
    const settling = kit.settle().then(() => {
      settled = true;
    });
    await held.reached;

    // The save is in flight, and settle() is still turning the event loop. The next command runs
    // on its next turn: nothing holds the mailbox.
    ref.tell({ type: 'balance', replyTo: balances.ref });
    await new Promise((resolve) => setTimeout(resolve, 0));
    balances.expectMessage(3);
    expect(await store.snapshots.load(ID)).toBeUndefined();

    // A few more turns, and settle() is still waiting for the save.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    held.release();
    await settling;
    expect(await store.snapshots.load(ID)).toMatchObject({ seq: 3 });
    await kit.shutdown();
  });
});
