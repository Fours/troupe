import { describe, expect, it } from 'vitest';
import {
  compare,
  comparisonTable,
  parseArgs,
  runResult,
  summarise,
  table,
  type Results,
} from '../../bench/report.ts';

const meta = { name: 'ping-pong', group: 'Ping-pong', unit: 'msg/s', size: { messages: 1000 } };

describe('runResult', () => {
  it('gives throughput, and percentiles only when latencies were timed', () => {
    expect(runResult({ ops: 1000, ms: 500 })).toEqual({ ops: 1000, ms: 500, perSecond: 2000 });
    expect(runResult({ ops: 4, ms: 2, latenciesMs: [0.4, 0.1, 0.3, 0.2] })).toEqual({
      ops: 4,
      ms: 2,
      perSecond: 2000,
      p50Ms: 0.2,
      p99Ms: 0.4,
      maxMs: 0.4,
    });
  });
});

describe('summarise', () => {
  it('takes each metric over every run, separately, not the first run', () => {
    const r = summarise(meta, [
      { ops: 1000, ms: 1000, latenciesMs: [5] },
      { ops: 1000, ms: 500, latenciesMs: [1] },
      { ops: 1000, ms: 250, latenciesMs: [3] },
    ]);
    expect(r.runs.map((run) => run.perSecond)).toEqual([1000, 2000, 4000]);
    expect(r.summary.perSecond).toEqual({ median: 2000, min: 1000, max: 4000, spreadPct: 150 });
    // The p50 median is 3 though the median-throughput run had 1: each metric stands alone.
    expect(r.summary.p50Ms?.median).toBe(3);
  });

  it('leaves out percentiles when the runs timed no latencies', () => {
    const r = summarise(meta, [{ ops: 10, ms: 1 }]);
    expect(r.summary).not.toHaveProperty('p50Ms');
    expect(r.summary).not.toHaveProperty('p99Ms');
  });

  it('refuses no runs', () => {
    expect(() => summarise(meta, [])).toThrow(RangeError);
  });
});

describe('table', () => {
  it('prints one row per scenario with its median, range and spread', () => {
    const results: Results = {
      scenarios: [
        summarise(meta, [
          { ops: 1000, ms: 1000 },
          { ops: 1000, ms: 800 },
        ]),
      ],
    };
    expect(table(results).split('\n')[2]).toBe(
      '| ping-pong | messages 1,000 | 2 | 1,125 msg/s | 1,000 | 1,250 | 22.2% |  |  |  |',
    );
  });

  it('prints latencies under a millisecond in µs', () => {
    const results: Results = {
      scenarios: [
        summarise({ ...meta, name: 'ask' }, [{ ops: 2, ms: 1, latenciesMs: [0.0005, 0.0012] }]),
      ],
    };
    expect(table(results).split('\n')[2]).toMatch(
      /\| 0\.5 µs \(0\.5–0\.5\) \| 1\.2 µs \(1\.2–1\.2\) \| 1\.2 µs \(1\.2–1\.2\) \|$/,
    );
  });

  it('prints a latency row’s times in ms, and no throughput', () => {
    const results: Results = {
      scenarios: [
        summarise({ ...meta, name: 'failover', kind: 'latency', size: { kills: 3 } }, [
          { ops: 3, ms: 60_000, latenciesMs: [9_000.4, 11_000, 12_500] },
        ]),
      ],
    };
    expect(table(results).split('\n')[2]).toBe(
      '| failover | kills 3 | 1 | — | — | — | — | 11,000 ms (11,000–11,000) | ' +
        '12,500 ms (12,500–12,500) | 12,500 ms (12,500–12,500) |',
    );
  });
});

describe('compare', () => {
  const recorded: Results = {
    scenarios: [
      summarise(meta, [
        { ops: 1000, ms: 1000 },
        { ops: 1000, ms: 900 },
        { ops: 1000, ms: 800 },
      ]),
      summarise({ ...meta, name: 'ask' }, [{ ops: 10, ms: 1 }]),
    ],
  };

  it('checks each fresh median against the recorded range', () => {
    const inside = compare(recorded, {
      scenarios: [summarise(meta, [{ ops: 1000, ms: 850 }])],
    });
    expect(inside).toHaveLength(1);
    expect(inside[0]?.within).toBe(true);
    const outside = compare(recorded, {
      scenarios: [summarise(meta, [{ ops: 1000, ms: 1100 }])],
    });
    expect(outside[0]?.within).toBe(false);
    expect(outside[0]?.changePct).toBeLessThan(0);
  });

  it('skips scenarios only one side ran, and runs of another size', () => {
    expect(
      compare(recorded, {
        scenarios: [
          summarise({ ...meta, name: 'fan-out' }, [{ ops: 1, ms: 1 }]),
          summarise({ ...meta, size: { messages: 5 } }, [{ ops: 1, ms: 1 }]),
        ],
      }),
    ).toEqual([]);
  });

  it('compares a latency row by its p50', () => {
    const latency = { ...meta, name: 'handoff', kind: 'latency' as const, size: { shards: 64 } };
    const rows = compare(
      {
        scenarios: [
          summarise(
            latency,
            [1_000, 1_200, 1_400].map((l) => ({ ops: 20, ms: l, latenciesMs: [l] })),
          ),
        ],
      },
      { scenarios: [summarise(latency, [{ ops: 20, ms: 1_500, latenciesMs: [1_500] }])] },
    );
    expect(rows).toEqual([
      {
        name: 'handoff',
        recorded: { median: 1_200, min: 1_000, max: 1_400, spreadPct: (400 / 1_200) * 100 },
        fresh: 1_500,
        changePct: 25,
        within: false,
      },
    ]);
  });

  it('prints a row per comparison', () => {
    const rows = compare(recorded, { scenarios: [summarise(meta, [{ ops: 1000, ms: 1000 }])] });
    expect(comparisonTable(rows).split('\n')[2]).toBe(
      '| ping-pong | 1,111 | 1,000–1,250 | 1,000 | -10% | yes |',
    );
  });
});

describe('parseArgs', () => {
  it('defaults to 10 runs after 3 warm-ups', () => {
    expect(parseArgs([])).toEqual({ quick: false, only: [], runs: 10, warmup: 3 });
  });

  it('runs once with no warm-up for --quick', () => {
    expect(parseArgs(['--quick'])).toEqual({ quick: true, only: [], runs: 1, warmup: 0 });
  });

  it('reads every option', () => {
    expect(
      parseArgs([
        '--only',
        'ping,journal-sqlite',
        '--runs',
        '3',
        '--warmup',
        '0',
        '--out',
        'x',
        '--compare',
        'y',
      ]),
    ).toEqual({
      quick: false,
      only: ['ping', 'journal-sqlite'],
      runs: 3,
      warmup: 0,
      out: 'x',
      compare: 'y',
    });
  });

  it('refuses unknown options, missing values and bad counts', () => {
    expect(() => parseArgs(['--fast'])).toThrow(TypeError);
    expect(() => parseArgs(['--out'])).toThrow(TypeError);
    expect(() => parseArgs(['--out', '--quick'])).toThrow(TypeError);
    expect(() => parseArgs(['--runs', '0'])).toThrow(TypeError);
    expect(() => parseArgs(['--runs', '1.5'])).toThrow(TypeError);
    expect(() => parseArgs(['--warmup', '-1'])).toThrow(TypeError);
  });
});
