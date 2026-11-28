// rehearse() and replay() (milestone 5, T6). rehearse runs a scenario on seed after seed in this
// process, shrinks each failing run to the smallest plan that still fails the same invariant, and
// gives each failure the line that replays it (decision 0034). replay runs a line and says whether
// it found the same violation again, since a line that doesn't reproduce means something in the
// run isn't deterministic. `npm run rehearse` splits a range of seeds across worker processes
// with the per-seed pieces here: that's a script, not public API.

import { checkInt, checkKeys, describe } from '../checks.js';
import { VERSION } from '../version.js';
import type { Violation } from './invariants.js';
import type { FaultPlan } from './plan.js';
import { decodeReplay, encodeReplay } from './replay.js';
import { scenarioInfo, type Run, type Scenario } from './scenario.js';
import { shrink, type Shrunk } from './shrink.js';

/** Options for {@link rehearse}. */
export interface RehearseOptions {
  /** The seeds to run: `count` of them, from `from`. */
  readonly seeds: { readonly from: number; readonly count: number };
  /**
   * Invariants whose violations are counted in the report but don't make a seed fail, such as
   * one a known bug breaks while it's being fixed. Default none.
   */
  readonly ignore?: readonly string[];
  /** Stops once this many seeds have failed. Default no limit. */
  readonly maxFailures?: number;
  /** The most runs shrinking one failure may take. Default 500, and 0 doesn't shrink. */
  readonly maxShrinkRuns?: number;
  /**
   * Runs every `n`th seed twice and checks that the two histories are identical, byte for byte.
   * Default 0, never.
   */
  readonly determinismEvery?: number;
  /** Called after each seed, in order. It mustn't throw. */
  readonly onSeed?: (result: SeedResult) => void;
}

/** What one seed's run did, as {@link rehearse} reports it. */
export interface SeedResult {
  /** The seed. */
  readonly seed: number;
  /** How many faults its plan had. */
  readonly faults: number;
  /** Every violation the run found, ignored ones included. */
  readonly violations: readonly Violation[];
  /** The ones that made it fail: not ignored. */
  readonly failing: readonly Violation[];
  /** How many overlaps were `expected`, past the lease's margin with the journal holding. */
  readonly expected: number;
  /** Whether two runs gave the same history, if this seed was run twice. */
  readonly deterministic?: boolean;
}

/** A seed that failed, shrunk, with the line that replays the shrunk run. */
export interface Failure {
  /** The seed whose run failed. */
  readonly seed: number;
  /** The invariant it was shrunk for: the first one that failed. */
  readonly invariant: string;
  /** Every violation the seed's own run found that wasn't ignored. */
  readonly violations: readonly Violation[];
  /** The seed's own plan. */
  readonly plan: FaultPlan;
  /** The smallest plan found that still fails `invariant`, and where it can end. */
  readonly shrunk: Shrunk;
  /** Replays the shrunk run. */
  readonly replay: string;
}

/** What {@link rehearse} found. */
export interface RehearsalReport {
  /** How many seeds ran. */
  readonly seeds: number;
  /** How many runs it took, shrinking and determinism checks included. */
  readonly runs: number;
  /** Seeds that failed, each shrunk. */
  readonly failures: readonly Failure[];
  /** How many seeds each invariant found a violation in, ignored ones included. */
  readonly failing: Readonly<Record<string, number>>;
  /** How many seeds had overlaps reported as `expected`. */
  readonly expected: number;
  /** Seeds whose two runs differed. Each one is a bug: a run must be a pure function of its seed. */
  readonly nondeterministic: readonly number[];
}

/** What tests and the script set that users can't. */
export interface RehearseInternals {
  /**
   * The same scenario with no bug planted. A violation counts only if this scenario's run of the
   * same seed, plan and end doesn't find one of the same invariant, so a planted bug is found by
   * what it breaks, not by what was broken already.
   */
  readonly baseline?: Scenario;
  /** Only violations of these invariants count. Default all. */
  readonly target?: readonly string[];
}

const OPTIONS = new Set([
  'seeds',
  'ignore',
  'maxFailures',
  'maxShrinkRuns',
  'determinismEvery',
  'onSeed',
]);

/** The violation a stall becomes, so a stalled run fails, shrinks and replays like any other. */
function stalled(error: Error): Violation {
  return { invariant: 'stall', message: error.message, time: 0 };
}

function isStall(error: unknown): error is Error {
  return error instanceof Error && error.name === 'StallError';
}

/** One seed's run, in the shape the report counts, and the run itself if it didn't stall. */
export interface Checked {
  readonly result: SeedResult;
  readonly run: Run | undefined;
}

/** A checked set of options, with defaults filled in. */
interface Settings {
  readonly ignore: ReadonlySet<string>;
  readonly target: ReadonlySet<string> | undefined;
  readonly baseline: Scenario | undefined;
}

function settingsOf(ignore: readonly string[], internals: RehearseInternals): Settings {
  return {
    ignore: new Set(ignore),
    target: internals.target === undefined ? undefined : new Set(internals.target),
    baseline: internals.baseline,
  };
}

/** Runs a seed, or a seed with an edited plan, and returns its violations, a stall as one. */
async function attempt(
  s: Scenario,
  seed: number,
  plan: FaultPlan | undefined,
  untilMs: number | undefined,
): Promise<{ run: Run | undefined; violations: readonly Violation[]; expected: number }> {
  try {
    const run = await s.run({
      seed,
      ...(plan === undefined ? {} : { plan }),
      ...(untilMs === undefined ? {} : { untilMs }),
    });
    return { run, violations: run.violations, expected: run.expected.length };
  } catch (error) {
    if (isStall(error)) return { run: undefined, violations: [stalled(error)], expected: 0 };
    throw error;
  }
}

/** The violations that count: targeted, not ignored, and not found by the baseline too. */
async function counted(
  violations: readonly Violation[],
  settings: Settings,
  seed: number,
  plan: FaultPlan,
  untilMs: number | undefined,
): Promise<{ failing: Violation[]; runs: number }> {
  const failing = violations.filter(
    (v) =>
      !settings.ignore.has(v.invariant) &&
      (settings.target === undefined || settings.target.has(v.invariant)),
  );
  if (failing.length === 0 || settings.baseline === undefined) return { failing, runs: 0 };
  const base = await attempt(settings.baseline, seed, plan, untilMs);
  const already = new Set(base.violations.map((v) => v.invariant));
  return { failing: failing.filter((v) => !already.has(v.invariant)), runs: 1 };
}

/**
 * Runs one seed, and again to compare if `twice`. For the script's workers.
 * @returns The seed's result, its run, and how many runs it took.
 */
export async function runSeed(
  s: Scenario,
  seed: number,
  opts: { readonly ignore?: readonly string[]; readonly twice?: boolean },
  internals: RehearseInternals = {},
): Promise<Checked & { readonly runs: number }> {
  const settings = settingsOf(opts.ignore ?? [], internals);
  const first = await attempt(s, seed, undefined, undefined);
  const plan = first.run?.plan ?? s.plan(seed);
  let runs = 1;
  const { failing, runs: baseRuns } = await counted(
    first.violations,
    settings,
    seed,
    plan,
    undefined,
  );
  runs += baseRuns;
  let deterministic: boolean | undefined;
  if (opts.twice === true) {
    const second = await attempt(s, seed, undefined, undefined);
    runs++;
    deterministic =
      first.run !== undefined && second.run !== undefined
        ? JSON.stringify(first.run.history) === JSON.stringify(second.run.history)
        : JSON.stringify(first.violations) === JSON.stringify(second.violations);
  }
  const result: SeedResult = {
    seed,
    faults: plan.length,
    violations: first.violations,
    failing,
    expected: first.expected,
    ...(deterministic === undefined ? {} : { deterministic }),
  };
  return { result, run: first.run, runs };
}

/**
 * Shrinks a failing seed for the first invariant it failed, and returns it with its replay line.
 * For the script's workers.
 */
