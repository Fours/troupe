// npm run rehearse (milestone 5, T6): festival night's scenario on a range of seeds, split across
// worker processes, against dist/ (build first). It prints a line per thousand seeds and a
// summary, and each failure shrunk, with the line that replays it.
//
//   npm run rehearse -- --seeds 1..10000              every core but one, contract mode
//   npm run rehearse -- --seeds 1..1000 --mode chaos --determinism-every 100
//   npm run rehearse -- --seeds 1..10000 --plant late-deadline
//   npm run rehearse -- --replay '<line>'
//
// Options:
//   --seeds a..b             the seeds, both included (default 1..1000)
//   --workers n              worker processes (default the number of cores less one)
//   --mode contract|chaos    the network's mode (default contract)
//   --plant <bug>            plants a bug and hunts for it: stops at the first seed whose run
//                            breaks an invariant that catches the bug and passes it without the
//                            bug, and shrinks that seed's plan the same way
//   --ignore a,b             invariants whose violations are counted but don't fail a seed
//   --determinism-every n    runs every nth seed twice and checks the histories are identical
//   --max-shrink-runs n      the most runs shrinking one failure may take (default 500)
//   --json <file>            also writes the summary there, as JSON
//   --replay <line>          runs one line, in this process, and says whether it reproduced
//
// It exits 1 if a seed fails, a seed's two runs differ, a planted bug isn't found, or a replay
// doesn't reproduce. A planted bug's seeds go to the workers in order, so the seed it reports is
// the first one in the range that finds it.
import { fork, type ChildProcess } from 'node:child_process';
import console from 'node:console';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DURATION_MS, festivalOptions } from '../demo/src/rehearsal/domain/festival.ts';
import type { Plant } from '../src/internal.ts';
import type { Violation } from '../src/rehearsal/invariants.ts';
import type { NetworkMode } from '../src/rehearsal/network.ts';
import type * as PlantsModule from '../src/rehearsal/plants.ts';
import type * as RehearseModule from '../src/rehearsal/rehearse.ts';
import type * as ReplayModule from '../src/rehearsal/replay.ts';
import type { ReplayLine } from '../src/rehearsal/replay.ts';
import type { Failure, SeedResult } from '../src/rehearsal/rehearse.ts';
import type * as ScenarioModule from '../src/rehearsal/scenario.ts';
import type { Scenario } from '../src/rehearsal/scenario.ts';

const ROOT = resolve(import.meta.dirname, '..');
// The package's internals, from dist/: planting bugs is never public API, so it isn't exported.
const internal = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(ROOT, 'dist/rehearsal', path)).href)) as T;
const { scenarioWith } = await internal<typeof ScenarioModule>('scenario.js');
const { runSeed, shrinkSeed, replay } = await internal<typeof RehearseModule>('rehearse.js');
const { PLANTED, huntOptions, isPlant, planted } = await internal<typeof PlantsModule>('plants.js');
const { decodeReplay } = await internal<typeof ReplayModule>('replay.js');

/** What the main process tells a worker. */
type ToWorker =
  | { readonly t: 'batch'; readonly from: number; readonly count: number }
  | { readonly t: 'shrink'; readonly seed: number; readonly failing: readonly Violation[] }
  | { readonly t: 'exit' };

/** What a worker answers. */
type FromWorker =
  | { readonly t: 'seed'; readonly result: SeedResult; readonly runs: number }
  | { readonly t: 'batched' }
  | { readonly t: 'shrunk'; readonly failure: Failure };

interface Settings {
  readonly from: number;
  readonly to: number;
  readonly workers: number;
  readonly mode: NetworkMode;
  readonly plant: Plant | undefined;
  readonly ignore: readonly string[];
  readonly determinismEvery: number;
  readonly maxShrinkRuns: number;
  readonly json: string | undefined;
  readonly replay: string | undefined;
}

function fail(message: string): never {
  console.error(`rehearse: ${message}`);
  process.exit(2);
}

