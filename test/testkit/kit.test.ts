import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { ActorNameError, ActorSystemTerminatedError } from '../../src/errors.js';
import { supervise } from '../../src/supervision.js';
import { createTestKit, SettleTimeoutError } from '../../src/testkit/kit.js';
import { deepEqual } from '../../src/testkit/probe.js';
import type { ActorRef, Result } from '../../src/types.js';
import { idle } from '../helpers/actors.js';

describe('createTestKit', () => {
  it('runs nothing until settle', async () => {
    const kit = createTestKit();
    const probe = kit.probe<string>();
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (s, msg) => {
          probe.ref.tell(msg);
          return s;
        },
      }),
    );
    ref.tell('hi');
    probe.expectNoMessage();
    await kit.settle();
    probe.expectMessage('hi');
  });

  it('rejects a seed that is not a safe integer', () => {
    expect(() => createTestKit({ seed: 1.5 })).toThrow(TypeError);
  });

  it('passes system options through', () => {
    const kit = createTestKit({ system: { name: 'kit-test' } });
    expect(kit.system.name).toBe('kit-test');
  });

  it('settles a chain of async receives across actors', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    const last = kit.system.spawn(
      actor<number, null>({
        initial: null,
        receive: async (s, n) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          probe.ref.tell(n);
          return s;
        },
      }),
    );
    const first = kit.system.spawn(
      actor<number, null>({
        initial: null,
        receive: async (s, n) => {
          await Promise.resolve();
          last.tell(n * 10);
          return s;
        },
      }),
    );
    first.tell(1);
    first.tell(2);
    await kit.settle();
    expect(probe.messages()).toEqual([10, 20]);
  });

  it('settles a chain of pipeToSelf results', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    type Msg = { type: 'start' } | { type: 'piped'; result: Result<number> };
    const ref = kit.system.spawn(
      actor<Msg, null>({
        initial: null,
        receive: (s, msg, ctx) => {
          const n = msg.type === 'start' ? 0 : msg.result.ok ? msg.result.value : -1;
          if (n < 3) {
            // Each step waits a few microtasks more, so the chain can't finish in one tick.
            const next = (async () => {
              for (let i = 0; i <= n; i++) await Promise.resolve();
              return n + 1;
            })();
            ctx.pipeToSelf(next, (result) => ({ type: 'piped', result }));
          } else {
            probe.ref.tell(n);
          }
          return s;
        },
      }),
    );
    ref.tell({ type: 'start' });
    await kit.settle();
    probe.expectMessage(3);
  });

  it('throws SettleTimeoutError when an actor awaits a promise that never settles', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(
      actor<'hang', null>({ initial: null, receive: () => new Promise<null>(() => {}) }),
    );
    ref.tell('hang');
    await expect(kit.settle()).rejects.toThrow(SettleTimeoutError);
  });

  it('suggests pipeToSelf when a busy actor may be awaiting an ask', async () => {
    const kit = createTestKit();
    const silent = kit.probe<{ replyTo: ActorRef<number> }>();
    const ref = kit.system.spawn(
      actor<'ask', null>({
        initial: null,
        receive: async (s) => {
          await silent.ref.ask<number>((replyTo) => ({ replyTo }));
          return s;
        },
      }),
    );
    ref.tell('ask');
    await expect(kit.settle()).rejects.toThrow(/only times out as time passes\? Pipe it/);
  });
});

