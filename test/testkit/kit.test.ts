import { describe, expect, it } from 'vitest';
import { actor } from '../../src/actor.js';
import { ActorNameError } from '../../src/errors.js';
import { createTestKit, SettleTimeoutError } from '../../src/testkit/kit.js';
import { deepEqual } from '../../src/testkit/probe.js';

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

  it('throws SettleTimeoutError when an actor awaits a promise that never settles', async () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(
      actor<'hang', null>({ initial: null, receive: () => new Promise<null>(() => {}) }),
    );
    ref.tell('hang');
    await expect(kit.settle()).rejects.toThrow(SettleTimeoutError);
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
