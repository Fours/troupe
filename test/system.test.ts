import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { ActorNameError } from '../src/errors.js';
import { createTestKit } from '../src/testkit/kit.js';
import type { ActorContext, ActorRef } from '../src/types.js';

type CounterMsg = { type: 'inc'; by: number } | { type: 'get'; replyTo: ActorRef<number> };

const counter = actor<CounterMsg, number>({
  initial: 0,
  receive(count, msg) {
    switch (msg.type) {
      case 'inc':
        return count + msg.by;
      case 'get':
        msg.replyTo.tell(count);
        return count;
    }
  },
});

describe('state', () => {
  it('threads state through receive', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    const ref = kit.system.spawn(counter, 'counter');
    ref.tell({ type: 'inc', by: 2 });
    ref.tell({ type: 'inc', by: 3 });
    ref.tell({ type: 'get', replyTo: probe.ref });
    ref.tell({ type: 'inc', by: 10 });
    ref.tell({ type: 'get', replyTo: probe.ref });
    await kit.settle();
    expect(probe.messages()).toEqual([5, 15]);
  });

  it('runs initial once, as a value', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number[]>();
    const def = actor<'push' | 'get', number[]>({
      initial: [],
      receive: (list, msg) => {
        if (msg === 'get') {
          probe.ref.tell(list);
          return list;
        }
        return [...list, list.length];
      },
    });
    const ref = kit.system.spawn(def);
    ref.tell('push');
    ref.tell('push');
    ref.tell('get');
    await kit.settle();
    expect(probe.expectMessage()).toEqual([0, 1]);
  });

  it('runs initial once, as a factory, after spawn returns and before any message', async () => {
    const kit = createTestKit();
    const order: string[] = [];
    let ctxSeen: ActorContext<string> | undefined;
    const def = actor<string, number>({
      initial: (ctx) => {
        order.push('initial');
        ctxSeen = ctx;
        return 0;
      },
      receive: (n, msg) => {
        order.push(msg);
        return n + 1;
      },
    });
    const ref = kit.system.spawn(def);
    ref.tell('a');
    ref.tell('b');
    order.push('after spawn');
    await kit.settle();
    expect(order).toEqual(['after spawn', 'initial', 'a', 'b']);
    expect(ctxSeen?.self).toBe(ref);
  });
});

describe('refs and paths', () => {
  it('gives ctx.self the same object spawn returned', async () => {
    const kit = createTestKit();
    let self: unknown;
    const ref = kit.system.spawn(
      actor<'who', null>({
        initial: null,
        receive: (s, _msg, ctx) => {
          self = ctx.self;
          return s;
        },
      }),
      'me',
    );
    ref.tell('who');
    await kit.settle();
    expect(self).toBe(ref);
    expect(Object.isFrozen(ref)).toBe(true);
  });

  it('puts top-level actors under /user, and generates $n names per parent', () => {
    const kit = createTestKit();
    expect(kit.system.spawn(counter, 'counter').path).toBe('/user/counter');
    expect(kit.system.spawn(counter).path).toBe('/user/$1');
    expect(kit.system.spawn(counter).path).toBe('/user/$2');
    expect(kit.system.spawn(counter, 'other').path).toBe('/user/other');
    expect(kit.system.spawn(counter).path).toBe('/user/$3');
  });

  it('throws ActorNameError for invalid, reserved and duplicate names, synchronously', () => {
    const kit = createTestKit();
    kit.system.spawn(counter, 'taken');
    for (const bad of ['', 'has space', 'a/b', '-leading', '.dot', 'x'.repeat(65), 'café']) {
      expect(() => kit.system.spawn(counter, bad), bad).toThrow(ActorNameError);
    }
    expect(() => kit.system.spawn(counter, '$1')).toThrow(/reserved/);
    expect(() => kit.system.spawn(counter, 'taken')).toThrow(/already taken under \/user/);
    expect(() => kit.system.spawn(counter, 42 as unknown as string)).toThrow(ActorNameError);
    // The longest valid name, and the allowed punctuation.
    expect(kit.system.spawn(counter, 'x'.repeat(64)).path).toBe(`/user/${'x'.repeat(64)}`);
    expect(kit.system.spawn(counter, 'a.b_c~d-e').path).toBe('/user/a.b_c~d-e');
  });

  it('publishes a spawned event for each actor', () => {
    const kit = createTestKit();
    kit.system.spawn(counter, 'a');
    kit.system.spawn(counter, 'b');
    expect(kit.events.map((e) => (e.type === 'spawned' ? e.path : e.type))).toEqual([
      '/user/a',
      '/user/b',
    ]);
  });
});

describe('context', () => {
  it("reads the scheduler's time, and logs with the actor's path", async () => {
    const kit = createTestKit({ startTime: 5000 });
    let now = -1;
    const ref = kit.system.spawn(
      actor<'go', null>({
        initial: null,
        receive: (s, _msg, ctx) => {
          now = ctx.now();
          ctx.log.info('hello', { extra: 1 });
          ctx.log.warn('bare');
          return s;
        },
      }),
      'logger',
    );
    ref.tell('go');
    await kit.settle();
    expect(now).toBe(5000);
    expect(kit.logs).toEqual([
      { level: 'info', msg: 'hello', fields: { path: '/user/logger', extra: 1 } },
      { level: 'warn', msg: 'bare', fields: { path: '/user/logger' } },
    ]);
  });
});

describe('bounded mailbox', () => {
  it('turns overflow into mailboxFull dead letters', async () => {
    const kit = createTestKit();
    const probe = kit.probe<number>();
    const ref = kit.system.spawn(
      actor<number, null>({
        initial: null,
        receive: (s, n) => {
          probe.ref.tell(n);
          return s;
        },
      }),
      'small',
      { mailbox: { capacity: 2 } },
    );
    for (let i = 1; i <= 4; i++) ref.tell(i);
    await kit.settle();
    expect(probe.messages()).toEqual([1, 2]);
    const dead = kit.events.filter((e) => e.type === 'deadLetter');
    expect(dead).toMatchObject([
      { recipient: '/user/small', message: 3, reason: 'mailboxFull' },
      { recipient: '/user/small', message: 4, reason: 'mailboxFull' },
    ]);
    // Once drained, there's room again.
    ref.tell(5);
    await kit.settle();
    expect(probe.messages()).toEqual([5]);
  });
});
