// The checks Rehearsal's simulated pieces share for the ranges and chances their faults take, so
// the network and the database reject exactly the same values.

import { checkInt, describe } from '../checks.js';

/** A range of whole ms, both ends included. */
export type Range = readonly [number, number];

/** Checks a `[min, max]` range of non-negative integers, with `min` at most `max`. */
export function checkRange(range: unknown, what: string): Range {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new TypeError(`${what} must be [min, max], got ${describe(range)}`);
  }
  const [min, max] = range as unknown[];
  checkInt(min, `${what}[0]`, { min: 0 });
  checkInt(max, `${what}[1]`, { min: 0 });
  if ((max as number) < (min as number)) {
    throw new TypeError(`${what} must have min at most max, got [${String(min)}, ${String(max)}]`);
  }
  return [min as number, max as number];
}

/** Checks a chance: a number above 0 and at most 1. */
export function checkRate(rate: unknown, what: string): number {
  if (typeof rate !== 'number' || !(rate > 0 && rate <= 1)) {
    throw new TypeError(
      `${what}: rate must be a number above 0 and at most 1, got ${describe(rate)}`,
    );
  }
  return rate;
}

/** Draws a whole number from `range`, both ends included. */
export function draw(random: () => number, [min, max]: Range): number {
  return min + Math.floor(random() * (max - min + 1));
}
