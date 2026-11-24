import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { supervise } from '../src/supervision.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorContext, ActorRef, Result, SpawnOptions } from '../src/types.js';
import { deferred } from './helpers/deferred.js';

type Msg =
  | { type: 'pipe'; promise: Promise<number>; mapperThrows?: boolean }
  | { type: 'result'; result: Result<number> }
  | { type: 'add'; n: number }
  | { type: 'report' };

/**
 * Pipes whatever promise it's sent, and reports each result and its running total to `out`. Its
 * state is a sum, so a restart is visible as a reset.
 */
function piper(out: ActorRef<string>, ctxs: ActorContext<Msg>[] = []) {
  return actor<Msg, number>({
    initial: (ctx) => {
      ctxs.push(ctx);
      return 0;
    },
    receive: (sum, msg, ctx) => {
      switch (msg.type) {
        case 'pipe':
          ctx.pipeToSelf(msg.promise, (result) => {
            if (msg.mapperThrows) throw new Error('mapper broke');
            return { type: 'result', result };
          });
          return sum;
        case 'result':
          out.tell(
            msg.result.ok ? `ok ${String(msg.result.value)}` : `error ${String(msg.result.error)}`,
          );
          return sum;
        case 'add':
          return sum + msg.n;
        case 'report':
          out.tell(`sum ${String(sum)}`);
          return sum;
      }
    },
  });
}

function setup(spawn?: SpawnOptions) {
  const kit = createTestKit();
  const probe = kit.probe<string>('out');
  const ctxs: ActorContext<Msg>[] = [];
  const ref = kit.system.spawn(piper(probe.ref, ctxs), 'piper', spawn);
  return { kit, probe, ref, ctxs };
}

describe('pipeToSelf', () => {
  it("doesn't block the mailbox while the promise is pending", async () => {
    const { kit, probe, ref } = setup();
    const pending = deferred<number>();
    ref.tell({ type: 'pipe', promise: pending.promise });
    ref.tell({ type: 'add', n: 2 });
    ref.tell({ type: 'report' });
    // Drive the scheduler by hand: settle would wait for the pipe, which is the point here.
    kit.scheduler.runReady();
    expect(probe.messages()).toEqual(['sum 2']);

    pending.resolve(7);
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 7']);
  });

  it('delivers a resolved and a rejected promise as a Result', async () => {
    const { kit, probe, ref } = setup();
    ref.tell({ type: 'pipe', promise: Promise.resolve(1) });
    ref.tell({ type: 'pipe', promise: Promise.reject(new Error('nope')) });
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 1', 'error Error: nope']);
  });

  it('accepts any PromiseLike, and settle waits for it', async () => {
    const { kit, probe, ctxs } = setup();
    await kit.settle();
    const thenable: PromiseLike<number> = {
      then: (onFulfilled) => Promise.resolve(5).then(onFulfilled),
    };
    ctxs[0]?.pipeToSelf(thenable, (result) => ({ type: 'result', result }));
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 5']);
  });

  it('runs the mapper inside the actor, so a throw goes to supervision', async () => {
    const { kit, probe, ref } = setup({ supervision: supervise.restart() });
    ref.tell({ type: 'add', n: 3 });
    ref.tell({ type: 'pipe', promise: Promise.resolve(1), mapperThrows: true });
    await kit.settle();
    ref.tell({ type: 'report' });
    await kit.settle();

    expect(kit.events.filter((e) => e.type === 'failed')).toMatchObject([
      { path: '/user/piper', error: new Error('mapper broke'), directive: 'restart' },
    ]);
    const logged = kit.logs.find((entry) => entry.msg === 'actor failed');
    expect(logged?.fields).toMatchObject({ pipeToSelf: 'ok', directive: 'restart' });
    // The restart reset the sum.
    expect(probe.messages()).toEqual(['sum 0']);
  });

  it('drops only the failed result under resume', async () => {
    const { kit, probe, ref } = setup({ supervision: supervise.resume() });
    ref.tell({ type: 'add', n: 3 });
    ref.tell({ type: 'pipe', promise: Promise.reject(new Error('x')), mapperThrows: true });
    ref.tell({ type: 'pipe', promise: Promise.resolve(9) });
    await kit.settle();
    ref.tell({ type: 'report' });
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 9', 'sum 3']);
  });

  it('makes a result for a stopped actor a dead letter of the raw Result', async () => {
    const { kit, probe, ref } = setup();
    const later = deferred<number>();
    ref.tell({ type: 'pipe', promise: later.promise });
    kit.scheduler.runReady();
    kit.system.stop(ref);
    kit.scheduler.runReady();

    later.resolve(4);
    await kit.settle();
    probe.expectNoMessage();
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([
      expect.objectContaining({
        recipient: '/user/piper',
        message: { ok: true, value: 4 },
        reason: 'stopped',
      }),
    ]);
  });

  it('dead-letters a result still queued when the actor stops', async () => {
    const kit = createTestKit();
    const gate = deferred();
    const ref = kit.system.spawn(
      actor<{ type: 'hold' } | { type: 'got'; n: number }, null>({
        initial: (ctx) => {
          ctx.pipeToSelf(Promise.resolve(8), () => ({ type: 'got', n: 8 }));
          return null;
        },
        // The first message holds the mailbox while the result arrives behind it.
        receive: (s, msg, ctx) => {
          if (msg.type === 'got') return s;
          return gate.promise.then(() => {
            ctx.stop();
            return s;
          });
        },
      }),
      'held',
    );
    ref.tell({ type: 'hold' });
    kit.scheduler.runReady();
    // Lets the piped promise settle, so its result queues behind the hold.
    await Promise.resolve();
    gate.resolve();
    await kit.settle();
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { message: { ok: true, value: 8 }, reason: 'stopped' },
    ]);
  });

  it('still delivers a result after a restart, like a tell to self', async () => {
    const { kit, probe, ref } = setup({ supervision: supervise.restart() });
    const later = deferred<number>();
    ref.tell({ type: 'pipe', promise: later.promise });
    ref.tell({ type: 'pipe', promise: Promise.resolve(0), mapperThrows: true });
    // settle would wait for the pending pipe, so drive the restart by hand.
    kit.scheduler.runReady();
    await Promise.resolve();
    kit.scheduler.runReady();
    expect(kit.events.filter((e) => e.type === 'restarted')).toHaveLength(1);

    later.resolve(6);
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 6']);
  });

  it('checks that map is a function', async () => {
    const { kit, ctxs } = setup();
    await kit.settle();
    expect(() => ctxs[0]?.pipeToSelf(Promise.resolve(1), 'nope' as unknown as () => Msg)).toThrow(
      'pipeToSelf: map must be a function',
    );
  });
});

describe('pipeToSelf of an ask', () => {
  type Request = { replyTo: ActorRef<number> };

  function setupAsk() {
    const { kit, probe, ref } = setup();
    const target = kit.probe<Request>('target');
    const ask = (opts?: { timeoutMs: number }) =>
      target.ref.ask<number>((replyTo) => ({ replyTo }), opts);
    return { kit, probe, ref, target, ask };
  }

  it("runs on virtual time, so settle doesn't wait for it", async () => {
    const { kit, probe, ref, ask } = setupAsk();
    ref.tell({ type: 'pipe', promise: ask({ timeoutMs: 30 }) });
    await kit.settle();
    probe.expectNoMessage();
    await kit.advance(29);
    probe.expectNoMessage();
    await kit.advance(1);
    expect(probe.expectMessage()).toMatch(/^error AskTimeoutError/);
  });

  it("queues the reply the moment it's told, ahead of later messages", async () => {
    const { kit, probe, ref, target, ask } = setupAsk();
    ref.tell({ type: 'pipe', promise: ask() });
    await kit.settle();
    target.expectMessage().replyTo.tell(5);
    ref.tell({ type: 'report' });
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 5', 'sum 0']);
  });

  it('delivers an ask that settled before it was piped, and one whose build threw', async () => {
    const { kit, probe, ref, target, ask } = setupAsk();
    const answered = ask();
    await kit.settle();
    target.expectMessage().replyTo.tell(7);
    const broken = target.ref.ask<number>(() => {
      throw new Error('build broke');
    });
    ref.tell({ type: 'pipe', promise: answered });
    ref.tell({ type: 'pipe', promise: broken });
    await kit.settle();
    expect(probe.messages()).toEqual(['ok 7', 'error Error: build broke']);
  });

  it('gets the rejection when terminate fails the ask', async () => {
    const { kit, ref, ask } = setupAsk();
    ref.tell({ type: 'pipe', promise: ask() });
    await kit.settle();
    await kit.shutdown();
    // The actor is stopping by the time the rejection arrives, so it's a dead letter.
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { message: { ok: false, error: { name: 'ActorSystemTerminatedError' } } },
    ]);
  });
});

