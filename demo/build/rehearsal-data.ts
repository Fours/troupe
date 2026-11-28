// Reads the /rehearsal/ page's data from docs/decisions/data/ when the site builds (milestone 5,
// T8), as writeup-data.ts reads the write-up's: each planted bug's recorded failing run, drawn here
// so the page ships the drawing and never the bug, the planted table and the hunt T7 recorded. A
// missing file or field throws, naming it, which fails the build, and so does a recorded run that
// isn't the one the planted table found: record it again with scripts/record-runs.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaultPlan, History, NetworkMode, Violation } from '@kylewillett/troupe/rehearsal';
import {
  RECORDED_PLANTS,
  type FoundBug,
  type HuntTotals,
  type PlantedRow,
  type RecordedRun,
  type RehearsalData,
} from '../src/rehearsal/data.ts';
import { draw } from '../src/rehearsal/domain/drawing.ts';

export const DATA_DIR = fileURLToPath(new URL('../../docs/decisions/data/', import.meta.url));

/** What the page reads, relative to the data directory. */
export const REHEARSAL_SOURCES = {
  runs: '0040-runs-2026-11-28',
  planted: '0043-planted-2026-11-27.json',
  hunt: '0043-hunt-2026-11-25.json',
} as const;

/** Every file the page reads, for the dev server to watch. */
export const REHEARSAL_FILES: readonly string[] = [
  ...RECORDED_PLANTS.map((plant) => `${REHEARSAL_SOURCES.runs}/${plant}.json`),
  REHEARSAL_SOURCES.planted,
  REHEARSAL_SOURCES.hunt,
];

type Json = unknown;

const problem = (message: string) => new Error(`The rehearsal page's data ${message}`);

function readJson(dir: string, file: string): Json {
  const path = join(dir, file);
  if (!existsSync(path)) throw problem(`is missing ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch (cause) {
    throw new Error(`The rehearsal page's data has bad JSON in ${path}`, { cause });
  }
}

function field(value: Json, key: string, where: string): Json {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw problem(`has no ${key} in ${where}`);
  }
  return (value as Record<string, Json>)[key];
}

function text(value: Json, key: string, where: string): string {
  const found = field(value, key, where);
  if (typeof found !== 'string') throw problem(`has ${key} in ${where} that isn't a string`);
  return found;
}

function count(value: Json, key: string, where: string): number {
  const found = field(value, key, where);
  if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 0) {
    throw problem(`has ${key} in ${where} that isn't a whole number of zero or more`);
  }
  return found;
}

function list(value: Json, key: string, where: string): Json[] {
  const found = field(value, key, where);
  if (!Array.isArray(found)) throw problem(`has ${key} in ${where} that isn't a list`);
  return found as Json[];
}

const optional = <T>(value: Json, key: string, read: () => T): T | undefined =>
  typeof value === 'object' && value !== null && key in value ? read() : undefined;

function mode(value: Json, where: string): NetworkMode {
  const m = text(value, 'mode', where);
  if (m !== 'contract' && m !== 'chaos') throw problem(`has mode ${m} in ${where}`);
  return m;
}

function plantedRows(dir: string): PlantedRow[] {
  const where = REHEARSAL_SOURCES.planted;
  const bugs = list(readJson(dir, where), 'bugs', where);
  return bugs.map((b) => {
    const at = `${where}, ${text(b, 'plant', where)}`;
    return {
      plant: text(b, 'plant', at),
      bug: text(b, 'bug', at),
      foundAtSeed: optional(b, 'foundAtSeed', () => count(b, 'foundAtSeed', at)),
      invariant: optional(b, 'invariant', () => text(b, 'invariant', at)),
      faults: optional(b, 'faults', () => count(b, 'faults', at)),
      shrunkTo: optional(b, 'shrunkTo', () => count(b, 'shrunkTo', at)),
      shrinkRuns: optional(b, 'shrinkRuns', () => count(b, 'shrinkRuns', at)),
      tolerated: optional(b, 'tolerated', () => text(b, 'tolerated', at)),
    };
  });
}

