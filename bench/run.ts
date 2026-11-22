// The benchmark (decision 0019): `npm run bench`. Runs against dist/, through the package's own
// name, so build first. Prints each scenario's median and spread, and writes a results folder.
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
import { commandLine, ROOT, setup } from './setup.ts';

/** The compose database from docker-compose.test.yml, as the integration tests use it. */
const DEFAULT_POSTGRES_URL = 'postgres://troupe:troupe@localhost:5440/troupe';
/** pg's own default, written down so the record says what the Postgres rows ran with. */
const POOL_MAX = 10;

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const command = commandLine(argv, process.env, process.execArgv);

const tmpDir = join(ROOT, '.troupe', 'bench');
mkdirSync(tmpDir, { recursive: true });
const postgresUrl = process.env['TROUPE_POSTGRES_URL'] || DEFAULT_POSTGRES_URL;
let pool: pg.Pool | undefined;
const env = {
  tmpDir,
  pool: () => (pool ??= new pg.Pool({ connectionString: postgresUrl, max: POOL_MAX })),
};

const selected = scenarios(env).filter(
  (s) =>
    (!args.quick || s.quick !== undefined) &&
    (args.only.length === 0 || args.only.some((prefix) => s.name.startsWith(prefix))),
);
if (selected.length === 0) throw new Error(`no scenario matches --only ${args.only.join(',')}`);

// With --expose-gc (npm run bench passes it), each run starts after a full collection, so one
// run's garbage isn't collected on the next one's time.
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined)
  console.warn('Running without --expose-gc: runs may pay for earlier garbage.');

const usesPostgres = selected.some((s) => s.name.startsWith('journal-postgres'));
let postgresVersion: string | undefined;
if (usesPostgres) {
  try {
    const { rows } = await env.pool().query<{ server_version: string }>('SHOW server_version');
    postgresVersion = rows[0]?.server_version;
  } catch (error) {
    throw new Error(
      `The Postgres rows need a database: npm run postgres:up, or set TROUPE_POSTGRES_URL, or ` +
        `leave them out with --only. Cause: ${String(error)}`,
      { cause: error },
    );
  }
}

const results: ScenarioResult[] = [];
try {
  for (const scenario of selected) {
    const size = args.quick ? (scenario.quick ?? scenario.full) : scenario.full;
    const samples: Sample[] = [];
    for (let i = 0; i < args.warmup + args.runs; i++) {
      gc?.();
      const sample = await scenario.run(size);
      if (i >= args.warmup) samples.push(sample);
    }
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
} finally {
  await pool?.end();
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
      `(src/ at ${record.git.srcCommit.slice(0, 7)}). Medians of ${String(args.runs)} runs after ` +
      `${String(args.warmup)} warm-up, with the lowest and highest run. Spread is (max − min) / median.\n\n` +
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