describe('advance', () => {
  type Tick = { type: 'arm'; key: string; delayMs: number } | { type: 'fired'; key: string };

  /** Arms single timers on request, and reports each firing with the time it fired at. */
  function timed(out: (line: string) => void, rearm?: { key: string; delayMs: number }) {
    return actor<Tick, null>({
      initial: null,
      receive: (s, msg, ctx) => {
        if (msg.type === 'arm') {
          ctx.timers.startSingle(msg.key, { type: 'fired', key: msg.key }, msg.delayMs);
        } else {
          out(`${msg.key} at ${String(ctx.now())}`);
          if (rearm !== undefined && msg.key !== rearm.key) {
            ctx.timers.startSingle(rearm.key, { type: 'fired', key: rearm.key }, rearm.delayMs);
          }
        }
        return s;
      },
    });
  }

  it('fires timers in due order, then creation order, with the clock at each due time', async () => {
    const kit = createTestKit({ startTime: 100 });
    const lines: string[] = [];
    const ref = kit.system.spawn(timed((line) => lines.push(line)));
    ref.tell({ type: 'arm', key: 'c', delayMs: 30 });
    ref.tell({ type: 'arm', key: 'a', delayMs: 10 });
    ref.tell({ type: 'arm', key: 'b1', delayMs: 20 });
    ref.tell({ type: 'arm', key: 'b2', delayMs: 20 });
    ref.tell({ type: 'arm', key: 'late', delayMs: 31 });
    await kit.advance(30);
    expect(lines).toEqual(['a at 110', 'b1 at 120', 'b2 at 120', 'c at 130']);
    expect(kit.scheduler.now()).toBe(130);
    await kit.advance(1);
    expect(lines.at(-1)).toBe('late at 131');
  });

  it('settles after each due time, before the clock moves on', async () => {
    const kit = createTestKit();
    const probe = kit.probe<string>();
    // Slow finishes its async receive a few microtasks after the timer that started it fires.
    kit.system.spawn(
      actor<'go', null>({
        initial: (ctx) => {
          ctx.timers.startSingle('go', 'go', 10);
          return null;
        },
        receive: async (s, _msg, ctx) => {
          await Promise.resolve();
          await Promise.resolve();
          probe.ref.tell(`slow done at ${String(ctx.now())}`);
          return s;
        },
      }),
    );
    const fast = kit.system.spawn(
      timed((line) => {
        probe.ref.tell(line);
      }),
    );
    fast.tell({ type: 'arm', key: 'fast', delayMs: 20 });
    await kit.advance(50);
    expect(probe.messages()).toEqual(['slow done at 10', 'fast at 20']);
  });

  it('fires timers that are set during the advance and fall due within it', async () => {
    const kit = createTestKit();
    const lines: string[] = [];
    const ref = kit.system.spawn(timed((line) => lines.push(line), { key: 'second', delayMs: 15 }));
    ref.tell({ type: 'arm', key: 'first', delayMs: 10 });
    await kit.advance(30);
    expect(lines).toEqual(['first at 10', 'second at 25']);
    expect(kit.scheduler.now()).toBe(30);
  });

  it('runs messages queued before it, with no timers at all', async () => {
    const kit = createTestKit();
    const probe = kit.probe<string>();
    probe.ref.tell('queued');
    await kit.advance(0);
    probe.expectMessage('queued');
    expect(kit.scheduler.now()).toBe(0);
  });

  it('rejects a negative or fractional ms', async () => {
    const kit = createTestKit();
    await expect(kit.advance(-1)).rejects.toThrow(TypeError);
    await expect(kit.advance(1.5)).rejects.toThrow(TypeError);
    expect(kit.scheduler.now()).toBe(0);
  });
});

describe('shutdown', () => {
  it('stops every actor and resolves once they have stopped', async () => {
    const kit = createTestKit();
    const parent = kit.system.spawn(
      actor<never, null>({
        initial: (ctx) => {
          ctx.spawn(idle, 'child');
          return null;
        },
        receive: (s) => s,
      }),
      'parent',
    );
    await kit.settle();
    await kit.shutdown();
    expect(kit.events.filter((e) => e.type === 'stopped').map((e) => e.path)).toEqual([
      '/user/parent/child',
      '/user/parent',
    ]);
    expect(() => kit.system.spawn(idle)).toThrow(ActorSystemTerminatedError);
    expect(parent.path).toBe('/user/parent');
  });
});

describe('TestProbe', () => {
  it('lives under /temp, with generated or chosen names', () => {
    const kit = createTestKit();
    expect(kit.probe().ref.path).toBe('/temp/probe-1');
    expect(kit.probe('replies').ref.path).toBe('/temp/probe-replies');
    expect(kit.probe().ref.path).toBe('/temp/probe-2');
    expect(() => kit.probe('replies')).toThrow(ActorNameError);
    expect(() => kit.probe('bad name')).toThrow(ActorNameError);
  });

  it('matches by deep equality, by predicate, or takes any message', () => {
    const kit = createTestKit();
    const probe = kit.probe<{ type: string; n: number }>('p');
    probe.ref.tell({ type: 'a', n: 1 });
    probe.ref.tell({ type: 'b', n: 2 });
    probe.ref.tell({ type: 'c', n: 3 });
    expect(probe.expectMessage({ type: 'a', n: 1 })).toEqual({ type: 'a', n: 1 });
    expect(probe.expectMessage((m) => m.n === 2).type).toBe('b');
    expect(probe.expectMessage().type).toBe('c');
    probe.expectNoMessage();
  });

  it('names the probe and what it got when an expectation fails', () => {
    const kit = createTestKit();
    const probe = kit.probe<{ n: number }>('replies');
    expect(() => probe.expectMessage()).toThrow(
      'probe-replies: expected a message, but none arrived',
    );
    probe.ref.tell({ n: 1 });
    expect(() => probe.expectMessage({ n: 2 })).toThrow(
      'probe-replies: expected {"n":2}, got {"n":1}',
    );
    probe.ref.tell({ n: 3 });
    expect(() => probe.expectMessage((m) => m.n > 5)).toThrow(
      `probe-replies: got {"n":3}, which doesn't match the predicate`,
    );
    probe.ref.tell({ n: 4 });
    probe.ref.tell({ n: 5 });
    expect(() => {
      probe.expectNoMessage();
    }).toThrow('probe-replies: expected no message, got {"n":4} and 1 more');
  });

  it('takes all queued messages with messages()', () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    probe.ref.tell(1);
    probe.ref.tell(2);
    expect(probe.messages()).toEqual([1, 2]);
    expect(probe.messages()).toEqual([]);
  });
});

describe('TestProbe watch', () => {
  it('sees a watched actor terminate', async () => {
    const kit = createTestKit();
    const probe = kit.probe('w');
    const ref = kit.system.spawn(idle, 'a');
    probe.watch(ref);
    probe.watch(ref);
    expect(() => {
      probe.expectTerminated(ref);
    }).toThrow("probe-w: expected /user/a to terminate, but it hasn't");
    kit.system.stop(ref);
    await kit.settle();
    probe.expectTerminated(ref);
    // The notice is taken, and watching twice didn't record two.
    expect(() => {
      probe.expectTerminated(ref);
    }).toThrow("probe-w: expected /user/a to terminate, but the probe isn't watching it");
  });

  it('sees an actor that failed and was stopped by supervision', async () => {
    const kit = createTestKit();
    const probe = kit.probe();
    const ref = kit.system.spawn(
      actor<'boom', null>({
        initial: null,
        receive: () => {
          throw new Error('boom');
        },
      }),
      'crasher',
      { supervision: supervise.stop() },
    );
    probe.watch(ref);
    ref.tell('boom');
    await kit.settle();
    probe.expectTerminated(ref);
  });

  it('records an actor that has already terminated at once', async () => {
    const kit = createTestKit();
    const probe = kit.probe();
    const ref = kit.system.spawn(idle, 'gone');
    kit.system.stop(ref);
    await kit.settle();
    probe.watch(ref);
    probe.expectTerminated(ref);
  });

  it('fails when the probe never watched the actor', async () => {
    const kit = createTestKit();
    const probe = kit.probe('w');
    const ref = kit.system.spawn(idle, 'a');
    kit.system.stop(ref);
    await kit.settle();
    expect(() => {
      probe.expectTerminated(ref);
    }).toThrow("probe-w: expected /user/a to terminate, but the probe isn't watching it");
  });

  it('rejects a ref that is not an actor of this system, and can watch it no later', async () => {
    const kit = createTestKit();
    const other = createTestKit();
    const probe = kit.probe();
    const foreign = other.system.spawn(idle);
    expect(() => {
      probe.watch(kit.probe().ref);
    }).toThrow(TypeError);
    expect(() => {
      probe.watch(foreign);
    }).toThrow(TypeError);
    expect(() => {
      probe.expectTerminated(foreign);
    }).toThrow("isn't watching it");
    await other.shutdown();
  });
});

describe('deepEqual', () => {
  it('compares plain data by content', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: 1, c: 2 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEqual(new Date(0), {})).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('compares functions, and so refs, by identity', () => {
    const f = () => {};
    expect(deepEqual({ f }, { f })).toBe(true);
    expect(deepEqual({ f }, { f: () => {} })).toBe(false);
  });
});
