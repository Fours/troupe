// The benchmark (decision 0019): `npm run bench`. Runs against dist/, through the package's own
// name, so build first. Each timed run is a fresh process (bench/child.ts), so the spread
// includes how much V8's optimisation varies between processes, and no scenario's type feedback
// leaks into another's. Prints each scenario's median and spread, and writes a results folder.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import {
  compare,
  comparisonTable,
  parseArgs,
  summarise,
  table,
  type Results,
  type ScenarioResult,
} from './report.ts';
import { scenarios, type Sample } from './scenarios.ts';
import { commandLine, POOL_MAX, postgresUrl, ROOT, setup } from './setup.ts';

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const command = commandLine(argv, process.env, process.execArgv);

// The parent only lists scenarios and starts children, so it never needs a pool or a directory.
const noEnv = {
  tmpDir: '',
  pool: (): pg.Pool => {
    throw new Error('the parent process opens no pool');
  },
};
const selected = scenarios(noEnv).filter(
  (s) =>
    (!args.quick || s.quick !== undefined) &&
    (args.only.length === 0 || args.only.some((prefix) => s.name.startsWith(prefix))),
);
if (selected.length === 0) throw new Error(`no scenario matches --only ${args.only.join(',')}`);

if (!process.execArgv.includes('--expose-gc')) {
  console.warn("Running without --expose-gc: runs may pay for their warm-ups' garbage.");
}

let postgresVersion: string | undefined;
if (selected.some((s) => s.name.startsWith('journal-postgres'))) {
  const pool = new pg.Pool({ connectionString: postgresUrl(process.env), max: 1 });
  try {
    const { rows } = await pool.query<{ server_version: string }>('SHOW server_version');
    postgresVersion = rows[0]?.server_version;
  } catch (error) {
    throw new Error(
      `The Postgres rows need a database: npm run postgres:up, or set TROUPE_POSTGRES_URL, or ` +
        `leave them out with --only. Cause: ${String(error)}`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}

/** One timed run, in its own process. Its stderr goes to the terminal. */
function runChild(name: string): Sample {
  const stdout = execFileSync(
    process.execPath,
    [
      ...process.execArgv,
      join(ROOT, 'bench', 'child.ts'),
      name,
      String(args.warmup),
      args.quick ? 'quick' : 'full',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      // An ask run's latencies are 100,000 numbers.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Sample;
}

const results: ScenarioResult[] = [];
for (const scenario of selected) {
  const size = args.quick ? (scenario.quick ?? scenario.full) : scenario.full;
  const samples: Sample[] = [];
  for (let i = 0; i < args.runs; i++) samples.push(runChild(scenario.name));
  const result = summarise(
    { name: scenario.name, group: scenario.group, unit: scenario.unit, size },
    samples,
  );
  results.push(result);
  const s = result.summary.perSecond;
  console.error(
    `${scenario.name}: ${Math.round(s.median).toLocaleString('en-US')} ${scenario.unit} ` +
      `(spread ${s.spreadPct.toFixed(1)}%)`,
  );
}

const all: Results = { scenarios: results };
console.log(`\n${table(all)}\n`);

if (args.compare !== undefined) {
  const recorded = JSON.parse(
    readFileSync(join(resolve(args.compare), 'results.json'), 'utf8'),
  ) as Results;
  console.log(`Against ${args.compare}:\n\n${comparisonTable(compare(recorded, all))}\n`);
}

// Quick runs only check that every scenario works, and CI's numbers are never kept.
const out = args.out ?? (args.quick ? undefined : join('bench', 'results', stamp()));
if (out !== undefined) {
  const dir = resolve(ROOT, out);
  mkdirSync(dir, { recursive: true });
  const config = { runs: args.runs, warmup: args.warmup, quick: args.quick, pgPoolMax: POOL_MAX };
  const record = setup({
    command,
    config,
    ...(postgresVersion === undefined ? {} : { postgres: postgresVersion }),
  });
  writeFileSync(join(dir, 'setup.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(all, null, 2)}\n`);
  writeFileSync(
    join(dir, 'summary.md'),
    `# Benchmark: ${record.versions.node}\n\n` +
      `\`${command}\` on ${record.host.cpu}, commit ${record.git.commit.slice(0, 7)} ` +
      `(src/ at ${record.git.srcCommit.slice(0, 7)}). Medians of ${String(args.runs)} runs, each in a fresh ` +
      `process after ${String(args.warmup)} warm-ups there, with the lowest and highest run. Spread is (max − min) / median.\n\n` +
      `${table(all)}\n`,
  );
  console.error(`Results in ${out}`);
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z');
}