function parse(argv: readonly string[]): Settings {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value`);
    return v;
  };
  const known = new Set([
    '--seeds',
    '--workers',
    '--mode',
    '--plant',
    '--ignore',
    '--determinism-every',
    '--max-shrink-runs',
    '--json',
    '--replay',
  ]);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg) && arg !== '--worker')
      fail(`unknown option ${arg}`);
  }
  const int = (flag: string, fallback: number, min: number): number => {
    const v = value(flag);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min)
      fail(`${flag} must be a whole number from ${String(min)}`);
    return n;
  };
  const seeds = value('--seeds') ?? '1..1000';
  const match = /^(\d+)\.\.(\d+)$/.exec(seeds);
  if (match === null) fail(`--seeds must be a..b, got ${seeds}`);
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (to < from) fail(`--seeds must run upwards, got ${seeds}`);
  const mode = value('--mode') ?? 'contract';
  if (mode !== 'contract' && mode !== 'chaos')
    fail(`--mode must be contract or chaos, got ${mode}`);
  const plant = value('--plant');
  if (plant !== undefined && !isPlant(plant)) {
    fail(`--plant must be one of ${PLANTED.map((p) => p.name).join(', ')}, got ${plant}`);
  }
  const ignore = value('--ignore');
  return {
    from,
    to,
    workers: int('--workers', Math.max(1, availableParallelism() - 1), 1),
    mode,
    plant,
    ignore: ignore === undefined ? [] : ignore.split(',').filter((name) => name !== ''),
    determinismEvery: int('--determinism-every', 0, 0),
    maxShrinkRuns: int('--max-shrink-runs', 500, 0),
    json: value('--json'),
    replay: value('--replay'),
  };
}

function scenarios(mode: NetworkMode, plant: Plant | undefined) {
  const options =
    plant === undefined ? festivalOptions(mode) : huntOptions(festivalOptions(mode), plant);
  const s: Scenario = scenarioWith(options, plant === undefined ? {} : { plant });
  const baseline = plant === undefined ? undefined : scenarioWith(options, {});
  const target = plant === undefined ? undefined : planted(plant).caughtBy;
  const internals = {
    ...(baseline === undefined ? {} : { baseline }),
    ...(target === undefined ? {} : { target }),
  };
  return { s, internals };
}

const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

// ---- a worker ----

async function worker(settings: Settings): Promise<void> {
  const { s, internals } = scenarios(settings.mode, settings.plant);
  const send = (msg: FromWorker): void => {
    process.send?.(msg);
  };
  const queue: ToWorker[] = [];
  let wake: (() => void) | undefined;
  process.on('message', (msg: ToWorker) => {
    queue.push(msg);
    wake?.();
  });
  for (;;) {
    const msg = queue.shift();
    if (msg === undefined) {
      await new Promise<void>((done) => (wake = done));
      wake = undefined;
      continue;
    }
    if (msg.t === 'exit') process.exit(0);
    if (msg.t === 'batch') {
      for (let seed = msg.from; seed < msg.from + msg.count; seed++) {
        const twice = settings.determinismEvery > 0 && seed % settings.determinismEvery === 0;
        const { result, runs } = await runSeed(
          s,
          seed,
          { ignore: settings.ignore, twice },
          internals,
        );
        send({ t: 'seed', result, runs });
      }
      send({ t: 'batched' });
    } else {
      const failure = await shrinkSeed(
        s,
        msg.seed,
        msg.failing,
        { ignore: settings.ignore, maxShrinkRuns: settings.maxShrinkRuns },
        internals,
      );
      send({ t: 'shrunk', failure });
    }
  }
}

// ---- the main process ----

interface Summary {
  readonly mode: NetworkMode;
  readonly plant: Plant | undefined;
  readonly seeds: { readonly from: number; readonly to: number };
  readonly ran: number;
  readonly runs: number;
  readonly ms: number;
  readonly runsPerSecond: number;
  readonly workers: number;
  readonly node: string;
  readonly faults: number;
  readonly failing: Record<string, number>;
  readonly expected: number;
  readonly checkedTwice: number;
  readonly nondeterministic: number[];
  readonly failures: Failure[];
}

function printFailure(failure: Failure, settings: Settings): void {
  const v = failure.shrunk.violation;
  console.log(`✗ seed ${String(failure.seed)}: ${failure.invariant}: ${v.message}`);
  console.log(
    `  shrunk from ${String(failure.plan.length)} faults to ${String(failure.shrunk.plan.length)} in ${String(failure.shrunk.runs)} runs${failure.shrunk.untilMs < DURATION_MS ? `, ending at ${thousands(failure.shrunk.untilMs)}` : ''}: ${JSON.stringify(failure.shrunk.plan)}`,
  );
  console.log(`  replay: npm run rehearse -- --replay '${failure.replay}'`);
  if (settings.plant !== undefined) console.log(`  planted: ${settings.plant}`);
}

async function main(settings: Settings): Promise<number> {
  const total = settings.to - settings.from + 1;
  const started = performance.now();
  const plantHunt = settings.plant !== undefined;
  const batch = Math.max(1, Math.min(plantHunt ? 10 : 50, Math.ceil(total / settings.workers / 4)));
  let next = settings.from;
  // In a hunt, the first seed found: no seed after it is handed out.
  let stopAt = Infinity;
  let ran = 0;
  let runs = 0;
  let faults = 0;
  let expected = 0;
  let checkedTwice = 0;
  const failing: Record<string, number> = {};
  const nondeterministic: number[] = [];
  const failed = new Map<number, readonly Violation[]>();
  let printed = 0;

  const children: ChildProcess[] = [];
  const args = ['--worker', ...process.argv.slice(2)];
  const idle: ChildProcess[] = [];
  let busy = 0;
  let finish: (() => void) | undefined;
  const handOut = (child: ChildProcess): void => {
    if (next > settings.to || next > stopAt) {
      idle.push(child);
      if (busy === 0) finish?.();
      return;
    }
    const count = Math.min(batch, settings.to - next + 1);
    child.send({ t: 'batch', from: next, count } satisfies ToWorker);
    next += count;
    busy++;
  };
  const shrinkers = new Map<ChildProcess, (failure: Failure) => void>();
  const onMessage = (child: ChildProcess, msg: FromWorker): void => {
    if (msg.t === 'seed') {
      const { result } = msg;
      if (result.seed > stopAt) return;
      ran++;
      runs += msg.runs;
      faults += result.faults;
      if (result.expected > 0) expected++;
      if (result.deterministic !== undefined) checkedTwice++;
      if (result.deterministic === false) nondeterministic.push(result.seed);
      for (const name of new Set(result.violations.map((v) => v.invariant))) {
        failing[name] = (failing[name] ?? 0) + 1;
      }
      if (result.failing.length > 0) {
        failed.set(result.seed, result.failing);
        if (plantHunt) stopAt = Math.min(stopAt, result.seed);
      }
      while (Math.floor(ran / 1000) > printed) {
        printed++;
        const seconds = (performance.now() - started) / 1000;
        console.log(
          `  ${thousands(printed * 1000)} seeds, ${thousands(runs / seconds)} runs/s, ${String(failed.size)} failing`,
        );
      }
    } else if (msg.t === 'batched') {
      busy--;
      handOut(child);
    } else {
      shrinkers.get(child)?.(msg.failure);
    }
  };
  for (let i = 0; i < Math.min(settings.workers, Math.ceil(total / batch)); i++) {
    const child = fork(import.meta.filename, args, {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (msg: FromWorker) => {
      onMessage(child, msg);
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`rehearse: a worker exited with code ${String(code)}`);
        process.exit(2);
      }
    });
    children.push(child);
  }
  await new Promise<void>((done) => {
    finish = done;
    for (const child of children) handOut(child);
  });

  // In a hunt, only the first seed found; otherwise every failing seed, across the workers.
  const toShrink = [...failed]
    .filter(([seed]) => seed <= stopAt)
    .sort(([a], [b]) => a - b)
    .slice(0, plantHunt ? 1 : undefined);
  const failures: Failure[] = [];
  const pool = [...children];
  await Promise.all(
    pool.map(async (child) => {
      for (;;) {
        const job = toShrink.shift();
        if (job === undefined) return;
        const failure = await new Promise<Failure>((done) => {
          shrinkers.set(child, done);
          child.send({ t: 'shrink', seed: job[0], failing: job[1] } satisfies ToWorker);
        });
        runs += failure.shrunk.runs;
        failures.push(failure);
      }
    }),
  );
  for (const child of children) child.send({ t: 'exit' } satisfies ToWorker);
  failures.sort((a, b) => a.seed - b.seed);

  const ms = Math.round(performance.now() - started);
  const runsPerSecond = Math.round((runs / ms) * 1000);
  const summary: Summary = {
    mode: settings.mode,
    plant: settings.plant,
    seeds: { from: settings.from, to: settings.to },
    ran,
    runs,
    ms,
    runsPerSecond,
    workers: children.length,
    node: process.version,
    faults,
    failing,
    expected,
    checkedTwice,
    nondeterministic: nondeterministic.sort((a, b) => a - b),
    failures,
  };
  console.log('');
  for (const failure of failures) printFailure(failure, settings);
  if (failures.length > 0) console.log('');
  const counts = Object.entries(failing)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name} ${String(n)}`)
    .join(', ');
  console.log(
    `${thousands(ran)} seeds in ${settings.mode} mode${settings.plant === undefined ? '' : ` with ${settings.plant} planted`}: ${thousands(runs)} runs in ${(ms / 1000).toFixed(1)} s on ${String(children.length)} workers, ${thousands(runsPerSecond)} runs/s, Node ${process.version}`,
  );
  console.log(
    `  ${thousands(faults)} faults; seeds with violations: ${counts === '' ? 'none' : counts}`,
  );
  if (settings.ignore.length > 0) console.log(`  ignored: ${settings.ignore.join(', ')}`);
  if (expected > 0)
    console.log(`  ${String(expected)} seeds with overlaps expected past the lease's margin`);
  if (checkedTwice > 0) {
    console.log(
      nondeterministic.length === 0
        ? `  ${String(checkedTwice)} seeds run twice, every history identical`
        : `  ✗ ${String(nondeterministic.length)} of ${String(checkedTwice)} seeds run twice differed: ${nondeterministic.join(', ')}`,
    );
  }
  if (settings.json !== undefined)
    writeFileSync(settings.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (plantHunt) {
    if (failures.length === 0) {
      console.log(
        `✗ ${settings.plant} wasn't found in seeds ${String(settings.from)} to ${String(settings.to)}`,
      );
      return 1;
    }
    console.log(`✓ ${settings.plant} found at seed ${String(failures[0]?.seed)}`);
    return nondeterministic.length > 0 ? 1 : 0;
  }
  return failures.length > 0 || nondeterministic.length > 0 ? 1 : 0;
}

async function replayLine(line: string): Promise<number> {
  let decoded: ReplayLine;
  try {
    decoded = decodeReplay(line);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { s } = scenarios(decoded.mode, decoded.plant);
  const result = await replay(s, line);
  console.log(
    `seed ${String(decoded.seed)} in ${decoded.mode} mode, ${String(decoded.plan.length)} faults${decoded.plant === undefined ? '' : `, ${decoded.plant} planted`}: ${JSON.stringify(decoded.plan)}`,
  );
  console.log(`${result.reproduced ? '✓' : '✗'} ${result.message}`);
  return result.reproduced ? 0 : 1;
}

const settings = parse(process.argv.slice(2));
if (process.argv.includes('--worker')) {
  await worker(settings);
} else if (settings.replay !== undefined) {
  process.exitCode = await replayLine(settings.replay);
} else {
  process.exitCode = await main(settings);
}
