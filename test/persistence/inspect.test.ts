import { describe, expect, it } from 'vitest';
import { show, type ShowState } from '../../examples/box-office/box-office.ts';
import { narrator } from '../../examples/box-office/narrate.ts';
import { runScenario, SHOWS } from '../../examples/box-office/scenario.ts';
import { inspectSystem, persistentHookOf, type PersistentHook } from '../../src/internal.js';
import { persistentActor, type PersistentState } from '../../src/persistence/actor.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import type { Persistence } from '../../src/persistence/types.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import type { ActorRef } from '../../src/types.js';
import { account } from '../helpers/account.js';
import { faultyJournal } from '../helpers/faulty-journal.js';
import { faultySnapshots } from '../helpers/faulty-snapshots.js';

function hookOf(def: object): PersistentHook {
  const hook = persistentHookOf(def);
  if (hook === undefined) throw new Error('not a persistent actor');
  return hook;
}

/**
 * Runs the box office example's two acts on one in-memory backend, and records each show's live
 * state after every event it persisted, read from the tree walk when the command that persisted
 * it was processed. That's the write path, so it's an oracle that doesn't share `stateAt`'s fold.
 */
async function boxOfficeRun() {
  const persistence = inMemoryPersistence({ clock: () => 0 });
  const live = new Map<string, Map<number, ShowState>>();
  const kits: TestKit[] = [];
  await runScenario({
    open: () => {
      const kit = createTestKit({ system: { name: 'box-office' } });
      kits.push(kit);
      kit.system.events.subscribe(
        (e) => {
          if (e.type !== 'processed' || !e.stateChanged) return;
          const cell = inspectSystem(kit.system)
            .walk()
            .find((c) => c.path === e.path);
          if (cell?.persistent === undefined) return;
          const { seq, state } = cell.state as PersistentState<ShowState>;
          const states = live.get(cell.persistent.persistenceId) ?? new Map<number, ShowState>();
          states.set(seq, state);
          live.set(cell.persistent.persistenceId, states);
        },
        { messages: true },
      );
      return {
        system: kit.system,
        persistence,
        narrator: narrator(
          () => kit.scheduler.now(),
          () => {},
        ),
        sleep: (ms) => kit.advance(ms),
        shutdown: () => kit.shutdown(),
      };
    },
  });
  return { persistence, live, kits };
}

type Counter = { type: 'add'; amount: number; replyTo: ActorRef<number> };
type Added = { type: 'added'; amount: number };

/** A counter whose events moved from `{ add }` (version 1) to `{ type, amount }` (version 2). */
function counter(persistence: Persistence) {
  return persistentActor<Counter, Added, number>({
    id: 'counter',
    persistence,
    initial: 0,
    onCommand: (_n, cmd, { persist }) =>
      persist({ type: 'added', amount: cmd.amount }).thenReply(cmd.replyTo, (n) => n),
    onEvent: (n, event) => n + event.amount,
    events: {
      version: 2,
      upcasters: { 1: (old) => ({ type: 'added', amount: (old as { add: number }).add }) },
    },
  });
}

