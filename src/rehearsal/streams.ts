// One seed draws everything in a run, through separate streams (decision 0034): the plan, each
// client's workload, each node incarnation's random and clock, the network and the database.
// Each stream is seeded from a hash of its name and the run's seed, so a change to one part of a
// run, such as a fault taken out of its plan, never shifts the draws of another.

import { fnv1a } from '../hash.js';
import { seededRandom } from '../testkit/random.js';

/** The random stream called `name` in the run seeded with `seed`. */
export function stream(seed: number, name: string): () => number {
  return seededRandom(fnv1a(`${name} ${String(seed)}`));
}

/** Picks one of `items` with `random`. `items` must not be empty. */
export function pick<T>(random: () => number, items: readonly T[]): T {
  // The caller guarantees at least one item, so the index is always in range.
  return items[Math.floor(random() * items.length)] as T;
}
