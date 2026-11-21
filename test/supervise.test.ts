import { describe, expect, it } from 'vitest';
import { supervise } from '../src/supervision.js';

describe('supervise', () => {
  it('builds frozen strategies, with the documented defaults', () => {
    expect(supervise.stop()).toEqual({ type: 'stop' });
    expect(supervise.resume()).toEqual({ type: 'resume' });
    expect(supervise.restart()).toEqual({
      type: 'restart',
      maxRestarts: Infinity,
      withinMs: Infinity,
    });
    expect(supervise.restart({ maxRestarts: 0, withinMs: 10 })).toEqual({
      type: 'restart',
      maxRestarts: 0,
      withinMs: 10,
    });
    const backoff = supervise.restartWithBackoff({ minMs: 200, maxMs: 5000 });
    expect(backoff).toEqual({
      type: 'backoff',
      minMs: 200,
      maxMs: 5000,
      randomFactor: 0.2,
      resetAfterMs: 5000,
    });
    expect(Object.isFrozen(backoff)).toBe(true);
    expect(Object.isFrozen(supervise)).toBe(true);
  });

  const badRestart: [string, unknown][] = [
    ['options that are not an object', 3],
    ['an unknown option', { max: 2 }],
    ['a negative maxRestarts', { maxRestarts: -1 }],
    ['a fractional maxRestarts', { maxRestarts: 1.5 }],
    ['a zero withinMs', { withinMs: 0 }],
    ['a NaN withinMs', { withinMs: NaN }],
  ];
  for (const [what, opts] of badRestart) {
    it(`restart throws TypeError for ${what}`, () => {
      expect(() => supervise.restart(opts as never)).toThrow(TypeError);
    });
  }

  const goodBackoff = { minMs: 100, maxMs: 1000 };
  const badBackoff: [string, unknown][] = [
    ['no options', undefined],
    ['an unknown option', { ...goodBackoff, jitter: 0.1 }],
    ['a missing minMs', { maxMs: 1000 }],
    ['a zero minMs', { ...goodBackoff, minMs: 0 }],
    ['an infinite maxMs', { ...goodBackoff, maxMs: Infinity }],
    ['a maxMs below minMs', { minMs: 100, maxMs: 99 }],
    ['a negative randomFactor', { ...goodBackoff, randomFactor: -0.1 }],
    ['an infinite randomFactor', { ...goodBackoff, randomFactor: Infinity }],
    ['a NaN randomFactor', { ...goodBackoff, randomFactor: NaN }],
    ['a string randomFactor', { ...goodBackoff, randomFactor: '0.2' }],
    ['a zero resetAfterMs', { ...goodBackoff, resetAfterMs: 0 }],
  ];
  for (const [what, opts] of badBackoff) {
    it(`restartWithBackoff throws TypeError for ${what}`, () => {
      expect(() => supervise.restartWithBackoff(opts as never)).toThrow(TypeError);
    });
  }

  it('names the option that is wrong', () => {
    expect(() => supervise.restartWithBackoff({ minMs: 100, maxMs: 99 })).toThrow(
      /maxMs must be at least minMs/,
    );
    expect(() => supervise.restart({ withinMs: 0 })).toThrow(
      /withinMs must be a positive integer or Infinity, got 0/,
    );
  });
});