describe('stateAt', () => {
  it("equals the state after n events, for every n of the box office's journal", async () => {
    const { persistence, live } = await boxOfficeRun();
    for (const [name, capacity] of Object.entries(SHOWS)) {
      const hook = hookOf(show(name, capacity, persistence));
      const states = live.get(hook.persistenceId);
      const stored = await persistence.journal.read(hook.persistenceId, 1, 1000);
      // The scenario persisted something for every show, each event by a command.
      expect(stored.length).toBeGreaterThan(2);
      expect([...(states?.keys() ?? [])].sort((a, b) => a - b)).toEqual(stored.map((e) => e.seq));
      expect(await hook.stateAt(0)).toEqual({ sold: 0, holds: {}, nextId: 1 });
      for (const { seq } of stored) {
        expect(await hook.stateAt(seq), `${name} after event ${String(seq)}`).toEqual(
          states?.get(seq),
        );
      }
    }
  });

  it('upcasts old events as recovery does', async () => {
    const persistence = inMemoryPersistence({ clock: () => 0 });
    await persistence.journal.append('counter', 0, [
      { event: { add: 1 }, version: 1, tags: [] },
      { event: { add: 2 }, version: 1, tags: [] },
      { event: { add: 3 }, version: 1, tags: [] },
    ]);
    const kit = createTestKit();
    const probe = kit.probe<number>();
    const ref = kit.system.spawn(counter(persistence), 'counter');
    ref.tell({ type: 'add', amount: 10, replyTo: probe.ref });
    ref.tell({ type: 'add', amount: 20, replyTo: probe.ref });
    await kit.settle();
    expect(probe.messages()).toEqual([16, 36]);

    const hook = hookOf(counter(persistence));
    const states = [];
    for (let n = 0; n <= 5; n++) states.push(await hook.stateAt(n));
    expect(states).toEqual([0, 1, 3, 6, 16, 36]);
  });

  it("doesn't touch the live actor, and works once it has stopped", async () => {
    const kit = createTestKit();
    const store = inMemoryPersistence();
    const snapshots = faultySnapshots(store.snapshots);
    const persistence = { journal: store.journal, snapshots };
    const def = account(persistence, { snapshots: { every: 2 } });
    const probe = kit.probe<unknown>();
    const ref = kit.system.spawn(def, 'account');
    for (const amount of [1, 2, 3]) ref.tell({ type: 'deposit', amount, replyTo: probe.ref });
    await kit.settle();
    const before = inspectSystem(kit.system).walk()[0]?.state;
    const eventsBefore = kit.events.length;
    const loadsBefore = snapshots.loads;

    const hook = hookOf(def);
    expect(await hook.stateAt(2)).toEqual({ balance: 3, closed: false });
    expect(await hook.stateAt(3)).toEqual({ balance: 6, closed: false });
    await kit.settle();
    expect(inspectSystem(kit.system).walk()[0]?.state).toBe(before);
    expect(kit.events).toHaveLength(eventsBefore);
    // A snapshot exists at 2, but stateAt never loads one.
    expect(snapshots.saves.map((s) => s.seq)).toEqual([2]);
    expect(snapshots.loads).toBe(loadsBefore);

    kit.system.stop(ref);
    await kit.settle();
    expect(await hook.stateAt(1)).toEqual({ balance: 1, closed: false });
  });

  it('reads in pages of 256, and no further than it needs', async () => {
    const memory = inMemoryPersistence();
    const journal = faultyJournal(memory.journal);
    await memory.journal.append(
      'counter',
      0,
      Array.from({ length: 600 }, () => ({
        event: { type: 'added', amount: 1 },
        version: 2,
        tags: [],
      })),
    );
    const hook = hookOf(counter({ journal }));
    expect(await hook.stateAt(600)).toBe(600);
    expect(journal.reads).toEqual([
      { fromSeq: 1, limit: 256 },
      { fromSeq: 257, limit: 256 },
      { fromSeq: 513, limit: 88 },
    ]);
    expect(await hook.stateAt(300)).toBe(300);
    expect(journal.reads.slice(3)).toEqual([
      { fromSeq: 1, limit: 256 },
      { fromSeq: 257, limit: 44 },
    ]);
    expect(await hook.stateAt(0)).toBe(0);
    expect(journal.reads).toHaveLength(5);
  });

  it('rejects a seq past the end, or one that is not a non-negative integer', async () => {
    const persistence = inMemoryPersistence();
    await persistence.journal.append('counter', 0, [
      { event: { type: 'added', amount: 1 }, version: 2, tags: [] },
    ]);
    const hook = hookOf(counter(persistence));
    await expect(hook.stateAt(2)).rejects.toThrow(
      new RangeError('counter: the journal ends at event 1, before 2'),
    );
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
      await expect(hook.stateAt(bad)).rejects.toThrow(TypeError);
    }
  });

  it('is on persistent definitions only, and hidden from spreads', () => {
    const persistence = inMemoryPersistence();
    const def = counter(persistence);
    expect(hookOf(def)).toMatchObject({ persistenceId: 'counter', persistence });
    expect(Object.isFrozen(hookOf(def))).toBe(true);
    expect(persistentHookOf({ ...def })).toBeUndefined();
  });
});
