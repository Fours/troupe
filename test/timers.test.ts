import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { supervise } from '../src/supervision.js';
import { createTestKit, type TestKit } from '../src/testkit/kit.js';
import type { ActorContext, ActorRef, SpawnOptions } from '../src/types.js';
import { deferred } from './helpers/deferred.js';

type Cmd =
  | { type: 'tick'; id: string }
  | { type: 'do'; run: (ctx: ActorContext<Cmd>) => void }
  /** Holds the mailbox until `gate` settles, then runs `after` inside the receive. */
  | { type: 'hold'; gate: Promise<void>; after?: (ctx: ActorContext<Cmd>) => void }
  | { type: 'fail' };

const tick = (id: string): Cmd => ({ type: 'tick', id });

interface ClockOpts {
  /** Runs in every incarnation's initial, with the incarnation's number from 1. */
  readonly init?: (ctx: ActorContext<Cmd>, incarnation: number) => void;
  /** Collects every incarnation's ctx. */
  readonly ctxs?: ActorContext<Cmd>[];
}

/** Sends `<id>@<time>` to `out` for every tick it receives, and runs commands. */
function clock(out: ActorRef<string>, o: ClockOpts = {}) {
  let incarnations = 0;
  return actor<Cmd, null>({
    initial: (ctx) => {
      o.ctxs?.push(ctx);
      o.init?.(ctx, ++incarnations);
      return null;
    },
    receive: (s, msg, ctx) => {
      switch (msg.type) {
        case 'tick':
          out.tell(`${msg.id}@${String(ctx.now())}`);
          return s;
        case 'do':
          msg.run(ctx);
          return s;
        case 'hold':
          return msg.gate.then(() => {
            msg.after?.(ctx);
            return s;
          });
        case 'fail':
          throw new Error('boom');
      }
    },
  });
}

function setup(o: ClockOpts = {}, spawn?: SpawnOptions) {
  const kit = createTestKit();
  const probe = kit.probe<string>('ticks');
  const ctxs: ActorContext<Cmd>[] = [];
  const ref = kit.system.spawn(clock(probe.ref, { ...o, ctxs }), 'clock', spawn);
  return { kit, probe, ref, ctxs };
}

async function advanceTo(kit: TestKit, time: number): Promise<void> {
  kit.scheduler.advanceTo(time);
  await kit.settle();
}

