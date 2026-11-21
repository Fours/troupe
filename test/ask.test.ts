import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { ActorSystemTerminatedError, AskTimeoutError } from '../src/errors.js';
import { createActorSystem } from '../src/system.js';
import { createTestKit, type TestKit } from '../src/testkit/kit.js';
import type { ActorRef, SystemEvent } from '../src/types.js';
import { deferred } from './helpers/deferred.js';
import { track } from './helpers/track.js';

type Msg =
  | { type: 'get'; replyTo: ActorRef<number> }
  | { type: 'getTwice'; replyTo: ActorRef<number> }
  | { type: 'ignore'; replyTo: ActorRef<number> };

/** Replies with 42, twice, or not at all. */
const server = actor<Msg, number>({
  initial: 42,
  receive: (n, msg) => {
    switch (msg.type) {
      case 'get':
        msg.replyTo.tell(n);
        return n;
      case 'getTwice':
        msg.replyTo.tell(n);
        msg.replyTo.tell(n + 1);
        return n;
      case 'ignore':
        return n;
    }
  },
});

function deadLetters(kit: TestKit): Extract<SystemEvent, { type: 'deadLetter' }>[] {
  return kit.events.filter((e) => e.type === 'deadLetter');
}

describe('ask', () => {
  it('resolves with the first reply, and later replies are askCompleted dead letters', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(server, 'server');
    let replyPath = '';
    const reply = ref.ask<number>((replyTo) => {
      replyPath = replyTo.path;
      return { type: 'getTwice', replyTo };
    });
    await kit.settle();

    await expect(reply).resolves.toBe(42);
    expect(replyPath).toBe('/temp/$1');
    expect(deadLetters(kit)).toMatchObject([
      { recipient: '/temp/$1', message: 43, reason: 'askCompleted' },
    ]);
    // The reply cancelled the timeout timer.
    expect(kit.scheduler.pendingTimers()).toBe(0);
  });

  it('gives each ask its own temporary ref', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(server, 'server');
    const paths: string[] = [];
    const replies = [1, 2, 3].map(() =>
      ref.ask<number>((replyTo) => {
        paths.push(replyTo.path);
        return { type: 'get', replyTo };
      }),
    );
    await kit.settle();

    await expect(Promise.all(replies)).resolves.toEqual([42, 42, 42]);
    expect(paths).toEqual(['/temp/$1', '/temp/$2', '/temp/$3']);
  });

  it('times out at exactly timeoutMs of virtual time, naming the target', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(server, 'server');
    let replyTo: ActorRef<number> | undefined;
    const reply = track(
      ref.ask<number>(
        (r) => {
          replyTo = r;
          return { type: 'ignore', replyTo: r };
        },
        { timeoutMs: 100 },
      ),
    );

    kit.scheduler.advanceTo(99);
    await kit.settle();
    expect(reply.state).toBe('pending');

    kit.scheduler.advanceTo(100);
    await kit.settle();
    expect(reply.state).toBe('rejected');
    expect(reply.error).toBeInstanceOf(AskTimeoutError);
    expect(reply.error).toMatchObject({
      name: 'AskTimeoutError',
      target: '/user/server',
      timeoutMs: 100,
      message: 'ask to /user/server got no reply within 100 ms',
    });

    // A reply after the timeout is a dead letter.
    replyTo?.tell(7);
    expect(deadLetters(kit)).toMatchObject([
      { recipient: '/temp/$1', message: 7, reason: 'askCompleted' },
    ]);
  });

  it("uses the system's askTimeoutMs by default", async () => {
    const kit = createTestKit({ system: { askTimeoutMs: 250 } });
    const ref = kit.system.spawn(server, 'server');
    const reply = track(ref.ask<number>((replyTo) => ({ type: 'ignore', replyTo })));

    kit.scheduler.advanceTo(249);
    await kit.settle();
    expect(reply.state).toBe('pending');
    kit.scheduler.advanceTo(250);
    await kit.settle();
    expect(reply.error).toMatchObject({ timeoutMs: 250 });
  });

  it('defaults askTimeoutMs to 5,000 ms', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(server, 'server');
    const reply = track(ref.ask<number>((replyTo) => ({ type: 'ignore', replyTo })));
    kit.scheduler.advanceTo(4999);
    await kit.settle();
    expect(reply.state).toBe('pending');
    kit.scheduler.advanceTo(5000);
    await kit.settle();
    expect(reply.error).toMatchObject({ timeoutMs: 5000 });
  });

  it('asking a stopped actor makes the message a dead letter, then times out', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(server, 'server');
    kit.system.stop(ref);
    await kit.settle();

    const reply = track(
      ref.ask<number>((replyTo) => ({ type: 'get', replyTo }), { timeoutMs: 50 }),
    );
    expect(deadLetters(kit)).toMatchObject([
      { recipient: '/user/server', message: { type: 'get' }, reason: 'stopped' },
    ]);
    await kit.settle();
    // It doesn't fail fast: a remote ref couldn't know either (decision 0009).
    expect(reply.state).toBe('pending');

    kit.scheduler.advanceTo(50);
    await kit.settle();
    expect(reply.error).toBeInstanceOf(AskTimeoutError);
  });

  it('rejects at once with what build threw, and sends nothing', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>('target');
    const boom = new Error('build broke');

    let kept: ActorRef<number> | undefined;
    const reply = probe.ref.ask<number>((replyTo) => {
      kept = replyTo;
      throw boom;
    });
    await expect(reply).rejects.toBe(boom);
    probe.expectNoMessage();
    expect(kit.scheduler.pendingTimers()).toBe(0);
    expect(kit.events).toEqual([]);

    // A reply through a ref that build kept has no ask left to answer.
    kept?.tell(1);
    expect(deadLetters(kit)).toMatchObject([{ message: 1, reason: 'askCompleted' }]);
  });

  it('works on any ref: a probe can be asked, and so can a temporary ref', async () => {
    const kit = createTestKit();
    const probe = kit.probe<ActorRef<string>>('asked');
    const reply = probe.ref.ask<string>((replyTo) => replyTo);
    const replyTo = probe.expectMessage();
    expect(replyTo.path).toBe('/temp/$1');

    // Asking the temporary ref sends it a message, which is the first reply to the outer ask.
    const nested = replyTo.ask<string>(() => 'from the nested ask');
    await expect(reply).resolves.toBe('from the nested ask');
    expect(track(nested).state).toBe('pending');
    kit.scheduler.advanceTo(5000);
    await kit.settle();
    await expect(nested).rejects.toBeInstanceOf(AskTimeoutError);
  });

  it('checks its options when they are passed in, and throws', () => {
    const kit = createTestKit();
    const probe = kit.probe<number>('target');
    const ask = (opts: unknown) => probe.ref.ask(() => 1, opts as { timeoutMs?: number });

    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, '100']) {
      expect(() => ask({ timeoutMs })).toThrow(TypeError);
    }
    expect(() => ask({ timeout: 100 })).toThrow('ask: unknown option "timeout"');
    expect(() => ask(null)).toThrow(TypeError);
    expect(() =>
      probe.ref.ask('not a function' as unknown as (replyTo: ActorRef<number>) => number),
    ).toThrow('ask: build must be a function');
    // Nothing was sent, and no timer was set.
    probe.expectNoMessage();
    expect(kit.scheduler.pendingTimers()).toBe(0);
    // timeoutMs: undefined means the default.
    void track(ask({ timeoutMs: undefined }));
    expect(kit.scheduler.pendingTimers()).toBe(1);
  });

  it('checks askTimeoutMs in createActorSystem', () => {
    for (const askTimeoutMs of [0, -5, 2.5, Infinity]) {
      expect(() => createActorSystem({ askTimeoutMs })).toThrow(
        'createActorSystem: askTimeoutMs must be a positive integer',
      );
    }
  });
});

