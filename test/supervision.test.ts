import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { ActorStoppedError } from '../src/errors.js';
import { supervise, type SupervisorStrategy } from '../src/supervision.js';
import { createTestKit, type TestKit } from '../src/testkit/kit.js';
import { seededRandom } from '../src/testkit/random.js';
import type { ActorContext, ActorRef, AnyRef, SystemEvent } from '../src/types.js';
import { idle, tree, watcher } from './helpers/actors.js';

type Msg =
  | { type: 'add'; n: number }
  | { type: 'fail'; error: unknown }
  | { type: 'failAsync'; error: unknown }
  | { type: 'report'; to: ActorRef<number> }
  | { type: 'watch'; ref: AnyRef };

interface WorkerOpts {
  readonly log?: string[];
  /** Children spawned by name in initial, as tree actors that log their postStop. */
  readonly kids?: readonly string[];
  /** Called on each initial; initial throws when it returns true. */
  readonly initialFails?: () => boolean;
  readonly preRestart?: 'throw' | 'reject' | 'async';
  /** Collects every incarnation's ctx. */
  readonly ctxs?: ActorContext<Msg>[];
}

/** An adder whose state is a number, and which fails on demand. */
function worker(o: WorkerOpts = {}) {
  const log = o.log ?? [];
  return actor<Msg, number>({
    initial: (ctx) => {
      o.ctxs?.push(ctx);
      if (o.initialFails?.()) throw new Error('initial failed');
      for (const kid of o.kids ?? []) ctx.spawn(tree({ name: kid }, log), kid);
      log.push('initial');
      return 0;
    },
    receive: (n, msg, ctx) => {
      switch (msg.type) {
        case 'add':
          return n + msg.n;
        case 'fail':
          throw msg.error;
        case 'failAsync':
          // Tests reject with values that aren't Errors on purpose.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(msg.error);
        case 'report':
          msg.to.tell(n);
          return n;
        case 'watch':
          ctx.watch(msg.ref);
          return n;
      }
    },
    onSignal: (n, signal) => {
      switch (signal.type) {
        case 'preRestart':
          log.push(`preRestart ${String(n)} ${String(signal.error)}`);
          if (o.preRestart === 'throw') throw new Error('preRestart broke');
          if (o.preRestart === 'reject') return Promise.reject(new Error('preRestart broke'));
          if (o.preRestart === 'async') {
            return Promise.resolve().then(() => {
              log.push('preRestart done');
              return n;
            });
          }
          return n;
        case 'postStop':
          log.push(`postStop ${String(n)}`);
          return n;
        case 'terminated':
          log.push(`saw ${signal.ref.path}`);
          return n;
      }
    },
  });
}

const fail = (error: unknown = 'boom'): Msg => ({ type: 'fail', error });
const add = (n: number): Msg => ({ type: 'add', n });

function ofType<T extends SystemEvent['type']>(kit: TestKit, type: T) {
  return kit.events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);
}

/** Moves virtual time on, then settles. `kit.advance` replaces this in T6. */
async function advance(kit: TestKit, ms: number): Promise<void> {
  kit.scheduler.advanceTo(kit.scheduler.now() + ms);
  await kit.settle();
}

/** Asks the actor for its state through a probe. */
async function stateOf(kit: TestKit, ref: ActorRef<Msg>): Promise<number> {
  const probe = kit.probe<number>();
  ref.tell({ type: 'report', to: probe.ref });
  await kit.settle();
  return probe.expectMessage();
}

describe('the default strategy', () => {
  it('stops, with failure on terminated and a failed event that records the directive', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ref = kit.system.spawn(worker(), 'w');
    kit.system.spawn(watcher(log), 'watcher').tell({ watch: ref });
    await kit.settle();
    ref.tell(fail('boom'));
    await kit.settle();

    expect(log).toEqual(['watcher saw /user/w fail: boom']);
    expect(ofType(kit, 'failed')).toMatchObject([
      { path: '/user/w', error: 'boom', directive: 'stop' },
    ]);
    expect(ofType(kit, 'stopped')).toMatchObject([{ path: '/user/w', failure: 'boom' }]);
    expect(ofType(kit, 'restarted')).toEqual([]);
    expect(kit.logs).toMatchObject([
      { level: 'error', msg: 'actor failed', fields: { path: '/user/w', directive: 'stop' } },
    ]);
  });
});

