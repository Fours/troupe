// Reads the write-up's chart data from docs/decisions/data/ when the site builds, so the charts
// can't drift from the numbers the decision records quote (milestone 3, T8). It reads each
// recorded run's results.json, the benchmark's own output, and its setup.json. A missing folder,
// file, scenario or number throws, naming it, which fails the build.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_SCENARIOS,
  EVENTS_SCENARIOS,
  NODE_LINES,
  type NodeLine,
  type Recorded,
  type Setup,
  type Stat,
  type WriteupData,
} from '../src/writeup/data.ts';

export const DATA_DIR = fileURLToPath(new URL('../../docs/decisions/data/', import.meta.url));

/** Every recorded run the write-up reads, by Node line: folders in the data directory. */
export const SOURCES = {
  baseline: {
    '22': '0019-baseline-node22-2026-11-22',
    '24': '0019-baseline-node24-2026-11-22',
    '26': '0019-baseline-node26-2026-11-22',
  },
  events: {
    '22': '0020-message-events-node22-2026-11-22',
    '24': '0020-message-events-node24-2026-11-22',
    '26': '0020-message-events-node26-2026-11-22',
  },
} as const satisfies Record<string, Record<NodeLine, string>>;

/** Every file the write-up reads, relative to the data directory, for the dev server to watch. */
export const SOURCE_FILES: readonly string[] = Object.values(SOURCES).flatMap((byLine) =>
  Object.values(byLine).flatMap((folder) => [`${folder}/results.json`, `${folder}/setup.json`]),
);

type Json = unknown;

class Reader {
  constructor(private readonly dir: string) {}

  json(file: string): { path: string; value: Json } {
    const path = join(this.dir, file);
    if (!existsSync(path)) throw new Error(`The write-up's data is missing ${path}`);
    try {
      return { path, value: JSON.parse(readFileSync(path, 'utf8')) as Json };
    } catch (cause) {
      throw new Error(`The write-up's data has bad JSON in ${path}`, { cause });
    }
  }
}

function field(value: Json, key: string, where: string): Json {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw new Error(`The write-up's data has no ${key} in ${where}`);
  }
  return (value as Record<string, Json>)[key];
}

function text(value: Json, path: readonly string[], where: string): string {
  const found = path.reduce((v, key) => field(v, key, where), value);
  if (typeof found !== 'string') throw new Error(`${path.join('.')} in ${where} isn't a string`);
  return found;
}

function number(value: Json, key: string, where: string): number {
  const found = field(value, key, where);
  if (typeof found !== 'number' || !Number.isFinite(found) || found < 0) {
    throw new Error(`${key} in ${where} isn't a finite number of zero or more`);
  }
  return found;
}

function stat(summary: Json, key: string, where: string): Stat {
  const s = field(summary, key, where);
  const at = `${where}, ${key}`;
  return { median: number(s, 'median', at), min: number(s, 'min', at), max: number(s, 'max', at) };
}

/** The scenarios of one results.json, by name, each with its `summary`. */
function scenarios(read: Reader, folder: string): { path: string; byName: Map<string, Json> } {
  const { path, value } = read.json(`${folder}/results.json`);
  const list = field(value, 'scenarios', path);
  if (!Array.isArray(list)) throw new Error(`scenarios in ${path} isn't a list`);
  const byName = new Map<string, Json>();
  for (const s of list as Json[]) byName.set(text(s, ['name'], path), s);
  return { path, byName };
}

function scenario(found: { path: string; byName: Map<string, Json> }, name: string) {
  const s = found.byName.get(name);
  if (s === undefined)
    throw new Error(`The write-up's data has no ${name} scenario in ${found.path}`);
  return {
    summary: field(s, 'summary', `${found.path}, ${name}`),
    where: `${found.path}, ${name}`,
  };
}

function setup(read: Reader, folder: string): Setup {
  const { path, value } = read.json(`${folder}/setup.json`);
  return {
    folder,
    node: text(value, ['versions', 'node'], path),
    cpu: text(value, ['host', 'cpu'], path),
    command: text(value, ['command'], path),
    commit: text(value, ['git', 'commit'], path),
  };
}

function recorded<S extends string>(
  read: Reader,
  folders: Record<NodeLine, string>,
  names: readonly S[],
): Recorded<S> {
  const runs = perLine((line) => scenarios(read, folders[line]));
  return {
    setup: perLine((line) => setup(read, folders[line])),
    scenarios: Object.fromEntries(
      names.map((name) => [
        name,
        perLine((line) => {
          const { summary, where } = scenario(runs[line], name);
          return stat(summary, 'perSecond', where);
        }),
      ]),
    ) as Record<S, Record<NodeLine, Stat>>,
  };
}

function perLine<T>(f: (line: NodeLine) => T): Record<NodeLine, T> {
  return Object.fromEntries(NODE_LINES.map((line) => [line, f(line)])) as Record<NodeLine, T>;
}

/** Reads every source, or throws naming the first thing that's missing. */
export function loadWriteupData(dir: string = DATA_DIR): WriteupData {
  const read = new Reader(dir);
  const baseline = recorded(read, SOURCES.baseline, BASELINE_SCENARIOS);
  const askLatencyUs = perLine((line) => {
    const { summary, where } = scenario(scenarios(read, SOURCES.baseline[line]), 'ask');
    // results.json keeps milliseconds; an ask takes well under one, so the page shows µs.
    const us = (key: string) => stat(summary, key, where).median * 1000;
    return { p50: us('p50Ms'), p99: us('p99Ms') };
  });
  return {
    baseline: { ...baseline, askLatencyUs },
    events: recorded(read, SOURCES.events, EVENTS_SCENARIOS),
  };
}