describe('ask and terminate', () => {
  it('rejects pending asks at once, and every later one', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(server, 'server');
    let replyTo: ActorRef<number> | undefined;
    const pending = track(
      ref.ask<number>((r) => {
        replyTo = r;
        return { type: 'ignore', replyTo: r };
      }),
    );
    await kit.settle();

    const done = kit.system.terminate();
    await kit.settle();
    expect(pending.error).toBeInstanceOf(ActorSystemTerminatedError);
    expect(kit.scheduler.pendingTimers()).toBe(0);
    await done;

    await expect(ref.ask<number>((r) => ({ type: 'get', replyTo: r }))).rejects.toBeInstanceOf(
      ActorSystemTerminatedError,
    );
    // A reply that arrives after terminate() is a terminated dead letter.
    replyTo?.tell(1);
    expect(deadLetters(kit).at(-1)).toMatchObject({
      recipient: '/temp/$1',
      message: 1,
      reason: 'terminated',
    });
  });

  it('lets an actor whose async receive awaits an ask stop', async () => {
    const kit = createTestKit();
    const silent = kit.system.spawn(server, 'silent');
    const asking = deferred<unknown>();
    const asker = kit.system.spawn(
      actor<'go', null>({
        initial: null,
        receive: async (s) => {
          try {
            await silent.ask<number>((replyTo) => ({ type: 'ignore', replyTo }));
          } catch (error) {
            asking.resolve(error);
          }
          return s;
        },
      }),
      'asker',
    );
    asker.tell('go');
    kit.scheduler.runReady();

    const done = track(kit.system.terminate());
    await kit.settle();
    // No virtual time passed: the ask failed at once, so the receive settled and the actor stopped.
    expect(kit.scheduler.now()).toBe(0);
    expect(done.state).toBe('resolved');
    await expect(asking.promise).resolves.toBeInstanceOf(ActorSystemTerminatedError);
  });
});
