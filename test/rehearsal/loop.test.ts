import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { silentLogger } from '../../src/logger.js';
import { NodeClock } from '../../src/rehearsal/clock.js';
import { RunLoop, StallError } from '../../src/rehearsal/loop.js';
import { openYielder } from '../../src/rehearsal/yield.js';
import type { Scheduler } from '../../src/scheduler.js';
import { createSystem } from '../../src/system.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../src/testkit/random.js';

// Milestone 5, T1 (decision 0033): the run loop that closes virtual time, and stall detection.

/** A call that answers after `ms` of the caller's clock, as every simulated call will. */
const call = <T>(clock: Scheduler, ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    clock.setTimer(() => {
      resolve(value);
    }, ms);
  });

/** A node: an actor system on its own clock, watched by the loop. */
function node(loop: RunLoop, sim: ManualScheduler, name: string, driftPpm = 0) {
  const clock = new NodeClock(sim, { driftPpm });
  const handle = createSystem({ scheduler: clock, random: seededRandom(1), logger: silentLogger });
  loop.watch(handle, clock, name);
  return { clock, system: handle.system };
}

describe('the run loop', () => {
  it('lets time move on while an actor awaits a call that answers on a timer, with no real waiting', async () => {
    const sim = new ManualScheduler();
    // One message 100 s long, past the default stall limit.
    const loop = new RunLoop(sim, { stallAfterMs: 120_000 });
    const { clock, system } = node(loop, sim, 'node-1');
    const done: number[] = [];
    const ref = system.spawn(
      actor<'go', number>({
        initial: 0,
        receive: async (n) => {
          // A chain of calls, each a few awaits deep, as a journal append is.
          for (let i = 0; i < 100; i++) {
            const answer = await call(clock, 1_000, i);
            await Promise.resolve();
            n += answer;
          }
          done.push(sim.now());
          return n;
        },
      }),
      'busy',
    );
    ref.tell('go');
    const started = performance.now();
    await loop.advance(200_000);
    expect(done).toEqual([100_000]);
    expect(loop.now()).toBe(200_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('runs every node, in order of simulation time, each on its own clock', async () => {
    const sim = new ManualScheduler();
    const loop = new RunLoop(sim);
    const log: string[] = [];
    for (const [name, drift] of [
      ['fast', 50_000],
      ['slow', -50_000],
    ] as const) {
      const { clock, system } = node(loop, sim, name, drift);
      system
        .spawn(
          actor<'go', null>({
            initial: null,
            receive: async (s) => {
              await call(clock, 1_000, null);
              log.push(`${name} ${String(sim.now())} ${String(clock.now())}`);
              return s;
            },
          }),
        )
        .tell('go');
    }
    await loop.runUntil(5_000);
    expect(log).toEqual(['fast 953 1000', 'slow 1053 1000']);
  });

  it('settles what needs no time, and ends exactly where it was asked to', async () => {
    const sim = new ManualScheduler({ startTime: 100 });
    const loop = new RunLoop(sim);
    const { system } = node(loop, sim, 'node-1');
    const seen: string[] = [];
    const ref = system.spawn(
      actor<string, null>({
        initial: null,
        receive: async (s, msg) => {
          await Promise.resolve();
          seen.push(msg);
          return s;
        },
      }),
    );
    ref.tell('a');
    ref.tell('b');
    await loop.settle();
    expect(seen).toEqual(['a', 'b']);
    expect(loop.now()).toBe(100);
    await loop.advance(0);
    await loop.runUntil(250);
    expect(loop.now()).toBe(250);
  });

  it('stalls with the path of an actor awaiting a promise outside the simulation, once nothing else can happen', async () => {
    const sim = new ManualScheduler();
    const loop = new RunLoop(sim);
    const { system } = node(loop, sim, 'node-1');
    system
      .spawn(
        actor<'go', null>({
          initial: null,
          receive: async (s) => {
            await new Promise(() => {});
            return s;
          },
        }),
        'stuck',
      )
      .tell('go');
    const error = await loop.settle().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StallError);
    expect((error as StallError).name).toBe('StallError');
    expect((error as StallError).actors).toEqual(['node-1 /user/stuck']);
    expect((error as StallError).message).toMatch(
      /stalled at 0 ms.*no timer is set.*node-1 \/user\/stuck.*outside the simulation/,
    );
  });

  it('stalls when an actor stays busy on one message past stallAfterMs, though timers keep firing', async () => {
    const sim = new ManualScheduler();
    const loop = new RunLoop(sim, { stallAfterMs: 10_000 });
    const { clock, system } = node(loop, sim, 'node-2');
    // A heartbeat, as every cluster node has, so a timer is always set.
    const beat = (): void => {
      clock.setTimer(beat, 500);
    };
    beat();
    const ref = system.spawn(
      actor<number, null>({
        initial: null,
        receive: async (s, ms) => {
          await (ms === Infinity ? new Promise(() => {}) : call(clock, ms, null));
          return s;
        },
      }),
      'slow',
    );
    // Busy for 9 s, then again for 9 s: two messages, neither one too long.
    ref.tell(9_000);
    ref.tell(9_000);
    await loop.advance(20_000);
    ref.tell(Infinity);
    const error = await loop.advance(20_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StallError);
    expect((error as StallError).actors).toEqual(['node-2 /user/slow']);
    expect((error as StallError).message).toMatch(/at 30000 ms.*busy on one message for 10000/);
  });

  it('stops watching a system it is told to, such as a killed node’s', async () => {
    const sim = new ManualScheduler();
    const loop = new RunLoop(sim);
    const clock = new NodeClock(sim);
    const handle = createSystem({
      scheduler: clock,
      random: seededRandom(1),
      logger: silentLogger,
    });
    loop.watch(handle, clock, 'node-1');
    handle.system
      .spawn(
        actor<'go', null>({
          initial: null,
          receive: async (s) => {
            await new Promise(() => {});
            return s;
          },
        }),
        'stuck',
      )
      .tell('go');
    await expect(loop.settle()).rejects.toThrow(StallError);
    // Its process is gone, so what's left of it is never going to finish.
    loop.unwatch(handle);
    loop.unwatch(handle);
    await loop.settle();
  });

  it('closes its channel when it is done, so Node can exit, and opens one again for the next call', async () => {
    const sim = new ManualScheduler();
    const loop = new RunLoop(sim);
    await Promise.all([loop.settle(), loop.advance(10)]);
    await loop.settle();
    expect(loop.now()).toBe(10);
  });

  it('throws for arguments and options that cannot be used, where they are passed in', async () => {
    const sim = new ManualScheduler({ startTime: 50 });
    expect(() => new RunLoop(sim, { stallAfterMs: 0 })).toThrow(TypeError);
    expect(() => new RunLoop(sim, { stall: 1 } as never)).toThrow(/unknown option "stall"/);
    const loop = new RunLoop(sim);
    await expect(loop.advance(-1)).rejects.toThrow(TypeError);
    await expect(loop.advance(1.5)).rejects.toThrow(TypeError);
    await expect(loop.runUntil(49)).rejects.toThrow(RangeError);
    await expect(loop.runUntil(NaN)).rejects.toThrow(RangeError);
  });
});

describe('the yield', () => {
  // The probe's finding (scripts/probe-macrotask.ts), which the loop relies on: one macrotask lets
  // every microtask queued before it run, however deep the chain.
  it('resolves only after a deep chain of microtasks has finished', async () => {
    const yielder = openYielder();
    try {
      let done = false;
      void (async () => {
        for (let i = 0; i < 10_000; i++) await Promise.resolve();
        done = true;
      })();
      await yielder.next();
      expect(done).toBe(true);
    } finally {
      yielder.close();
    }
  });

  it('serves many yields waiting at once, in order', async () => {
    const yielder = openYielder();
    try {
      const order: number[] = [];
      await Promise.all([1, 2, 3].map((n) => yielder.next().then(() => order.push(n))));
      expect(order).toEqual([1, 2, 3]);
    } finally {
      yielder.close();
    }
  });
});
