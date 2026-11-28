import { describe, expect, it } from 'vitest';
import { festival } from '../../demo/src/rehearsal/domain/festival.js';
import { FOUND } from './found.js';

// Milestone 5, T7: the hunt. Each bug it found in the real code is a regression plan here: the
// shrunk plan of the run that showed it broke its invariant before the fix, and must run clean
// on festival night now, every invariant included.

describe('the bugs the hunt found', () => {
  it('has one entry for each, named once, with a fix and a plan', () => {
    expect(new Set(FOUND.map((f) => f.name)).size).toBe(FOUND.length);
    for (const f of FOUND) {
      expect(f.plan.length, f.name).toBeGreaterThan(0);
      expect(f.plan.length, f.name).toBeLessThanOrEqual(5);
      expect(f.fix, f.name).not.toBe('');
    }
  });

  it.each(FOUND.map((f) => [f.name, f] as const))('runs clean now: %s', async (_name, f) => {
    const run = await festival({ mode: f.mode }).run({ seed: f.seed, plan: f.plan });
    expect(run.violations).toEqual([]);
    expect(run.expected).toEqual([]);
  });
});