describe('failure sources', () => {
  const once = () => {
    let failed = false;
    return () => !failed && (failed = true);
  };
  const sources: [string, unknown, (kit: TestKit, strategy: SupervisorStrategy) => void][] = [
    [
      'a throw in receive',
      'boom',
      (kit, s) => {
        kit.system.spawn(worker(), 'w', { supervision: s }).tell(fail('boom'));
      },
    ],
    [
      'a rejection in async receive',
      'boom',
      (kit, s) => {
        kit.system
          .spawn(worker(), 'w', { supervision: s })
          .tell({ type: 'failAsync', error: 'boom' });
      },
    ],
    [
      'a throw in initial',
      undefined,
      (kit, s) => {
        kit.system.spawn(worker({ initialFails: once() }), 'w', { supervision: s });
      },
    ],
    [
      'a throw in a terminated handler',
      'saw it',
      (kit, s) => {
        const target = kit.system.spawn(idle, 'target');
        // Only the first incarnation watches: a new one would see the stopped target and fail again.
        const first = once();
        kit.system.spawn(
          actor<null, null>({
            initial: (ctx) => {
              if (first()) ctx.watch(target);
              return null;
            },
            receive: (st) => st,
            onSignal: (st, signal) => {
              // A thrown value that isn't an Error is still a failure.
              // eslint-disable-next-line @typescript-eslint/only-throw-error
              if (signal.type === 'terminated') throw 'saw it';
              return st;
            },
          }),
          'w',
          { supervision: s },
        );
        kit.system.stop(target);
      },
    ],
    [
      'a thrown string',
      'just a string',
      (kit, s) => {
        kit.system.spawn(worker(), 'w', { supervision: s }).tell(fail('just a string'));
      },
    ],
    [
      'a thrown number',
      42,
      (kit, s) => {
        kit.system.spawn(worker(), 'w', { supervision: s }).tell(fail(42));
      },
    ],
    [
      'throw undefined',
      undefined,
      (kit, s) => {
        kit.system
          .spawn(worker(), 'w', { supervision: s })
          .tell({ type: 'fail', error: undefined });
      },
    ],
  ];

  for (const [what, error, setup] of sources) {
    it(`supervises ${what}`, async () => {
      const kit = createTestKit();
      setup(kit, supervise.restart());
      await kit.settle();
      const failed = ofType(kit, 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ path: '/user/w', directive: 'restart' });
      if (what !== 'a throw in initial') expect(failed[0]?.error).toBe(error);
      expect(ofType(kit, 'restarted')).toMatchObject([{ path: '/user/w', attempt: 1, delayMs: 0 }]);
      expect(ofType(kit, 'stopped').filter((e) => e.path === '/user/w')).toEqual([]);
    });
  }
});

describe('resume', () => {
  it('keeps the state and drops only the failing message', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ref = kit.system.spawn(worker({ log }), 'w', { supervision: supervise.resume() });
    ref.tell(add(1));
    ref.tell(fail());
    ref.tell(add(2));
    ref.tell({ type: 'failAsync', error: 'later' });
    ref.tell(add(4));
    expect(await stateOf(kit, ref)).toBe(7);
    expect(ofType(kit, 'failed').map((e) => e.directive)).toEqual(['resume', 'resume']);
    expect(log).toEqual(['initial']);
    expect(ofType(kit, 'stopped')).toEqual([]);
  });

  it('stops when initial fails, since there is no state to keep', async () => {
    const kit = createTestKit();
    kit.system.spawn(worker({ initialFails: () => true }), 'w', {
      supervision: supervise.resume(),
    });
    await kit.settle();
    expect(ofType(kit, 'failed')).toMatchObject([{ directive: 'stop' }]);
    expect(ofType(kit, 'stopped')).toMatchObject([{ path: '/user/w' }]);
  });
});

describe('restart', () => {
  it('runs preRestart with the old state, stops the children, and runs initial again', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    kit.system.events.subscribe((e) => {
      if (e.type === 'stopped' || e.type === 'restarted') log.push(`${e.type} ${e.path}`);
    });
    const ctxs: ActorContext<Msg>[] = [];
    const ref = kit.system.spawn(worker({ log, kids: ['a', 'b'], ctxs }), 'w', {
      supervision: supervise.restart(),
    });
    ref.tell(add(5));
    ref.tell(fail('boom'));
    ref.tell(add(1));
    expect(await stateOf(kit, ref)).toBe(1);

    expect(log).toEqual([
      'initial',
      'preRestart 5 boom',
      // The children stop side by side, and the restart waits for both.
      'a postStop',
      'b postStop',
      'stopped /user/w/a',
      'stopped /user/w/b',
      'restarted /user/w',
      'initial',
    ]);
    // The children were spawned again under the same names.
    expect(ofType(kit, 'spawned').map((e) => e.path)).toEqual([
      '/user/w',
      '/user/w/a',
      '/user/w/b',
      '/user/w/a',
      '/user/w/b',
    ]);
    // Each incarnation gets its own ctx, behind the same ref.
    expect(ctxs).toHaveLength(2);
    expect(ctxs[0]).not.toBe(ctxs[1]);
    expect(ctxs.every((c) => c.self === ref)).toBe(true);
  });

  it('keeps the mailbox, the ref and the watchers', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ref = kit.system.spawn(worker(), 'w', { supervision: supervise.restart() });
    kit.system.spawn(watcher(log), 'watcher').tell({ watch: ref });
    await kit.settle();
    ref.tell(fail());
    ref.tell(add(2));
    ref.tell(add(3));
    expect(await stateOf(kit, ref)).toBe(5);
    expect(log).toEqual([]);

    kit.system.stop(ref);
    await kit.settle();
    expect(log).toEqual(['watcher saw /user/w']);
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([]);
  });

  it("makes the old ctx stale and drops the actor's own watches", async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ctxs: ActorContext<Msg>[] = [];
    const ref = kit.system.spawn(worker({ log, ctxs }), 'w', { supervision: supervise.restart() });
    const target = kit.system.spawn(idle, 'target');
    const other = kit.system.spawn(idle, 'other');
    ref.tell({ type: 'watch', ref: target });
    ref.tell(fail());
    await kit.settle();

    const old = ctxs[0];
    if (!old) throw new Error('no first ctx');
    expect(() => old.spawn(idle)).toThrow(ActorStoppedError);
    old.watch(other);
    kit.system.stop(target);
    kit.system.stop(other);
    await kit.settle();
    // Neither the watch made before the restart nor the old ctx's watch survives it.
    expect(log).toEqual(['initial', 'preRestart 0 boom', 'initial']);
    // The current ctx still works.
    expect(ctxs[1]?.spawn(idle).path).toBe('/user/w/$1');
  });

  it('awaits an async preRestart before stopping the children', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ref = kit.system.spawn(worker({ log, kids: ['a'], preRestart: 'async' }), 'w', {
      supervision: supervise.restart(),
    });
    ref.tell(fail());
    await kit.settle();
    expect(log).toEqual([
      'initial',
      'preRestart 0 boom',
      'preRestart done',
      'a postStop',
      'initial',
    ]);
  });

  it('counts a failing initial as another failure, so maxRestarts ends a restart loop', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    let broken = false;
    const ref = kit.system.spawn(worker({ log, initialFails: () => broken }), 'w', {
      supervision: supervise.restart({ maxRestarts: 3, withinMs: 1000 }),
    });
    await kit.settle();
    broken = true;
    ref.tell(fail());
    await kit.settle();
    expect(ofType(kit, 'restarted').map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(ofType(kit, 'failed').map((e) => e.directive)).toEqual([
      'restart',
      'restart',
      'restart',
      'stop',
    ]);
    // preRestart only runs when there's a state, so only for the first failure.
    expect(log.filter((l) => l.startsWith('preRestart'))).toHaveLength(1);
    expect(ofType(kit, 'stopped')).toMatchObject([{ path: '/user/w' }]);
  });
});

