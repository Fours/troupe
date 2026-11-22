import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { inspectSystem, type CellInspection } from '../src/internal.js';
import { persistentActor } from '../src/persistence/actor.js';
import { inMemoryPersistence } from '../src/persistence/memory.js';
import { supervise } from '../src/supervision.js';
import { createActorSystem } from '../src/system.js';
import { createTestKit, type TestKit } from '../src/testkit/kit.js';
import type { ActorSystem } from '../src/types.js';
import { account } from './helpers/account.js';
import { deferred } from './helpers/deferred.js';
import { faultyJournal } from './helpers/faulty-journal.js';

/** The walk, without the persistent hook, which tests check on its own. */
function tree(system: ActorSystem): Omit<CellInspection, 'persistent'>[] {
  return inspectSystem(system)
    .walk()
    .map(({ path, status, depth, state }) => ({ path, status, depth, state }));
}

function at(kit: TestKit, path: string): CellInspection | undefined {
  return inspectSystem(kit.system)
    .walk()
    .find((c) => c.path === path);
}

type CounterMsg = 'inc' | 'crash' | 'hold';

describe('the inspection hook', () => {
  it("gives the system's scheduler", () => {
    const kit = createTestKit();
    expect(inspectSystem(kit.system).scheduler).toBe(kit.scheduler);
  });

  it("isn't visible on the system, and only a real system has one", () => {
    const kit = createTestKit();
    expect(Object.getOwnPropertySymbols({ ...kit.system })).toEqual([]);
    expect(JSON.stringify(Object.keys(kit.system))).not.toMatch(/inspect/);
    expect(() => inspectSystem({ ...kit.system })).toThrow(TypeError);
  });

  it('walks every live actor, parents before children, in spawn order', async () => {
    const kit = createTestKit();
    const leaf = actor<never, string>({ initial: 'leaf', receive: (s) => s });
    kit.system.spawn(
      actor<never, string>({
        initial: (ctx) => {
          ctx.spawn(leaf, 'b');
          ctx.spawn(leaf, 'c');
          return 'a';
        },
        receive: (s) => s,
      }),
      'a',
    );
    kit.system.spawn(leaf, 'd');
    // Spawned, but nothing has run yet.
    expect(tree(kit.system)).toEqual([
      { path: '/user/a', status: 'starting', depth: 0, state: undefined },
      { path: '/user/d', status: 'starting', depth: 0, state: undefined },
    ]);
    await kit.settle();
    expect(tree(kit.system)).toEqual([
      { path: '/user/a', status: 'running', depth: 0, state: 'a' },
      { path: '/user/a/b', status: 'running', depth: 0, state: 'leaf' },
      { path: '/user/a/c', status: 'running', depth: 0, state: 'leaf' },
      { path: '/user/d', status: 'running', depth: 0, state: 'leaf' },
    ]);
  });

  it("shows each actor's depth and its current state, the object itself", async () => {
    const kit = createTestKit();
    const gate = deferred();
    let last: { n: number } | undefined;
    const ref = kit.system.spawn(
      actor<CounterMsg, { n: number }>({
        initial: { n: 0 },
        receive: async (s, msg) => {
          if (msg === 'hold') await gate.promise;
          last = { n: s.n + 1 };
          return last;
        },
      }),
      'counter',
    );
    ref.tell('inc');
    await kit.settle();
    expect(at(kit, '/user/counter')?.state).toBe(last);
    ref.tell('hold');
    kit.scheduler.runReady();
    ref.tell('inc');
    ref.tell('inc');
    expect(at(kit, '/user/counter')).toMatchObject({
      status: 'running',
      depth: 2,
      state: { n: 1 },
    });
    gate.resolve();
    await kit.settle();
    expect(at(kit, '/user/counter')).toMatchObject({ depth: 0, state: { n: 4 } });
  });

  it('shows a restart with backoff, then the new incarnation', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(
      actor<CounterMsg, number>({
        initial: 0,
        receive: (n, msg) => {
          if (msg === 'crash') throw new Error('crash');
          return n + 1;
        },
      }),
      'counter',
      { supervision: supervise.restartWithBackoff({ minMs: 100, maxMs: 100, randomFactor: 0 }) },
    );
    // What the walk shows at the moment the restart finishes, before initial runs again.
    let atRestart: CellInspection | undefined;
    kit.system.events.subscribe((e) => {
      if (e.type === 'restarted') atRestart = at(kit, e.path);
    });
    ref.tell('inc');
    ref.tell('crash');
    ref.tell('inc');
    await kit.settle();
    // Waiting out the backoff, with the message that came after the crash still queued.
    expect(at(kit, '/user/counter')).toMatchObject({ status: 'restarting', depth: 1, state: 1 });
    await kit.advance(100);
    expect(atRestart).toMatchObject({ status: 'starting', depth: 1 });
    expect(at(kit, '/user/counter')).toMatchObject({ status: 'running', depth: 0, state: 1 });
  });

  it('shows a stop until the actor has terminated, then leaves it out', async () => {
    const kit = createTestKit();
    const gate = deferred();
    const ref = kit.system.spawn(
      actor<never, null>({
        initial: null,
        receive: (s) => s,
        onSignal: async (s, signal) => {
          if (signal.type === 'postStop') await gate.promise;
          return s;
        },
      }),
      'stopping',
    );
    await kit.settle();
    kit.system.stop(ref);
    kit.scheduler.runReady();
    expect(at(kit, '/user/stopping')?.status).toBe('stopping');
    gate.resolve();
    await kit.settle();
    expect(tree(kit.system)).toEqual([]);
  });

  it('shows a persistent actor as starting while it recovers, with its hook', async () => {
    const kit = createTestKit();
    const persistence = inMemoryPersistence();
    const journal = faultyJournal(persistence.journal);
    const def = account({ journal });
    kit.system.spawn(def, 'account');
    kit.system.spawn(actor<never, null>({ initial: null, receive: (s) => s }), 'plain');
    kit.scheduler.runReady();
    // The first read is in flight: recovery hasn't finished.
    expect(at(kit, '/user/account')).toMatchObject({ status: 'starting', state: undefined });
    await kit.settle();
    const cell = at(kit, '/user/account');
    expect(cell).toMatchObject({ status: 'running', state: { seq: 0, state: { balance: 0 } } });
    expect(cell?.persistent?.persistenceId).toBe('account-1');
    expect(cell?.persistent?.persistence.journal).toBe(journal);
    expect(at(kit, '/user/plain')?.persistent).toBeUndefined();
  });

  it('works on a system made by createActorSystem', async () => {
    const system = createActorSystem({ logger: silent });
    system.spawn(
      persistentActor<never, never, null>({
        id: 'p',
        persistence: inMemoryPersistence(),
        initial: null,
        onCommand: (_s, _c, { none }) => none(),
        onEvent: (s) => s,
      }),
      'p',
    );
    expect(
      inspectSystem(system)
        .walk()
        .map((c) => c.path),
    ).toEqual(['/user/p']);
    await system.terminate();
    expect(inspectSystem(system).walk()).toEqual([]);
  });
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };
