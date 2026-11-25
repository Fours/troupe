// Shrinking (milestone 5, T6): a failing run, cut down to the smallest plan that still fails the
// same invariant (decision 0034). Every attempt is a whole run with the same seed and an edited
// plan, so each is deterministic, and the streams keep the workload and every node's draws the
// same whatever is taken out. Pure over plans: the caller says whether an attempt still fails.

import { endOf, type Fault, type FaultPlan } from './plan.js';
import type { Violation } from './invariants.js';

/** Whether a run of `plan`, ended at `untilMs`, still fails: the violation it found, if it did. */
export type StillFails = (plan: FaultPlan, untilMs: number) => Promise<Violation | undefined>;

/** A failing run, shrunk. */
export interface Shrunk {
  readonly plan: FaultPlan;
  readonly untilMs: number;
  /** The violation the shrunk run finds. */
  readonly violation: Violation;
  /** How many runs shrinking took. */
  readonly runs: number;
}

/** What shrinking needs to know of the scenario. */
export interface ShrinkWorld {
  readonly durationMs: number;
  /** When the quiet tail begins, which every fault must end by. */
  readonly quietFrom: number;
}

type DurationKey = 'ms' | 'restartAfterMs' | 'rejoinAfterMs';

function durationKey(fault: Fault): DurationKey | undefined {
  if ('ms' in fault) return 'ms';
  if ('restartAfterMs' in fault) return 'restartAfterMs';
  if ('rejoinAfterMs' in fault) return 'rejoinAfterMs';
  return undefined;
}

function withDuration(fault: Fault, key: DurationKey, ms: number): Fault {
  return { ...fault, [key]: ms };
}

// In order of `at`, keeping the order of faults that start together.
function sorted(plan: readonly Fault[]): Fault[] {
  return plan
    .map((fault, i) => ({ fault, i }))
    .sort((a, b) => a.fault.at - b.fault.at || a.i - b.i)
    .map(({ fault }) => fault);
}

/**
 * Shrinks a failing run in three steps, each keeping only edits that still fail:
 *
 * 1. Removes faults: in halves, then quarters, and so on down to one at a time.
 * 2. Shortens each fault left: halves its length, then moves its start later, while it still
 *    fails.
 * 3. Cuts the run to just past the violation, which for `recovers` already includes the time it
 *    allows.
 *
 * At most `maxRuns` attempts. Returns what it had when it ran out.
 */
export async function shrink(
  plan: FaultPlan,
  found: Violation,
  world: ShrinkWorld,
  stillFails: StillFails,
  maxRuns: number,
): Promise<Shrunk> {
  let current: Fault[] = [...plan];
  let violation = found;
  const untilMs = world.durationMs;
  let runs = 0;
  const attempt = async (next: Fault[], until: number): Promise<boolean> => {
    if (runs >= maxRuns) return false;
    runs++;
    const v = await stillFails(next, until);
    if (v === undefined) return false;
    violation = v;
    return true;
  };

  // 1. Remove faults, in chunks that halve down to one.
  for (let size = Math.max(1, Math.floor(current.length / 2)); size >= 1;) {
    let removed = false;
    for (let start = 0; start < current.length && runs < maxRuns;) {
      const next = [...current.slice(0, start), ...current.slice(start + size)];
      if (await attempt(next, untilMs)) {
        current = next;
        removed = true;
      } else {
        start += size;
      }
    }
    if (size === 1 && !removed) break;
    if (size === 1) continue;
    size = Math.max(1, Math.floor(size / 2));
  }

  // 2. Shorten each fault: halve its length, then move its start later. Moving one re-sorts the
  // plan, so each is found again by identity rather than by its place.
  for (const original of [...current]) {
    let fault = original;
    const replace = async (edited: Fault): Promise<boolean> => {
      const next = sorted(current.map((f) => (f === fault ? edited : f)));
      if (!(await attempt(next, untilMs))) return false;
      fault = edited;
      current = next;
      return true;
    };
    const key = durationKey(fault);
    if (key !== undefined) {
      for (;;) {
        const half = Math.floor((fault as unknown as Record<DurationKey, number>)[key] / 2);
        if (half < 1 || runs >= maxRuns || !(await replace(withDuration(fault, key, half)))) break;
      }
    }
    // Later, by half of what's left before the quiet tail each time it still fails.
    let shift = Math.floor((world.quietFrom - endOf(fault)) / 2);
    while (shift >= 1 && runs < maxRuns) {
      if (await replace({ ...fault, at: fault.at + shift })) {
        shift = Math.floor((world.quietFrom - endOf(fault)) / 2);
      } else {
        shift = Math.floor(shift / 2);
      }
    }
  }

  // 3. Cut the run just past the violation.
  let until = untilMs;
  const cut = Math.max(violation.time, violation.until ?? 0) + 1;
  if (Number.isFinite(cut) && cut < untilMs && (await attempt(current, cut))) until = cut;

  return { plan: current, untilMs: until, violation, runs };
}