describe('restart limits', () => {
  const limited = () => supervise.restart({ maxRestarts: 2, withinMs: 1000 });

  it('stops on the third failure inside the window', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(worker(), 'w', { supervision: limited() });
    ref.tell(fail('1'));
    await advance(kit, 400);
    ref.tell(fail('2'));
    await advance(kit, 599);
    ref.tell(fail('3'));
    await kit.settle();
    expect(ofType(kit, 'failed').map((e) => e.directive)).toEqual(['restart', 'restart', 'stop']);
    expect(ofType(kit, 'stopped')).toMatchObject([{ path: '/user/w', failure: '3' }]);
  });

  it('allows it once the window has passed the oldest failure', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(worker(), 'w', { supervision: limited() });
    ref.tell(fail()); // t=0
    await advance(kit, 400);
    ref.tell(fail()); // t=400
    await advance(kit, 600);
    ref.tell(fail()); // t=1000: the failure at 0 has left the window
    await advance(kit, 300);
    ref.tell(fail()); // t=1300: 400, 1000 and 1300 are all inside it
    await kit.settle();
    expect(ofType(kit, 'failed').map((e) => e.directive)).toEqual([
      'restart',
      'restart',
      'restart',
      'stop',
    ]);
    expect(ofType(kit, 'restarted').map((e) => e.attempt)).toEqual([1, 2, 2]);
  });

  it('restarts without limit by default', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(worker(), 'w', { supervision: supervise.restart() });
    for (let i = 0; i < 50; i++) ref.tell(fail());
    ref.tell(add(1));
    expect(await stateOf(kit, ref)).toBe(1);
    expect(ofType(kit, 'restarted')).toHaveLength(50);
    expect(ofType(kit, 'restarted').at(-1)?.attempt).toBe(50);
  });
});

describe('backoff', () => {
  const opts = { minMs: 100, maxMs: 1000, randomFactor: 0.5, resetAfterMs: 5000 };
  const strategy = () => supervise.restartWithBackoff(opts);
  /** The formula, worked out from the same seed, draw by draw. */
  const expected = (seed: number, ns: readonly number[]) => {
    const random = seededRandom(seed);
    return ns.map((n) =>
      Math.round(Math.min(opts.maxMs, opts.minMs * 2 ** n) * (1 + random() * opts.randomFactor)),
    );
  };

  it('follows the formula exactly under a seeded random, capped at maxMs', async () => {
    const kit = createTestKit({ seed: 7 });
    const ref = kit.system.spawn(worker(), 'w', { supervision: strategy() });
    const delays = expected(7, [0, 1, 2, 3, 4, 5]);
    for (const delay of delays) {
      ref.tell(fail());
      await kit.settle();
      await advance(kit, delay);
    }
    const restarted = ofType(kit, 'restarted');
    expect(restarted.map((e) => e.delayMs)).toEqual(delays);
    expect(restarted.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    // Each restart lands exactly its delay after its failure.
    const failed = ofType(kit, 'failed');
    expect(restarted.map((e, i) => e.at - (failed[i]?.at ?? NaN))).toEqual(delays);
    // From n = 4, minMs * 2^n passes maxMs, so jitter applies to maxMs.
    expect(delays[4]).toBeGreaterThanOrEqual(1000);
    expect(delays[5]).toBeLessThanOrEqual(1500);
    // Pinned, so a change to the formula or the generator can't pass unnoticed.
    expect(delays).toMatchInlineSnapshot(`
      [
        101,
        206,
        595,
        1080,
        1261,
        1203,
      ]
    `);
  });

  it('holds messages during the delay, and processes them after it', async () => {
    const kit = createTestKit({ seed: 3 });
    const ref = kit.system.spawn(worker(), 'w', { supervision: strategy() });
    const [delay = NaN] = expected(3, [0]);
    const probe = kit.probe<number>();
    ref.tell(fail());
    ref.tell(add(2));
    ref.tell({ type: 'report', to: probe.ref });
    await kit.settle();
    await advance(kit, delay - 1);
    probe.expectNoMessage();
    await advance(kit, 1);
    expect(probe.expectMessage()).toBe(2);
  });

  it('resets the count once the actor has run for resetAfterMs without failing', async () => {
    const kit = createTestKit({ seed: 11 });
    const ref = kit.system.spawn(worker(), 'w', { supervision: strategy() });
    const delays = expected(11, [0, 1, 2, 0]);
    ref.tell(fail());
    await advance(kit, delays[0] ?? NaN);
    ref.tell(fail());
    await advance(kit, delays[1] ?? NaN);
    // Just short of resetAfterMs: the count carries on.
    await advance(kit, opts.resetAfterMs - 1);
    ref.tell(fail());
    await advance(kit, delays[2] ?? NaN);
    // A full resetAfterMs: the count goes back to 0.
    await advance(kit, opts.resetAfterMs);
    ref.tell(fail());
    await advance(kit, delays[3] ?? NaN);
    const restarted = ofType(kit, 'restarted');
    expect(restarted.map((e) => e.attempt)).toEqual([1, 2, 3, 1]);
    expect(restarted.map((e) => e.delayMs)).toEqual(delays);
  });

  it('cancels the restart when the actor is stopped during the delay', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const ref = kit.system.spawn(worker({ log }), 'w', { supervision: strategy() });
    ref.tell(add(3));
    ref.tell(fail());
    ref.tell(add(1));
    await kit.settle();
    expect(kit.scheduler.pendingTimers()).toBe(1);
    kit.system.stop(ref);
    await kit.settle();
    // The backoff timer is cancelled, not left to fire into a stopped actor.
    expect(kit.scheduler.pendingTimers()).toBe(0);
    await advance(kit, opts.maxMs * 2);
    expect(ofType(kit, 'restarted')).toEqual([]);
    expect(log).toEqual(['initial', 'preRestart 3 boom', 'postStop 3']);
    // A requested stop, so no failure on it.
    expect(ofType(kit, 'stopped')[0]).not.toHaveProperty('failure');
    expect(ofType(kit, 'deadLetter')).toMatchObject([{ message: add(1), reason: 'stopped' }]);
  });
});

