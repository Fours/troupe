import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorRef } from '../src/types.js';
import { deferred, type Deferred } from './helpers/deferred.js';

const recorder = (log: string[], name: string) =>
  actor<string, null>({
    initial: null,
    receive: (s, msg) => {
      log.push(`${name}:${msg}`);
      return s;
    },
  });

describe('mailbox order', () => {
  it('processes 1,000 tells from outside exactly once each, in order', async () => {
    const kit = createTestKit();
    const seen: number[] = [];
    const ref = kit.system.spawn(
      actor<number, null>({
        initial: null,
        receive: (s, n) => {
          seen.push(n);
          return s;
        },
      }),
    );
    for (let i = 0; i < 1000; i++) ref.tell(i);
    await kit.settle();
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  it('keeps order for messages an actor sends itself while it runs', async () => {
    const kit = createTestKit();
    const seen: string[] = [];
    const ref = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: (s, msg, ctx) => {
          seen.push(msg);
          if (msg === 'a') {
            ctx.self.tell('c');
            ctx.self.tell('d');
          }
          return s;
        },
      }),
    );
    ref.tell('a');
    ref.tell('b');
    await kit.settle();
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('async receive', () => {
  it('holds the mailbox until the promise settles, while other actors run', async () => {
    const kit = createTestKit();
    const log: string[] = [];
    const gates = new Map<string, Deferred<void>>([
      ['slow-1', deferred()],
      ['slow-2', deferred()],
    ]);
    const slow = kit.system.spawn(
      actor<string, null>({
        initial: null,
        receive: async (s, msg) => {
          log.push(`slow:start ${msg}`);
          await gates.get(msg)?.promise;
          log.push(`slow:end ${msg}`);
          return s;
        },
      }),
    );
    const fast = kit.system.spawn(recorder(log, 'fast'));

    // settle() would wait for slow-1's promise, which the test holds open on purpose, so drive the
    // scheduler by hand, with a real tick between runs to let any promise callbacks through.
    const step = async () => {
      kit.scheduler.runReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
      kit.scheduler.runReady();
    };

    slow.tell('slow-1');
    slow.tell('slow-2');
    fast.tell('x');
    await step();
    // slow-1 is pending, so slow-2 waits, and fast runs meanwhile.
    expect(log).toEqual(['slow:start slow-1', 'fast:x']);

    fast.tell('y');
    await step();
    expect(log).toEqual(['slow:start slow-1', 'fast:x', 'fast:y']);

    gates.get('slow-1')?.resolve();
    gates.get('slow-2')?.resolve();
    await kit.settle();
    expect(log).toEqual([
      'slow:start slow-1',
      'fast:x',
      'fast:y',
      'slow:end slow-1',
      'slow:start slow-2',
      'slow:end slow-2',
    ]);
  });

  it('carries the state an async receive resolves with', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    const ref = kit.system.spawn(
      actor<number | 'get', number>({
        initial: 0,
        receive: async (sum, msg) => {
          if (msg === 'get') {
            probe.ref.tell(sum);
            return sum;
          }
          await Promise.resolve();
          return sum + msg;
        },
      }),
    );
    ref.tell(1);
    ref.tell(2);
    ref.tell('get');
    await kit.settle();
    expect(probe.expectMessage()).toBe(3);
  });
});

describe('fairness and yielding', () => {
  it('interleaves busy actors throughput messages at a time', async () => {
    const kit = createTestKit({ system: { throughput: 2 } });
    const log: string[] = [];
    const a = kit.system.spawn(recorder(log, 'A'));
    const b = kit.system.spawn(recorder(log, 'B'));
    await kit.settle(); // both started
    for (let i = 1; i <= 4; i++) {
      a.tell(String(i));
      b.tell(String(i));
    }
    await kit.settle();
    expect(log).toEqual(['A:1', 'A:2', 'B:1', 'B:2', 'A:3', 'A:4', 'B:3', 'B:4']);
  });

  it('yields to timers after yieldAfter messages in a row', async () => {
    const kit = createTestKit({ system: { yieldAfter: 50 } });
    let rallies = 0;
    let timerFiredAt = -1;
    type Ball = { from: ActorRef<Ball> };
    const player = actor<Ball, null>({
      initial: null,
      receive: (s, ball, ctx) => {
        rallies++;
        if (rallies < 1000) ball.from.tell({ from: ctx.self });
        return s;
      },
    });
    const ping = kit.system.spawn(player);
    const pong = kit.system.spawn(player);
    // Queued before the rally starts, at the same instant as the dispatcher's yields, so it runs
    // at the first yield.
    kit.scheduler.setTimer(() => (timerFiredAt = rallies), 0);
    ping.tell({ from: pong });
    await kit.settle();
    expect(rallies).toBe(1000);
    // The first drain runs two initial steps and 48 rallies before its first yield.
    expect(timerFiredAt).toBe(48);
  });
});
