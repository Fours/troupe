import { describe, expect, it } from 'vitest';
import { median, percentile, perSecond, spread, within } from '../../bench/stats.ts';

describe('median', () => {
  it('takes the middle value of an odd count, whatever the order', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([7])).toBe(7);
  });

  it('takes the mean of the middle two of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it("doesn't reorder its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('refuses no values', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('percentile', () => {
  // 1..100, shuffled, so rank and value coincide.
  const hundred = Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1);

  it('is the nearest rank: the ceil(p/100 × n)-th smallest', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile(hundred, 0.5)).toBe(1);
  });

  it('picks a value a sample had, with no interpolation', () => {
    // ceil(0.5 × 4) = 2nd smallest; ceil(0.99 × 4) = 4th.
    expect(percentile([10, 40, 20, 30], 50)).toBe(20);
    expect(percentile([10, 40, 20, 30], 99)).toBe(40);
    // ceil(0.99 × 10) = 10th: with ten samples, p99 is the slowest.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10);
  });

  it('refuses no values and a p outside (0, 100]', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe('spread', () => {
  it('gives the median, range, and range as a percentage of the median', () => {
    expect(spread([90, 110, 100, 105, 95])).toEqual({
      median: 100,
      min: 90,
      max: 110,
      spreadPct: 20,
    });
  });

  it('is 0% for one run', () => {
    expect(spread([42]).spreadPct).toBe(0);
  });
});

describe('perSecond', () => {
  it('scales a count over ms to a count per second', () => {
    expect(perSecond(500, 250)).toBe(2000);
  });

  it('refuses a duration that would divide by zero', () => {
    expect(() => perSecond(1, 0)).toThrow(RangeError);
  });
});

describe('within', () => {
  it('includes both ends of the range', () => {
    expect(within(90, { min: 90, max: 110 })).toBe(true);
    expect(within(110, { min: 90, max: 110 })).toBe(true);
    expect(within(89.9, { min: 90, max: 110 })).toBe(false);
    expect(within(110.1, { min: 90, max: 110 })).toBe(false);
  });
});