describe('backoff with a minimum delay', () => {
  // Steadfast's step children: a model error with a retry-after, wrapped in the step's failure.
  class ModelError extends Error {
    constructor(readonly retryAfterMs?: number) {
      super('rate limited');
    }
  }
  const rateLimited = (retryAfterMs?: number) =>
    new Error('model call failed', { cause: new ModelError(retryAfterMs) });
  const retryAfter = (failure: unknown) =>
    failure instanceof Error && failure.cause instanceof ModelError
      ? failure.cause.retryAfterMs
      : undefined;
  const opts = { minMs: 1000, maxMs: 60_000, randomFactor: 0.2 };
  /** The formula with a minimum per restart, worked out from the same seed, draw by draw. */
  const expected = (seed: number, steps: readonly (readonly [n: number, minimum: number])[]) => {
    const random = seededRandom(seed);
    return steps.map(([n, minimum]) =>
      Math.round(
        Math.max(Math.min(opts.maxMs, opts.minMs * 2 ** n), minimum) *
          (1 + random() * opts.randomFactor),
      ),
    );
  };
  const delays = (kit: TestKit) => ofType(kit, 'restarted').map((e) => e.delayMs);

  it('waits for the minimum when it is larger than the backoff, and not a ms less', async () => {
    const kit = createTestKit({ seed: 5 });
    const log: string[] = [];
    const strategy = supervise.restartWithBackoff({ ...opts, minDelayFor: retryAfter });
    const ref = kit.system.spawn(worker({ log }), 'w', { supervision: strategy });
    await kit.settle();
    const [delay = NaN] = expected(5, [[0, 5000]]);
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThanOrEqual(6000);
    const probe = kit.probe<number>();
    ref.tell(fail(rateLimited(5000)));
    ref.tell(add(2));
    ref.tell({ type: 'report', to: probe.ref });
    await kit.settle();
    // Well past the 1 s backoff, and 1 ms short of the delay: still restarting.
    await advance(kit, delay - 1);
    probe.expectNoMessage();
    expect(log).toEqual(['initial', 'preRestart 0 Error: model call failed']);
    await advance(kit, 1);
    expect(probe.expectMessage()).toBe(2);
    expect(log.at(-1)).toBe('initial');
    expect(delays(kit)).toEqual([delay]);
    const failed = ofType(kit, 'failed');
    const restarted = ofType(kit, 'restarted');
    expect((restarted[0]?.at ?? NaN) - (failed[0]?.at ?? NaN)).toBe(delay);
  });

  it('waits for the backoff when it is larger than the minimum', async () => {
    const kit = createTestKit({ seed: 5 });
    const strategy = supervise.restartWithBackoff({ ...opts, minDelayFor: retryAfter });
    const ref = kit.system.spawn(worker(), 'w', { supervision: strategy });
    const steps = [
      [0, 500],
      [1, 1999],
      [2, 0],
    ] as const;
    const want = expected(5, steps);
    for (const [, minimum] of steps) {
      ref.tell(fail(rateLimited(minimum)));
      await kit.settle();
      await advance(kit, want[delays(kit).length] ?? NaN);
    }
    expect(delays(kit)).toEqual(want);
    // The same as plain backoff from the same seed.
    expect(want).toEqual(
      expected(5, [
        [0, 0],
        [1, 0],
        [2, 0],
      ]),
    );
  });

  it('is not capped by maxMs, and does not count as extra backoff steps', async () => {
    const kit = createTestKit({ seed: 9 });
    const strategy = supervise.restartWithBackoff({ ...opts, minDelayFor: retryAfter });
    const ref = kit.system.spawn(worker(), 'w', { supervision: strategy });
    // Ten minutes, ten times maxMs. Then a failure with no retry-after: step 1, as if the first
    // restart had been an ordinary one.
    const want = expected(9, [
      [0, 600_000],
      [1, 0],
    ]);
    expect(want[0]).toBeGreaterThanOrEqual(600_000);
    ref.tell(fail(rateLimited(600_000)));
    await kit.settle();
    await advance(kit, (want[0] ?? NaN) - 1);
    expect(delays(kit)).toEqual([]);
    await advance(kit, 1);
    ref.tell(fail(rateLimited()));
    await kit.settle();
    await advance(kit, want[1] ?? NaN);
    expect(delays(kit)).toEqual(want);
    expect(ofType(kit, 'restarted').map((e) => e.attempt)).toEqual([1, 2]);
  });

  it('waits exactly the larger of the two with no jitter', async () => {
    const kit = createTestKit();
    const minDelayFor = (failure: unknown) => (typeof failure === 'number' ? failure : undefined);
    const strategy = supervise.restartWithBackoff({
      minMs: 100,
      maxMs: 1000,
      randomFactor: 0,
      resetAfterMs: 60_000,
      minDelayFor,
    });
    const ref = kit.system.spawn(worker(), 'w', { supervision: strategy });
    for (const minimum of [250, 0, 150, 5000]) {
      ref.tell(fail(minimum));
      await kit.settle();
      await advance(kit, 5000);
    }
    // Steps 100, 200, 400 and 800 against minimums of 250, 0, 150 and 5000.
    expect(delays(kit)).toEqual([250, 200, 400, 5000]);
  });

  it('leaves the ordinary backoff unchanged when no minimum applies', async () => {
    const run = async (minDelayFor?: (failure: unknown) => number | undefined) => {
      const kit = createTestKit({ seed: 7 });
      const backoff = { minMs: 100, maxMs: 1000, randomFactor: 0.5, resetAfterMs: 5000 };
      const strategy = supervise.restartWithBackoff(
        minDelayFor === undefined ? backoff : { ...backoff, minDelayFor },
      );
      const ref = kit.system.spawn(worker(), 'w', { supervision: strategy });
      for (let i = 0; i < 6; i++) {
        ref.tell(fail(i % 2 === 0 ? rateLimited() : 'boom'));
        await kit.settle();
        await advance(kit, 1500);
      }
      return ofType(kit, 'restarted').map((e) => [e.attempt, e.delayMs, e.at]);
    };
    const plain = await run();
    // The pinned delays of the plain backoff test, from the same seed.
    expect(plain.map(([, delayMs]) => delayMs)).toEqual([101, 206, 595, 1080, 1261, 1203]);
    expect(await run(retryAfter)).toEqual(plain);
    expect(await run(() => 0)).toEqual(plain);
  });

  it('passes the failure as it is, from receive, a rejection or initial', async () => {
    const kit = createTestKit();
    const seen: unknown[] = [];
    const strategy = supervise.restartWithBackoff({
      minMs: 10,
      maxMs: 10,
      randomFactor: 0,
      minDelayFor: (failure) => {
        seen.push(failure);
        return undefined;
      },
    });
    let failInitial = false;
    const ref = kit.system.spawn(worker({ initialFails: () => failInitial }), 'w', {
      supervision: strategy,
    });
    const error = rateLimited(1);
    ref.tell(fail(error));
    await kit.settle();
    await advance(kit, 10);
    ref.tell({ type: 'failAsync', error: undefined });
    await kit.settle();
    await advance(kit, 10);
    ref.tell(fail(42));
    await kit.settle();
    // The restart after 42 runs initial, which fails once.
    failInitial = true;
    await advance(kit, 10);
    failInitial = false;
    await advance(kit, 10);
    expect(seen[0]).toBe(error);
    expect(seen.slice(1, 3)).toEqual([undefined, 42]);
    expect(seen[3]).toMatchObject({ message: 'initial failed' });
  });

  const broken: [string, (failure: unknown) => number | undefined, RegExp][] = [
    [
      'throws',
      () => {
        throw new Error('bad reader');
      },
      /^minDelayFor threw/,
    ],
    ['returns a negative number', () => -1, /got -1;/],
    ['returns a fraction', () => 1.5, /got 1\.5;/],
    ['returns NaN', () => NaN, /got NaN;/],
    ['returns Infinity', () => Infinity, /got Infinity;/],
    ['returns a string', () => '5000' as never, /got "5000";/],
  ];
  for (const [what, minDelayFor, msg] of broken) {
    it(`logs a minDelayFor that ${what}, and uses the backoff alone`, async () => {
      const kit = createTestKit();
      const strategy = supervise.restartWithBackoff({
        minMs: 100,
        maxMs: 1000,
        randomFactor: 0,
        minDelayFor,
      });
      const ref = kit.system.spawn(worker(), 'w', { supervision: strategy });
      ref.tell(add(1));
      ref.tell(fail(rateLimited(5000)));
      await kit.settle();
      await advance(kit, 100);
      expect(delays(kit)).toEqual([100]);
      expect(await stateOf(kit, ref)).toBe(0);
      const problem = kit.logs.find((l) => msg.test(l.msg));
      expect(problem).toMatchObject({ level: 'error', fields: { path: '/user/w' } });
      expect(problem?.fields?.error).toBeInstanceOf(Error);
      if (what === 'throws') {
        expect(problem?.fields?.thrown).toMatchObject({ message: 'bad reader' });
      } else {
        expect(problem?.fields).not.toHaveProperty('thrown');
      }
    });
  }
});