function replays(dir: string): Map<string, string> {
  const where = REHEARSAL_SOURCES.planted;
  const out = new Map<string, string>();
  for (const b of list(readJson(dir, where), 'bugs', where)) {
    const replay = optional(b, 'replay', () => text(b, 'replay', where));
    if (replay !== undefined) out.set(text(b, 'plant', where), replay);
  }
  return out;
}

function violation(value: Json, where: string): Violation {
  const v = field(value, 'violation', where);
  const until = optional(v, 'until', () => count(v, 'until', where));
  const entity = optional(v, 'entity', () => text(v, 'entity', where));
  const nodes = optional(v, 'nodes', () =>
    list(v, 'nodes', where).map((n) => {
      if (typeof n !== 'string') throw problem(`has a node in ${where} that isn't a string`);
      return n;
    }),
  );
  return {
    invariant: text(v, 'invariant', where),
    message: text(v, 'message', where),
    time: count(v, 'time', where),
    ...(until === undefined ? {} : { until }),
    ...(entity === undefined ? {} : { entity }),
    ...(nodes === undefined ? {} : { nodes }),
  };
}

function recordedRuns(dir: string): RecordedRun[] {
  const found = replays(dir);
  return RECORDED_PLANTS.map((plant) => {
    const where = `${REHEARSAL_SOURCES.runs}/${plant}.json`;
    const value = readJson(dir, where);
    if (text(value, 'plant', where) !== plant) throw problem(`in ${where} is another bug's`);
    const replay = text(value, 'replay', where);
    if (replay !== found.get(plant)) {
      throw problem(
        `in ${where} isn't the run ${REHEARSAL_SOURCES.planted} found: record it again with scripts/record-runs.ts`,
      );
    }
    const history = list(value, 'history', where) as unknown as History;
    if (history[0]?.kind !== 'run') throw problem(`in ${where} has a history with no run entry`);
    return {
      plant,
      bug: text(value, 'bug', where),
      seed: count(value, 'seed', where),
      replay,
      plan: history[0].plan,
      drawing: draw(history, violation(value, where)),
    };
  });
}

function hunt(dir: string): { found: FoundBug[]; hunt: HuntTotals } {
  const where = REHEARSAL_SOURCES.hunt;
  const value = readJson(dir, where);
  const totals = field(value, 'totals', where);
  const fenced = field(totals, 'fenced', `${where}, totals`);
  const found = list(value, 'bugs', where).map((b): FoundBug => {
    const at = `${where}, ${text(b, 'name', where)}`;
    return {
      name: text(b, 'name', at),
      what: text(b, 'what', at),
      fix: text(b, 'fix', at),
      record: optional(b, 'record', () => text(b, 'record', at)),
      mode: mode(b, at),
      seed: count(b, 'seed', at),
      invariant: text(b, 'invariant', at),
      plan: list(b, 'plan', at) as unknown as FaultPlan,
    };
  });
  return {
    found,
    hunt: {
      seeds: count(totals, 'seeds', where),
      runs: count(totals, 'runs', where),
      faults: count(totals, 'faults', where),
      ms: count(totals, 'ms', where),
      machine: text(value, 'machine', where),
      fenced: {
        refused: count(fenced, 'refused', where),
        seeds: count(fenced, 'seeds', where),
        paused: count(fenced, 'paused', where),
      },
      checkBugs: list(value, 'rehearsalBugs', where).length,
    },
  };
}

/** Reads and draws every source, or throws naming the first thing that's wrong. */
export function loadRehearsalData(dir: string = DATA_DIR): RehearsalData {
  return {
    sources: [REHEARSAL_SOURCES.runs, REHEARSAL_SOURCES.planted, REHEARSAL_SOURCES.hunt],
    planted: plantedRows(dir),
    runs: recordedRuns(dir),
    ...hunt(dir),
  };
}

/** The planted table and the hunt's totals and bugs, for the write-up. */
export function loadHuntData(dir: string = DATA_DIR): Omit<RehearsalData, 'runs' | 'sources'> {
  return { planted: plantedRows(dir), ...hunt(dir) };
}
