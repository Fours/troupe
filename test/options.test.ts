import { describe, expect, it } from 'vitest';
import { actor } from '../src/actor.js';
import { silentLogger } from '../src/logger.js';
import { createActorSystem } from '../src/system.js';
import { ManualScheduler } from '../src/testkit/manual-scheduler.js';
import type { ActorSystemOptions } from '../src/types.js';

const idle = actor<never, null>({ initial: null, receive: (s) => s });
const base = { scheduler: new ManualScheduler(), logger: silentLogger };

describe('createActorSystem options', () => {
  it('accepts no options, and defaults the name', () => {
    expect(createActorSystem().name).toBe('troupe');
    expect(createActorSystem({ ...base, name: 'orders-2' }).name).toBe('orders-2');
  });

  const bad: [string, unknown][] = [
    ['options that are not an object', null],
    ['an array', []],
    ['an unknown field', { askTimeout: 5 }],
    ['an empty name', { name: '' }],
    ['an upper-case name', { name: 'Orders' }],
    ['a name with a slash', { name: 'a/b' }],
    ['a non-string name', { name: 3 }],
    ['a scheduler missing setTimer', { scheduler: { now: () => 0, runSoon: () => {} } }],
    ['a null scheduler', { scheduler: null }],
    ['a logger missing debug', { logger: { info() {}, warn() {}, error() {} } }],
    ['a zero throughput', { throughput: 0 }],
    ['a fractional throughput', { throughput: 1.5 }],
    ['a string throughput', { throughput: '10' }],
    ['a negative yieldAfter', { yieldAfter: -1 }],
    ['an infinite yieldAfter', { yieldAfter: Infinity }],
    ['a random that is not a function', { random: 0.5 }],
  ];
  for (const [what, opts] of bad) {
    it(`throws TypeError for ${what}`, () => {
      expect(() => createActorSystem(opts as ActorSystemOptions)).toThrow(TypeError);
    });
  }

  it('names the unknown field', () => {
    expect(() => createActorSystem({ askTimeout: 5 } as ActorSystemOptions)).toThrow(
      /unknown option "askTimeout"/,
    );
  });
});

describe('spawn checks', () => {
  const system = createActorSystem(base);

  it('accepts a bounded mailbox, and an empty mailbox option', () => {
    expect(system.spawn(idle, undefined, { mailbox: { capacity: 1 } }).path).toMatch(/^\/user\//);
    expect(system.spawn(idle, undefined, { mailbox: {} }).path).toMatch(/^\/user\//);
    expect(system.spawn(idle, undefined, {}).path).toMatch(/^\/user\//);
  });

  const badOpts: [string, unknown][] = [
    ['options that are not an object', 5],
    ['an unknown field', { supervisor: 'stop' }],
    ['a supervision that is a string', { supervision: 'stop' }],
    ['a supervision of an unknown type', { supervision: { type: 'escalate' } }],
    ['a stop strategy with extra fields', { supervision: { type: 'stop', maxRestarts: 1 } }],
    [
      'a hand-built restart with a bad limit',
      { supervision: { type: 'restart', maxRestarts: -1, withinMs: 10 } },
    ],
    [
      'a hand-built backoff with no randomFactor',
      { supervision: { type: 'backoff', minMs: 1, maxMs: 2, resetAfterMs: 2 } },
    ],
    ['an unknown mailbox field', { mailbox: { size: 2 } }],
    ['a mailbox that is not an object', { mailbox: 3 }],
    ['a zero capacity', { mailbox: { capacity: 0 } }],
    ['a fractional capacity', { mailbox: { capacity: 2.5 } }],
  ];
  for (const [what, opts] of badOpts) {
    it(`throws TypeError for ${what}`, () => {
      expect(() => system.spawn(idle, undefined, opts as never)).toThrow(TypeError);
    });
  }

  const badDefs: [string, unknown][] = [
    ['a definition that is not an object', 'counter'],
    ['a null definition', null],
    ['a definition with no initial', { receive: () => null }],
    ['a definition whose receive is not a function', { initial: 0, receive: 1 }],
  ];
  for (const [what, def] of badDefs) {
    it(`throws TypeError for ${what}`, () => {
      expect(() => system.spawn(def as never)).toThrow(TypeError);
    });
  }

  it('accepts hand-built strategies that are valid', () => {
    const strategies = [
      { type: 'stop' },
      { type: 'resume' },
      { type: 'restart', maxRestarts: 0, withinMs: Infinity },
      { type: 'backoff', minMs: 1, maxMs: 1, randomFactor: 0, resetAfterMs: 1 },
    ] as const;
    for (const supervision of strategies) {
      expect(system.spawn(idle, undefined, { supervision }).path).toMatch(/^\/user\//);
    }
  });

  it("doesn't claim the name when the checks fail", () => {
    expect(() => system.spawn(idle, 'kept', { mailbox: { capacity: 0 } })).toThrow(TypeError);
    expect(system.spawn(idle, 'kept').path).toBe('/user/kept');
  });
});