describe('timers', () => {
  it('fires a single timer once, at its delay', async () => {
    const { kit, probe, ctxs } = setup({
      init: (ctx) => {
        ctx.timers.startSingle('once', tick('once'), 100);
      },
    });
    await kit.settle();
    const timers = ctxs[0]?.timers;
    expect(timers?.isActive('once')).toBe(true);

    await advanceTo(kit, 99);
    probe.expectNoMessage();
    await advanceTo(kit, 100);
    expect(probe.messages()).toEqual(['once@100']);
    // No longer active once its message has been received.
    expect(timers?.isActive('once')).toBe(false);

    await advanceTo(kit, 10_000);
    probe.expectNoMessage();
    expect(kit.scheduler.pendingTimers()).toBe(0);
  });

  it('fires a single timer with a delay of 0 without time passing', async () => {
    const { kit, probe } = setup({
      init: (ctx) => {
        ctx.timers.startSingle('now', tick('now'), 0);
      },
    });
    await kit.settle();
    expect(probe.messages()).toEqual(['now@0']);
  });

  it('fires a periodic timer every interval until it is cancelled', async () => {
    const { kit, probe, ref } = setup({
      init: (ctx) => {
        ctx.timers.startPeriodic('beat', tick('beat'), 50);
      },
    });
    await advanceTo(kit, 175);
    expect(probe.messages()).toEqual(['beat@50', 'beat@100', 'beat@150']);

    ref.tell({
      type: 'do',
      run: (ctx) => {
        ctx.timers.cancel('beat');
      },
    });
    await advanceTo(kit, 1000);
    probe.expectNoMessage();
    expect(kit.scheduler.pendingTimers()).toBe(0);
  });

  it('measures a periodic interval from each firing, not from when it is received', async () => {
    const gate = deferred();
    const { kit, probe, ref } = setup({
      init: (ctx) => {
        ctx.timers.startPeriodic('beat', tick('beat'), 50);
      },
    });
    // The mailbox is held from 0 to 120, so the firings at 50 and 100 queue up.
    ref.tell({ type: 'hold', gate: gate.promise });
    kit.scheduler.advanceTo(120);
    gate.resolve();
    await kit.settle();
    await advanceTo(kit, 150);
    expect(probe.messages()).toEqual(['beat@120', 'beat@120', 'beat@150']);
  });

  it('replaces a timer that is started again with the same key', async () => {
    const { kit, probe, ref } = setup({
      init: (ctx) => {
        ctx.timers.startSingle('t', tick('first'), 100);
      },
    });
    await advanceTo(kit, 50);
    ref.tell({
      type: 'do',
      run: (ctx) => {
        ctx.timers.startSingle('t', tick('second'), 100);
      },
    });
    await advanceTo(kit, 1000);
    expect(probe.messages()).toEqual(['second@150']);
  });

  it("drops a replaced timer's message that was already in the mailbox", async () => {
    const gate = deferred();
    const { kit, probe, ref, ctxs } = setup({
      init: (ctx) => {
        ctx.timers.startSingle('t', tick('old'), 10);
      },
    });
    // Hold the mailbox so the timer fires and its message waits in the queue.
    ref.tell({
      type: 'hold',
      gate: gate.promise,
      after: (ctx) => {
        ctx.timers.startSingle('t', tick('new'), 10);
      },
    });
    kit.scheduler.advanceTo(10);
    // Fired, but not received yet: still active.
    expect(ctxs[0]?.timers.isActive('t')).toBe(true);
    gate.resolve();
    await kit.settle();
    probe.expectNoMessage();

    await advanceTo(kit, 20);
    expect(probe.messages()).toEqual(['new@20']);
  });

  it("drops a cancelled timer's message that was already in the mailbox", async () => {
    const gate = deferred();
    const { kit, probe, ref, ctxs } = setup({
      init: (ctx) => {
        ctx.timers.startSingle('t', tick('t'), 10);
        ctx.timers.startPeriodic('p', tick('p'), 10);
      },
    });
    ref.tell({
      type: 'hold',
      gate: gate.promise,
      after: (ctx) => {
        ctx.timers.cancelAll();
      },
    });
    kit.scheduler.advanceTo(10);
    gate.resolve();
    await kit.settle();
    await advanceTo(kit, 1000);
    probe.expectNoMessage();
    expect(ctxs[0]?.timers.isActive('t')).toBe(false);
    expect(ctxs[0]?.timers.isActive('p')).toBe(false);
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([]);
  });

  it('cancels every timer when the actor stops, including a message already queued', async () => {
    const gate = deferred();
    const { kit, probe, ref } = setup({
      init: (ctx) => {
        ctx.timers.startSingle('t', tick('t'), 10);
        ctx.timers.startPeriodic('p', tick('p'), 30);
      },
    });
    ref.tell({
      type: 'hold',
      gate: gate.promise,
      after: (ctx) => {
        ctx.stop();
      },
    });
    kit.scheduler.advanceTo(10);
    gate.resolve();
    await kit.settle();
    await advanceTo(kit, 1000);

    probe.expectNoMessage();
    expect(kit.scheduler.pendingTimers()).toBe(0);
    // A cancelled timer's message is never received, not even as a dead letter.
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([]);
    expect(kit.events.at(-1)).toMatchObject({ type: 'stopped', path: '/user/clock' });
  });

  it('cancels every timer on restart, so the new incarnation never sees them', async () => {
    const gate = deferred();
    const { kit, probe, ref } = setup(
      {
        init: (ctx, n) => {
          // Every incarnation starts the same key. The generation keeps counting across them, so
          // the old incarnation's queued message can't pass for the new one's.
          ctx.timers.startSingle('t', tick(`incarnation ${String(n)}`), 100);
          if (n === 1) ctx.timers.startPeriodic('only-first', tick('only-first'), 150);
        },
      },
      { supervision: supervise.restart() },
    );
    ref.tell({
      type: 'hold',
      gate: gate.promise,
      after: () => {
        throw new Error('boom');
      },
    });
    // The first incarnation's timer fires at 100 while the mailbox is held, then it fails.
    kit.scheduler.advanceTo(100);
    gate.resolve();
    await kit.settle();
    await advanceTo(kit, 1000);

    expect(probe.messages()).toEqual(['incarnation 2@200']);
    expect(kit.events.filter((e) => e.type === 'restarted')).toHaveLength(1);
  });

  it("makes a stale ctx's timer methods do nothing, but still checks their arguments", async () => {
    const { kit, probe, ref, ctxs } = setup({}, { supervision: supervise.restart() });
    ref.tell({ type: 'fail' });
    await kit.settle();
    const stale = ctxs[0]?.timers;
    expect(ctxs).toHaveLength(2);

    stale?.startSingle('s', tick('s'), 10);
    stale?.startPeriodic('p', tick('p'), 10);
    expect(stale?.isActive('s')).toBe(false);
    stale?.cancel('s');
    stale?.cancelAll();
    await advanceTo(kit, 100);
    probe.expectNoMessage();
    expect(kit.scheduler.pendingTimers()).toBe(0);
    expect(() => stale?.startSingle('s', tick('s'), -1)).toThrow(TypeError);

    // The current ctx shares nothing with it.
    ctxs[1]?.timers.startSingle('s', tick('fresh'), 10);
    expect(stale?.isActive('s')).toBe(false);
    await advanceTo(kit, 110);
    expect(probe.messages()).toEqual(['fresh@110']);
  });

  it('does nothing once the actor is stopping', async () => {
    let timers: ActorContext<Cmd>['timers'] | undefined;
    const kit = createTestKit();
    const probe = kit.probe<string>('ticks');
    const ref = kit.system.spawn(
      actor<Cmd, null>({
        initial: null,
        receive: (s) => s,
        onSignal: (s, signal, ctx) => {
          if (signal.type === 'postStop') {
            ctx.timers.startSingle('late', tick('late'), 0);
            timers = ctx.timers;
          }
          return s;
        },
      }),
      'stopping',
    );
    kit.system.stop(ref);
    await advanceTo(kit, 100);
    expect(timers?.isActive('late')).toBe(false);
    expect(kit.scheduler.pendingTimers()).toBe(0);
    probe.expectNoMessage();
  });

  it('checks its arguments and throws TypeError', async () => {
    const { kit, ctxs } = setup();
    await kit.settle();
    const timers = ctxs[0]?.timers;
    const anyKey = 1 as unknown as string;
    expect(() => timers?.startSingle(anyKey, tick('x'), 1)).toThrow(
      'timers.startSingle: key must be a string, got 1',
    );
    for (const delay of [-1, 1.5, NaN, Infinity]) {
      expect(() => timers?.startSingle('k', tick('x'), delay)).toThrow(TypeError);
    }
    for (const interval of [0, -1, 2.5]) {
      expect(() => timers?.startPeriodic('k', tick('x'), interval)).toThrow(
        'timers.startPeriodic: intervalMs must be a positive integer',
      );
    }
    expect(() => timers?.cancel(anyKey)).toThrow(TypeError);
    expect(() => timers?.isActive(anyKey)).toThrow(TypeError);
    expect(kit.scheduler.pendingTimers()).toBe(0);
  });

  it("dead-letters a timer's message when the mailbox is full, and the timer is done", async () => {
    const gate = deferred();
    const { kit, probe, ref, ctxs } = setup(
      {
        init: (ctx) => {
          ctx.timers.startSingle('t', tick('t'), 10);
        },
      },
      { mailbox: { capacity: 1 } },
    );
    ref.tell({ type: 'hold', gate: gate.promise });
    kit.scheduler.runReady();
    // The hold is running, so this fills the one slot.
    ref.tell(tick('filler'));
    kit.scheduler.advanceTo(10);
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { recipient: '/user/clock', message: { type: 'tick', id: 't' }, reason: 'mailboxFull' },
    ]);
    expect(ctxs[0]?.timers.isActive('t')).toBe(false);
    gate.resolve();
    await kit.settle();
    expect(probe.messages()).toEqual(['filler@10']);
  });
});
