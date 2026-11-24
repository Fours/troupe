import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_DIR, SOURCES, SOURCE_FILES, loadWriteupData } from '../../demo/build/writeup-data.ts';
import {
  BASELINE_SCENARIOS,
  CLUSTER_SCENARIOS,
  EVENTS_SCENARIOS,
  NODE_LINES,
  type Stat,
} from '../../demo/src/writeup/data.ts';

// The write-up's charts are read from docs/decisions/data/ when the site builds (milestone 3,
// T8). The plugin in demo/vite.config.ts calls loadWriteupData, so anything it throws fails the
// build.

const copies: string[] = [];

/** A copy of the data directory to break. */
function copyOfData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'troupe-writeup-'));
  copies.push(dir);
  cpSync(DATA_DIR, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sane = (s: Stat) => s.min > 0 && s.min <= s.median && s.median <= s.max;

describe("the write-up's data", () => {
  it('reads every scenario on every Node line from the recorded runs', () => {
    const data = loadWriteupData();
    for (const name of BASELINE_SCENARIOS) {
      for (const line of NODE_LINES) expect(sane(data.baseline.scenarios[name][line])).toBe(true);
    }
    for (const name of EVENTS_SCENARIOS) {
      for (const line of NODE_LINES) expect(sane(data.events.scenarios[name][line])).toBe(true);
    }
    for (const name of CLUSTER_SCENARIOS) {
      for (const line of NODE_LINES) expect(sane(data.cluster.scenarios[name][line])).toBe(true);
    }
    for (const line of NODE_LINES) {
      expect(data.baseline.setup[line].node).toMatch(new RegExp(`^v${line}\\.`));
      expect(data.events.setup[line].node).toMatch(new RegExp(`^v${line}\\.`));
      expect(data.cluster.setup[line].node).toMatch(new RegExp(`^v${line}\\.`));
      const { p50, max } = data.cluster.failoverMs[line];
      expect(p50 > 0 && p50 <= max).toBe(true);
    }
  });

  it('gives the numbers the records quote', () => {
    const { baseline, events } = loadWriteupData();
    // 0019's summary.md for Node 24, and 0020's.
    expect(Math.round(baseline.scenarios['ping-pong']['24'].median)).toBe(480_679);
    expect(Math.round(baseline.scenarios['journal-postgres-100-nolock']['24'].median)).toBe(8_781);
    expect(Math.round(events.scenarios['events-messages']['24'].median)).toBe(2_621_023);
    expect(baseline.askLatencyUs['24'].p50).toBeCloseTo(0.42, 2);
    expect(baseline.askLatencyUs['24'].p99).toBeCloseTo(1.15, 2);
  });

  it('gives the cluster numbers 0031 quotes', () => {
    const { cluster } = loadWriteupData();
    // 0031's Evidence: the failover table, p50 and max in ms.
    expect(Math.round(cluster.failoverMs['22'].p50)).toBe(10_437);
    expect(Math.round(cluster.failoverMs['24'].p50)).toBe(10_648);
    expect(Math.round(cluster.failoverMs['26'].max)).toBe(11_680);
    // Its summary.md for Node 24.
    expect(Math.round(cluster.scenarios['entity-tell-remote']['24'].median)).toBe(58_542);
    expect(Math.round(cluster.scenarios['cluster-appends-postgres']['24'].median)).toBe(1_595);
    expect(cluster.remoteAskUs['24'].p50).toBeCloseTo(29.31, 2);
  });

  it('reads each recorded run from its own folder', () => {
    const data = loadWriteupData();
    for (const line of NODE_LINES) {
      expect(data.baseline.setup[line].folder).toBe(SOURCES.baseline[line]);
      expect(data.events.setup[line].folder).toBe(SOURCES.events[line]);
      expect(data.cluster.setup[line].folder).toBe(SOURCES.cluster[line]);
    }
    expect(SOURCE_FILES).toHaveLength(18);
  });

  it.each(SOURCE_FILES)('fails, naming the file, when %s is missing', (file) => {
    const dir = copyOfData();
    rmSync(join(dir, file));
    expect(() => loadWriteupData(dir)).toThrow(join(dir, file));
  });

  it('fails, naming it, when a scenario is missing', () => {
    const dir = copyOfData();
    const path = join(dir, SOURCES.events['26'], 'results.json');
    const results = JSON.parse(readFileSync(path, 'utf8')) as { scenarios: { name: string }[] };
    results.scenarios = results.scenarios.filter((s) => s.name !== 'events-messages');
    writeFileSync(path, JSON.stringify(results));
    expect(() => loadWriteupData(dir)).toThrow(`no events-messages scenario in ${path}`);
  });

  it('fails when a number is missing or not a number', () => {
    const dir = copyOfData();
    const path = join(dir, SOURCES.baseline['22'], 'results.json');
    const results = JSON.parse(readFileSync(path, 'utf8')) as {
      scenarios: { name: string; summary: { perSecond: Record<string, unknown> } }[];
    };
    const lock = results.scenarios.find((s) => s.name === 'journal-postgres-100');
    if (lock === undefined) throw new Error('the baseline has no journal-postgres-100');
    lock.summary.perSecond.median = 'fast';
    writeFileSync(path, JSON.stringify(results));
    expect(() => loadWriteupData(dir)).toThrow(/median in .*journal-postgres-100.* isn't a finite/);

    lock.summary.perSecond.median = 1;
    delete lock.summary.perSecond.max;
    writeFileSync(path, JSON.stringify(results));
    expect(() => loadWriteupData(dir)).toThrow(/no max in .*journal-postgres-100/);
  });

  it('fails, naming it, when the failover has no worst kill', () => {
    const dir = copyOfData();
    const path = join(dir, SOURCES.cluster['24'], 'results.json');
    const results = JSON.parse(readFileSync(path, 'utf8')) as {
      scenarios: { name: string; summary: Record<string, unknown> }[];
    };
    const failover = results.scenarios.find((s) => s.name === 'failover');
    if (failover === undefined) throw new Error('the cluster run has no failover');
    delete failover.summary.maxMs;
    writeFileSync(path, JSON.stringify(results));
    expect(() => loadWriteupData(dir)).toThrow(/no maxMs in .*failover/);
  });

  it('fails on a file that is not JSON', () => {
    const dir = copyOfData();
    const path = join(dir, SOURCES.baseline['24'], 'setup.json');
    writeFileSync(path, '{');
    expect(() => loadWriteupData(dir)).toThrow(`bad JSON in ${path}`);
  });

  it('fails when the data directory is missing', () => {
    expect(() => loadWriteupData(join(tmpdir(), 'troupe-no-such-dir'))).toThrow(
      "The write-up's data is missing",
    );
  });
});