describe('preRestart and postStop failures', () => {
  for (const how of ['throw', 'reject'] as const) {
    it(`logs a preRestart that ${how}s, and restarts anyway`, async () => {
      const kit = createTestKit();
      const log: string[] = [];
      const ref = kit.system.spawn(worker({ log, kids: ['a'], preRestart: how }), 'w', {
        supervision: supervise.restart(),
      });
      ref.tell(add(4));
      ref.tell(fail());
      ref.tell(add(1));
      expect(await stateOf(kit, ref)).toBe(1);
      expect(log).toEqual(['initial', 'preRestart 4 boom', 'a postStop', 'initial']);
      const verb = how === 'throw' ? 'threw' : 'rejected';
      expect(kit.logs).toContainEqual(
        expect.objectContaining({ level: 'error', msg: `preRestart ${verb}; restarting anyway` }),
      );
    });
  }

  it('logs a postStop that throws after a failure, and stops anyway', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: () => {
          throw new Error('boom');
        },
        onSignal: () => {
          throw new Error('postStop broke');
        },
      }),
      'w',
    );
    ref.tell('go');
    await kit.settle();
    expect(ofType(kit, 'stopped')).toMatchObject([{ path: '/user/w' }]);
    expect(kit.logs.map((l) => l.msg)).toEqual(['actor failed', 'postStop threw; stopping anyway']);
  });
});