export async function shrinkSeed(
  s: Scenario,
  seed: number,
  failing: readonly Violation[],
  opts: { readonly ignore?: readonly string[]; readonly maxShrinkRuns?: number },
  internals: RehearseInternals = {},
): Promise<Failure> {
  const settings = settingsOf(opts.ignore ?? [], internals);
  const first = failing[0];
  if (first === undefined) throw new TypeError('shrinkSeed: the seed has no failing violation');
  const { invariant } = first;
  const plan = s.plan(seed);
  const world = scenarioInfo(s);
  let baseRuns = 0;
  const shrunk = await shrink(
    plan,
    first,
    world,
    async (edited, untilMs) => {
      const cut = untilMs < world.durationMs ? untilMs : undefined;
      const tried = await attempt(s, seed, edited, cut);
      const { failing: still, runs } = await counted(tried.violations, settings, seed, edited, cut);
      baseRuns += runs;
      return still.find((v) => v.invariant === invariant);
    },
    opts.maxShrinkRuns ?? 500,
  );
  const replay = encodeReplay({
    seed,
    mode: s.mode,
    plan: shrunk.plan,
    ...(shrunk.untilMs < world.durationMs ? { untilMs: shrunk.untilMs } : {}),
    ...(world.plant === undefined ? {} : { plant: world.plant }),
    violation: { invariant, message: shrunk.violation.message },
  });
  return {
    seed,
    invariant,
    violations: failing,
    plan,
    shrunk: { ...shrunk, runs: shrunk.runs + baseRuns },
    replay,
  };
}

/**
 * Runs `scenario` on each seed in turn, in this process. Each seed that fails an invariant not
 * ignored is shrunk to the smallest plan that still fails it, with a line that replays it.
 * @throws TypeError for options that can't be used, unknown ones included.
 */
export async function rehearse(
  scenario: Scenario,
  opts: RehearseOptions,
): Promise<RehearsalReport> {
  return rehearseWith(scenario, opts, {});
}

/** {@link rehearse}, with what only tests and the script set. */
export async function rehearseWith(
  scenario: Scenario,
  opts: RehearseOptions,
  internals: RehearseInternals,
): Promise<RehearsalReport> {
  checkKeys(opts, OPTIONS, 'rehearse');
  const seeds = opts.seeds as { from?: unknown; count?: unknown } | null | undefined;
  if (typeof seeds !== 'object' || seeds === null) {
    throw new TypeError(`rehearse: seeds must be { from, count }, got ${describe(seeds)}`);
  }
  checkKeys(seeds, new Set(['from', 'count']), 'rehearse: seeds');
  if (typeof seeds.from !== 'number' || !Number.isSafeInteger(seeds.from)) {
    throw new TypeError(`rehearse: seeds.from must be a safe integer, got ${describe(seeds.from)}`);
  }
  checkInt(seeds.count, 'rehearse: seeds.count', { min: 0 });
  const ignore = opts.ignore ?? [];
  if (!Array.isArray(ignore) || ignore.some((name) => typeof name !== 'string')) {
    throw new TypeError(
      `rehearse: ignore must be a list of invariant names, got ${describe(ignore)}`,
    );
  }
  const maxFailures = opts.maxFailures ?? Infinity;
  if (maxFailures !== Infinity) checkInt(maxFailures, 'rehearse: maxFailures');
  const maxShrinkRuns = opts.maxShrinkRuns ?? 500;
  checkInt(maxShrinkRuns, 'rehearse: maxShrinkRuns', { min: 0 });
  const every = opts.determinismEvery ?? 0;
  checkInt(every, 'rehearse: determinismEvery', { min: 0 });
  if (opts.onSeed !== undefined && typeof opts.onSeed !== 'function') {
    throw new TypeError(`rehearse: onSeed must be a function, got ${describe(opts.onSeed)}`);
  }
  const from = seeds.from;
  const count = seeds.count as number;

  let runs = 0;
  let expected = 0;
  const failures: Failure[] = [];
  const failing: Record<string, number> = {};
  const nondeterministic: number[] = [];
  for (let seed = from; seed < from + count && failures.length < maxFailures; seed++) {
    const twice = every > 0 && seed % every === 0;
    const checked = await runSeed(scenario, seed, { ignore, twice }, internals);
    runs += checked.runs;
    const { result } = checked;
    for (const name of new Set(result.violations.map((v) => v.invariant))) {
      failing[name] = (failing[name] ?? 0) + 1;
    }
    if (result.expected > 0) expected++;
    if (result.deterministic === false) nondeterministic.push(seed);
    opts.onSeed?.(result);
    if (result.failing.length === 0) continue;
    const failure = await shrinkSeed(
      scenario,
      seed,
      result.failing,
      { ignore, maxShrinkRuns },
      internals,
    );
    runs += failure.shrunk.runs;
    failures.push(failure);
  }
  return { seeds: count, runs, failures, failing, expected, nondeterministic };
}

