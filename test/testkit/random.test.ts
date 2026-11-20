import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/testkit/random.js';

const take = (random: () => number, n: number) => Array.from({ length: n }, () => random());

describe('seededRandom', () => {
  it('gives the same sequence for the same seed', () => {
    expect(take(seededRandom(42), 100)).toEqual(take(seededRandom(42), 100));
  });

  it('gives different sequences for different seeds', () => {
    expect(take(seededRandom(1), 10)).not.toEqual(take(seededRandom(2), 10));
  });

  it('pins the sequence, so a change to the generator is noticed', () => {
    // Recorded seeds in tests and simulations would replay differently if the algorithm changed.
    expect(take(seededRandom(1), 3)).toMatchInlineSnapshot(`
      [
        0.6270739405881613,
        0.002735721180215478,
        0.5274470399599522,
      ]
    `);
  });

  it('stays in [0, 1), and spreads across it', () => {
    const values = take(seededRandom(7), 10_000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
    const buckets = new Array<number>(10).fill(0);
    for (const v of values) buckets[Math.floor(v * 10)] = (buckets[Math.floor(v * 10)] ?? 0) + 1;
    for (const count of buckets) expect(count).toBeGreaterThan(850);
  });

  it('accepts 0 and negative seeds', () => {
    expect(take(seededRandom(0), 5)).toEqual(take(seededRandom(0), 5));
    expect(take(seededRandom(-1), 5)).not.toEqual(take(seededRandom(0), 5));
  });

  it('rejects seeds that are not safe integers', () => {
    for (const seed of [1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => seededRandom(seed)).toThrow(TypeError);
    }
  });
});
