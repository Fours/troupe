// Turns samples into results, tables and comparisons. Pure, so tests pin it (decision 0019).
import type { Sample, Size } from './scenarios.ts';
import { percentile, perSecond, spread, within, type Spread } from './stats.ts';

/** One timed run, as `results.json` keeps it. */
export interface RunResult {
  readonly ops: number;
  readonly ms: number;
  readonly perSecond: number;
  readonly p50Ms?: number;
  readonly p99Ms?: number;
  readonly maxMs?: number;
}

/** One scenario's results. */
export interface ScenarioResult {
  readonly name: string;
  readonly group: string;
  readonly unit: string;
  /**
   * `latency` for a row whose number is how long something took, such as a failover, not how
   * many a second: its throughput is meaningless, and it's compared by its p50.
   */
  readonly kind?: 'latency';
  readonly size: Size;
  readonly runs: readonly RunResult[];
  readonly summary: {
    readonly perSecond: Spread;
    readonly p50Ms?: Spread;
    readonly p99Ms?: Spread;
    readonly maxMs?: Spread;
  };
}

/** What `results.json` holds. */
export interface Results {
  readonly scenarios: readonly ScenarioResult[];
}

/** One run's throughput, and its latency percentiles when it timed each operation. */
export function runResult(sample: Sample): RunResult {
  const base = { ops: sample.ops, ms: sample.ms, perSecond: perSecond(sample.ops, sample.ms) };
  const lat = sample.latenciesMs;
  if (lat === undefined || lat.length === 0) return base;
  return {
    ...base,
    p50Ms: percentile(lat, 50),
    p99Ms: percentile(lat, 99),
    maxMs: percentile(lat, 100),
  };
}

/** A scenario's runs and their summary. Each metric's median is taken on its own. */
export function summarise(
  meta: Pick<ScenarioResult, 'name' | 'group' | 'unit' | 'size' | 'kind'>,
  samples: readonly Sample[],
): ScenarioResult {
  if (samples.length === 0) throw new RangeError(`${meta.name}: no runs`);
  const runs = samples.map(runResult);
  const metric = (pick: (r: RunResult) => number | undefined): Spread | undefined => {
    const values = runs.map(pick).filter((v): v is number => v !== undefined);
    return values.length === runs.length ? spread(values) : undefined;
  };
  const p50Ms = metric((r) => r.p50Ms);
  const p99Ms = metric((r) => r.p99Ms);
  const maxMs = metric((r) => r.maxMs);
  return {
    ...meta,
    runs,
    summary: {
      perSecond: spread(runs.map((r) => r.perSecond)),
      ...(p50Ms === undefined ? {} : { p50Ms }),
      ...(p99Ms === undefined ? {} : { p99Ms }),
      ...(maxMs === undefined ? {} : { maxMs }),
    },
  };
}

