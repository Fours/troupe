import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DATA_DIR,
  REHEARSAL_FILES,
  REHEARSAL_SOURCES,
  loadRehearsalData,
} from '../../demo/build/rehearsal-data.ts';
import { RECORDED_PLANTS } from '../../demo/src/rehearsal/data.ts';
import { HUNTS } from '../rehearsal/planted.ts';

// Milestone 5, T8: the /rehearsal/ page's recorded runs are read from docs/decisions/data/ when the
// site builds, and drawn there. The plugin in demo/vite.config.ts calls loadRehearsalData, so
// anything it throws fails the build.

const copies: string[] = [];

function copyOfData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'troupe-rehearsal-'));
  copies.push(dir);
  cpSync(DATA_DIR, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the rehearsal page's data", () => {
  const data = loadRehearsalData();

  it('draws a failing run for every planted bug the hunt found', () => {
    expect(data.runs.map((r) => r.plant)).toEqual([...RECORDED_PLANTS]);
    const found = data.planted.filter((p) => p.foundAtSeed !== undefined).map((p) => p.plant);
    expect([...RECORDED_PLANTS].sort()).toEqual(found.sort());
  });

  it('records the runs test/rehearsal/planted.ts replays, each marked where it broke', () => {
    for (const run of data.runs) {
      const hunt = HUNTS.find((h) => h.plant === run.plant);
      expect(run.replay, run.plant).toBe(hunt?.line);
      expect(run.seed).toBe(hunt?.seed);
      const { mark } = run.drawing;
      expect(mark?.invariant, run.plant).toBe(hunt?.invariant);
      expect(mark?.time).toBeLessThanOrEqual(run.drawing.endMs);
      expect(
        run.drawing.log.some((l) => l.tone === 'broke'),
        run.plant,
      ).toBe(true);
    }
  });

  it('marks the two instances of a show that ran twice', () => {
    for (const plant of ['late-deadline', 'early-release', 'grants-held'] as const) {
      const run = data.runs.find((r) => r.plant === plant);
      const marked = run?.drawing.bars.filter((b) => b.marked) ?? [];
      expect(new Set(marked.map((b) => b.node)).size, plant).toBe(2);
      expect(new Set(marked.map((b) => b.show)).size, plant).toBe(1);
    }
  });

  it('keeps the planted table, the bugs the hunt found and its totals', () => {
    expect(data.planted).toHaveLength(7);
    expect(data.found).toHaveLength(20);
    expect(data.found[0]?.name).toBe('split brain');
    expect(data.hunt.seeds).toBe(1_000_000);
  });

  it('ships drawings small enough for a page', () => {
    // Every drawing together, as the build inlines them.
    expect(JSON.stringify(data).length).toBeLessThan(100_000);
  });

  it.each(REHEARSAL_FILES)('fails, naming the file, when %s is missing', (file) => {
    const dir = copyOfData();
    rmSync(join(dir, file));
    expect(() => loadRehearsalData(dir)).toThrow(join(dir, file));
  });

  it("fails when a recorded run isn't the one the planted table found", () => {
    const dir = copyOfData();
    const path = join(dir, REHEARSAL_SOURCES.runs, 'early-release.json');
    const run = JSON.parse(readFileSync(path, 'utf8')) as { replay: string };
    run.replay = 'stale';
    writeFileSync(path, JSON.stringify(run));
    expect(() => loadRehearsalData(dir)).toThrow(/record it again with scripts\/record-runs\.ts/);
  });

  it('fails, naming it, when a field is missing', () => {
    const dir = copyOfData();
    const path = join(dir, REHEARSAL_SOURCES.runs, 'grants-held.json');
    const run = JSON.parse(readFileSync(path, 'utf8')) as { violation: { time?: number } };
    delete run.violation.time;
    writeFileSync(path, JSON.stringify(run));
    expect(() => loadRehearsalData(dir)).toThrow(/no time in .*grants-held\.json/);
  });

  it('fails on a history with no run entry', () => {
    const dir = copyOfData();
    const path = join(dir, REHEARSAL_SOURCES.runs, 'grants-held.json');
    const run = JSON.parse(readFileSync(path, 'utf8')) as { history: unknown[] };
    run.history.shift();
    writeFileSync(path, JSON.stringify(run));
    expect(() => loadRehearsalData(dir)).toThrow(/no run entry/);
  });

  it('fails on a file that is not JSON', () => {
    const dir = copyOfData();
    const path = join(dir, REHEARSAL_SOURCES.hunt);
    writeFileSync(path, '{');
    expect(() => loadRehearsalData(dir)).toThrow(`bad JSON in ${path}`);
  });
});
