// One timed run of one scenario, in a fresh process: `bench/run.ts` starts one of these per run
// (decision 0019). It warms up in-process, times one run, and prints the sample as JSON on stdout.
//
//   node --expose-gc bench/child.ts <scenario> <warm-ups> <full|quick>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { scenarios, type Sample } from './scenarios.ts';
import { POOL_MAX, postgresUrl, ROOT } from './setup.ts';

const [name, warmupText, mode] = process.argv.slice(2);
const warmup = Number(warmupText);
if (name === undefined || !Number.isSafeInteger(warmup) || warmup < 0) {
  throw new TypeError('usage: bench/child.ts <scenario> <warm-ups> <full|quick>');
}
if (mode !== 'full' && mode !== 'quick') throw new TypeError(`mode must be full or quick`);

const tmpDir = join(ROOT, '.troupe', 'bench');
mkdirSync(tmpDir, { recursive: true });
let pool: pg.Pool | undefined;
const deferred: (() => Promise<void>)[] = [];
const env = {
  tmpDir,
  defer: (task: () => Promise<void>) => {
    deferred.push(task);
  },
  pool: () =>
    (pool ??= new pg.Pool({
      connectionString: postgresUrl(process.env),
      max: POOL_MAX,
    })),
};

const scenario = scenarios(env).find((s) => s.name === name);
if (scenario === undefined) throw new Error(`no scenario named ${name}`);
const size = mode === 'quick' ? (scenario.quick ?? scenario.full) : scenario.full;

// With --expose-gc, each run starts after a full collection, so it doesn't pay for the
// previous run's garbage.
const gc = (globalThis as { gc?: () => void }).gc;
let sample: Sample | undefined;
try {
  for (let i = 0; i <= warmup; i++) {
    gc?.();
    sample = await scenario.run(size);
  }
} finally {
  // Last in, first out: what a scenario started after the schema goes before the schema does.
  for (const task of deferred.reverse()) await task();
  await pool?.end();
}
process.stdout.write(`${JSON.stringify(sample)}\n`);