/** A number with thousands separators and at most `digits` decimals. */
export function fmt(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function sizeText(size: Size): string {
  return Object.entries(size)
    .map(([k, v]) => `${k} ${fmt(v)}`)
    .join(', ');
}

/**
 * A latency spread, with its unit: µs below a millisecond, since an in-process ask takes about
 * one, which ms would round away, and ms from there, since a failover takes seconds.
 */
function latency(s: Spread | undefined): string {
  if (s === undefined) return '';
  const [scale, unit, digits] = s.median < 1 ? [1000, 'µs', 2] : [1, 'ms', 0];
  const n = (ms: number) => fmt(ms * scale, digits);
  return `${n(s.median)} ${unit} (${n(s.min)}–${n(s.max)})`;
}

/** The results as a Markdown table: one row per scenario, medians with their range. */
export function table(results: Results): string {
  const lines = [
    '| Scenario | Size | Runs | Median | Min | Max | Spread | p50 | p99 | max |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results.scenarios) {
    const s = r.summary.perSecond;
    const throughput =
      r.kind === 'latency'
        ? '— | — | — | —'
        : `${fmt(s.median)} ${r.unit} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.spreadPct, 1)}%`;
    lines.push(
      `| ${r.name} | ${sizeText(r.size)} | ${String(r.runs.length)} | ${throughput} | ` +
        `${latency(r.summary.p50Ms)} | ${latency(r.summary.p99Ms)} | ${latency(r.summary.maxMs)} |`,
    );
  }
  return lines.join('\n');
}

/** One scenario of a fresh run set against a recorded one. */
export interface Comparison {
  readonly name: string;
  readonly recorded: Spread;
  readonly fresh: number;
  /** The fresh median as a percentage change from the recorded median. */
  readonly changePct: number;
  /** Whether the fresh median falls inside the recorded min to max. */
  readonly within: boolean;
}

/**
 * Compares each fresh median with the recorded runs of the same scenario. Scenarios that only
 * one side ran are left out, and so are runs of a different size, which aren't comparable.
 */
export function compare(recorded: Results, fresh: Results): Comparison[] {
  const byName = new Map(recorded.scenarios.map((r) => [r.name, r]));
  const out: Comparison[] = [];
  for (const f of fresh.scenarios) {
    const r = byName.get(f.name);
    if (r === undefined || sizeText(r.size) !== sizeText(f.size)) continue;
    // A latency row compares its p50: there, lower is better, and the change says so by its sign.
    const pick = (x: ScenarioResult) =>
      x.kind === 'latency' ? x.summary.p50Ms : x.summary.perSecond;
    const fresh = pick(f);
    const rec = pick(r);
    if (fresh === undefined || rec === undefined) continue;
    const m = fresh.median;
    out.push({
      name: f.name,
      recorded: rec,
      fresh: m,
      changePct: ((m - rec.median) / rec.median) * 100,
      within: within(m, rec),
    });
  }
  return out;
}

/** A comparison as a Markdown table. */
export function comparisonTable(rows: readonly Comparison[]): string {
  const lines = [
    '| Scenario | Recorded median | Recorded range | New median | Change | Within range |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const c of rows) {
    const sign = c.changePct >= 0 ? '+' : '';
    lines.push(
      `| ${c.name} | ${fmt(c.recorded.median)} | ${fmt(c.recorded.min)}–${fmt(c.recorded.max)} | ` +
        `${fmt(c.fresh)} | ${sign}${fmt(c.changePct, 1)}% | ${c.within ? 'yes' : 'no'} |`,
    );
  }
  return lines.join('\n');
}

/** The command-line options. */
export interface Args {
  readonly quick: boolean;
  /** Name prefixes to run; empty runs everything. */
  readonly only: readonly string[];
  readonly runs: number;
  readonly warmup: number;
  readonly out?: string;
  readonly compare?: string;
}

/** Parses `npm run bench -- [--quick] [--only a,b] [--runs n] [--warmup n] [--out dir] [--compare dir]`. */
export function parseArgs(argv: readonly string[]): Args {
  let quick = false;
  let only: string[] = [];
  let runs: number | undefined;
  let warmup: number | undefined;
  let out: string | undefined;
  let compareDir: string | undefined;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new TypeError(`${flag} needs a value`);
    return v;
  };
  const count = (i: number, flag: string, min: number): number => {
    const n = Number(value(i, flag));
    if (!Number.isSafeInteger(n) || n < min) {
      throw new TypeError(`${flag} must be an integer of at least ${String(min)}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--quick':
        quick = true;
        break;
      case '--only':
        only = value(i, flag).split(',').filter(Boolean);
        i++;
        break;
      case '--runs':
        runs = count(i, flag, 1);
        i++;
        break;
      case '--warmup':
        warmup = count(i, flag, 0);
        i++;
        break;
      case '--out':
        out = value(i, flag);
        i++;
        break;
      case '--compare':
        compareDir = value(i, flag);
        i++;
        break;
      default:
        throw new TypeError(`unknown option ${String(flag)}`);
    }
  }
  return {
    quick,
    only,
    // A quick run checks that each scenario works, so one run with no warm-up is enough. Each
    // full run's process warms up three times: after one, the in-memory journal was still
    // speeding up (decision 0019).
    runs: runs ?? (quick ? 1 : 10),
    warmup: warmup ?? (quick ? 0 : 3),
    ...(out === undefined ? {} : { out }),
    ...(compareDir === undefined ? {} : { compare: compareDir }),
  };
}
