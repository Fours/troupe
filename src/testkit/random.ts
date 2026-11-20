/**
 * A seeded pseudo-random source in `[0, 1)`, for the system's `random` option. The same seed
 * always gives the same sequence, so a test that uses one is repeatable (decision 0003).
 *
 * It uses mulberry32: fast, small, with a 32-bit state. It's good enough for jitter and
 * simulation, and not for anything cryptographic.
 *
 * @param seed Any safe integer. Only its low 32 bits are used.
 * @throws TypeError if `seed` isn't a safe integer.
 */
export function seededRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError(`seededRandom: seed must be a safe integer, got ${String(seed)}`);
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