describe('pipeToSelf with a signal', () => {
  type Work = { type: 'result'; result: Result<string> } | { type: 'timeout' };

  /**
   * Steadfast's tool call: `initial` pipes `run(signal)` and starts a timeout that aborts the
   * signal. With `abortOnStop`, `postStop` aborts it too. Reports each result to `out`.
   */
  function worker(
    out: ActorRef<string>,
    run: (signal: AbortSignal) => PromiseLike<string>,
    opts: { timeoutMs?: number; abortOnStop?: boolean } = {},
  ) {
    const controller = new AbortController();
    return actor<Work, null>({
      initial: (ctx) => {
        ctx.pipeToSelf(run(controller.signal), (result) => ({ type: 'result', result }), {
          signal: controller.signal,
        });
        if (opts.timeoutMs !== undefined) {
          ctx.timers.startSingle('timeout', { type: 'timeout' }, opts.timeoutMs);
        }
        return null;
      },
      receive: (state, msg, ctx) => {
        if (msg.type === 'timeout') {
          controller.abort(new Error('timed out'));
          return state;
        }
        const { result } = msg;
        out.tell(result.ok ? `ok ${result.value}` : `error ${String(result.error)}`);
        ctx.stop();
        return state;
      },
      onSignal: (state, signal) => {
        if (signal.type === 'postStop' && opts.abortOnStop) controller.abort(new Error('stopped'));
        return state;
      },
    });
  }

  it("doesn't count as busy, so advance lets the actor's own timeout end it", async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    // A tool that finishes only when its signal aborts it.
    const run = (signal: AbortSignal) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted by the tool'));
        });
      });
    kit.system.spawn(worker(out.ref, run, { timeoutMs: 50 }), 'tool');
    await kit.settle();
    await kit.advance(49);
    out.expectNoMessage();
    await kit.advance(1);
    // The pipe's own delivery wins: the signal's reason, not the tool's rejection.
    expect(out.messages()).toEqual(['error Error: timed out']);
    expect(kit.scheduler.now()).toBe(50);
  });

  it('ends when its signal aborts, even if the promise ignores the signal and never settles', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    kit.system.spawn(
      worker(out.ref, () => new Promise<string>(() => {}), { timeoutMs: 20 }),
      'tool',
    );
    await kit.advance(20);
    expect(out.messages()).toEqual(['error Error: timed out']);
  });

  it('still delivers a promise that has already settled, or settles in microtasks, under settle', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    kit.system.spawn(
      worker(out.ref, () => Promise.resolve('now')),
      'now',
    );
    const chained = async () => {
      for (let i = 0; i < 1000; i++) await Promise.resolve();
      return 'chained';
    };
    kit.system.spawn(worker(out.ref, chained), 'chained');
    await kit.settle();
    expect(out.messages().sort()).toEqual(['ok chained', 'ok now']);
    expect(kit.scheduler.now()).toBe(0);
  });

  it('delivers the promise when it settles first, and ignores the abort after it', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    const tool = deferred<string>();
    const controller = new AbortController();
    const removed: string[] = [];
    const signal = controller.signal;
    const original = signal.removeEventListener.bind(signal);
    signal.removeEventListener = (type: string, listener: () => void) => {
      removed.push(type);
      original(type, listener);
    };
    const ref = kit.system.spawn(
      actor<Result<string>, null>({
        initial: (ctx) => {
          ctx.pipeToSelf(tool.promise, (result) => result, { signal });
          return null;
        },
        receive: (state, result) => {
          out.ref.tell(result.ok ? `ok ${result.value}` : `error ${String(result.error)}`);
          return state;
        },
      }),
      'first',
    );
    await kit.settle();
    tool.resolve('done');
    await kit.settle();
    controller.abort(new Error('too late'));
    await kit.settle();
    expect(out.messages()).toEqual(['ok done']);
    expect(removed).toEqual(['abort']);
    expect(ref.path).toBe('/user/first');
  });

  it('ignores the promise after the abort, and its later rejection is handled', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    const tool = deferred<string>();
    kit.system.spawn(
      worker(out.ref, () => tool.promise, { timeoutMs: 10 }),
      'tool',
    );
    await kit.advance(10);
    tool.reject(new Error('late failure'));
    await kit.settle();
    // An unhandled rejection would fail the run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(out.messages()).toEqual(['error Error: timed out']);
    // Nor is the late outcome delivered: it would be a dead letter, since the actor has stopped.
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([]);
  });

  it('delivers the reason at once when the signal has already aborted', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    const controller = new AbortController();
    controller.abort(new Error('already'));
    kit.system.spawn(
      actor<Result<string>, null>({
        initial: (ctx) => {
          ctx.pipeToSelf(new Promise<string>(() => {}), (result) => result, {
            signal: controller.signal,
          });
          return null;
        },
        receive: (state, result) => {
          out.ref.tell(result.ok ? 'ok' : `error ${String(result.error)}`);
          return state;
        },
      }),
      'aborted',
    );
    await kit.settle();
    expect(out.messages()).toEqual(['error Error: already']);
  });

  it('lets the system shut down with the pipe pending, and postStop can abort it', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    kit.system.spawn(
      worker(out.ref, () => new Promise<string>(() => {})),
      'held',
    );
    kit.system.spawn(
      worker(out.ref, () => new Promise<string>(() => {}), { abortOnStop: true }),
      'aborted',
    );
    await kit.settle();
    await kit.shutdown();
    out.expectNoMessage();
    // The abort in postStop comes after the actor has stopped, so its rejection is a dead letter.
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toMatchObject([
      { recipient: '/user/aborted', message: { ok: false, error: { message: 'stopped' } } },
    ]);
  });

  it('ends a piped ask at the abort, ahead of its timeout', async () => {
    const kit = createTestKit();
    const out = kit.probe<string>('out');
    const target = kit.probe<{ replyTo: ActorRef<string> }>('target');
    // An ask can't take a signal, so only the pipe's own abort ends it early.
    const ask = () => target.ref.ask<string>((replyTo) => ({ replyTo }), { timeoutMs: 1000 });
    kit.system.spawn(worker(out.ref, ask, { timeoutMs: 30 }), 'asker');
    await kit.advance(30);
    expect(out.messages()).toEqual(['error Error: timed out']);
    const answered = kit.probe<string>('answered');
    kit.system.spawn(worker(answered.ref, ask, { timeoutMs: 30 }), 'answered');
    await kit.settle();
    target.expectMessage();
    target.expectMessage().replyTo.tell('reply');
    await kit.settle();
    expect(answered.messages()).toEqual(['ok reply']);
  });

  it('checks its options where they are passed in', async () => {
    const { kit, ctxs } = setup();
    await kit.settle();
    const ctx = ctxs[0];
    const map = (): Msg => ({ type: 'report' });
    expect(() => ctx?.pipeToSelf(Promise.resolve(1), map, { nope: 1 } as never)).toThrow(
      'pipeToSelf: unknown option "nope"',
    );
    expect(() => ctx?.pipeToSelf(Promise.resolve(1), map, 'x' as never)).toThrow(
      'pipeToSelf: options must be an object',
    );
    for (const signal of [null, {}, { aborted: false, addEventListener: () => {} }]) {
      expect(() => ctx?.pipeToSelf(Promise.resolve(1), map, { signal } as never)).toThrow(
        'pipeToSelf: signal must be an AbortSignal',
      );
    }
    expect(() => ctx?.pipeToSelf(Promise.resolve(1), map, { signal: undefined })).not.toThrow();
    expect(() => ctx?.pipeToSelf(Promise.resolve(1), map, {})).not.toThrow();
  });
});