/** What {@link replay} found. */
export interface Replayed {
  /** Whether the run found the violation its line recorded, or passed if its line recorded none. */
  readonly reproduced: boolean;
  /** The run, unless it stalled. */
  readonly run: Run | undefined;
  /** The violation the line recorded, if it recorded one. */
  readonly recorded: { readonly invariant: string; readonly message: string } | undefined;
  /** The violation the run found that matched, if one did. */
  readonly found: Violation | undefined;
  /** What happened, in a sentence or two. */
  readonly message: string;
}

/**
 * Runs a replay line on `scenario` and checks it finds the violation the line recorded, or, for a
 * line from a run that passed, that it passes. A line that doesn't reproduce says so, since a run
 * is a pure function of its seed and plan: something in it isn't deterministic, or the line came
 * from another version of this package, which the message names. A seed's plan and history are
 * promised only within one version (decision 0039).
 * @throws TypeError for a line that can't be run on `scenario`.
 */
export async function replay(scenario: Scenario, line: string): Promise<Replayed> {
  const decoded = decodeReplay(line);
  const recorded = decoded.violation;
  const why = decoded.version === VERSION ? NOT_DETERMINISTIC : otherVersion(decoded.version);
  let run: Run | undefined;
  let violations: readonly Violation[];
  try {
    run = await scenario.run({ replay: line });
    violations = run.violations;
  } catch (error) {
    if (!isStall(error)) throw error;
    violations = [stalled(error)];
  }
  if (recorded === undefined) {
    const reproduced = violations.length === 0;
    return {
      reproduced,
      run,
      recorded,
      found: undefined,
      message: reproduced
        ? 'reproduced: the run passed, as it did when the line was recorded'
        : `didn't reproduce: the line recorded a run that passed, and this one found ${describeAll(violations)}. ${why}`,
    };
  }
  const found = violations.find(
    (v) => v.invariant === recorded.invariant && v.message === recorded.message,
  );
  return {
    reproduced: found !== undefined,
    run,
    recorded,
    found,
    message:
      found !== undefined
        ? `reproduced: ${recorded.invariant}: ${recorded.message}`
        : `didn't reproduce: the line recorded ${recorded.invariant}: ${recorded.message}, and this run found ${describeAll(violations)}. ${why}`,
  };
}

const NOT_DETERMINISTIC =
  "A run is a pure function of its seed and plan, so something in it isn't deterministic: a " +
  'scenario that reads Date.now, Math.random or a real timer, or code that changed since the ' +
  'line was recorded.';

function otherVersion(version: string | undefined): string {
  return (
    `The line was recorded on ${version === undefined ? 'a version before 1.0' : version}, and ` +
    `this is ${VERSION}. A seed's plan and history can change between versions (decision 0039), ` +
    'so replay it on the version that recorded it.'
  );
}

function describeAll(violations: readonly Violation[]): string {
  if (violations.length === 0) return 'nothing';
  const [first] = violations;
  const rest = violations.length - 1;
  return `${String(first?.invariant)}: ${String(first?.message)}${rest > 0 ? `, and ${String(rest)} more` : ''}`;
}
