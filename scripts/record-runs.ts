// Records each planted bug's failing run for the site's /rehearsal/ page (milestone 5, T8): it
// replays the line test/rehearsal/planted.ts has for each bug, with the bug planted, checks the
// run breaks the invariant the line recorded, and writes its history to
// docs/decisions/data/0040-runs-<date>/<bug>.json, trimmed to what the page draws. The site's build
// reads them (demo/build/rehearsal-data.ts), so the page draws a bug without shipping it. Run by
// Node with type stripping, against dist/ (build first):
//
//   npm run build && node scripts/record-runs.ts
//
// Record again whenever planted.ts's lines are recorded again.
import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { trim } from '../demo/src/rehearsal/domain/drawing.ts';
import { festivalOptions } from '../demo/src/rehearsal/domain/festival.ts';
import type * as PlantsModule from '../src/rehearsal/plants.ts';
import type * as RehearseModule from '../src/rehearsal/rehearse.ts';
import type * as ReplayModule from '../src/rehearsal/replay.ts';
import type * as ScenarioModule from '../src/rehearsal/scenario.ts';
import { HUNTS } from '../test/rehearsal/planted.ts';

const ROOT = resolve(import.meta.dirname, '..');
// Planting a bug is never public API, so the internals come from dist/, as rehearse.ts takes them.
const internal = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(ROOT, 'dist/rehearsal', path)).href)) as T;
const { scenarioWith } = await internal<typeof ScenarioModule>('scenario.js');
const { replay } = await internal<typeof RehearseModule>('rehearse.js');
const { huntOptions, planted } = await internal<typeof PlantsModule>('plants.js');
const { decodeReplay } = await internal<typeof ReplayModule>('replay.js');

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const folder = `0040-runs-${date}`;
const dir = resolve(ROOT, 'docs/decisions/data', folder);
mkdirSync(dir, { recursive: true });

for (const hunt of HUNTS) {
  const line = decodeReplay(hunt.line);
  const s = scenarioWith(huntOptions(festivalOptions(line.mode), hunt.plant), {
    plant: hunt.plant,
  });
  const result = await replay(s, hunt.line);
  if (!result.reproduced || result.run === undefined || result.found === undefined) {
    console.error(`${hunt.plant}: ${result.message}`);
    process.exit(1);
  }
  const full = result.run.history;
  const history = trim(full);
  const record = {
    what: `The failing run of the planted bug ${hunt.plant}, the shrunk run its hunt found, replayed from the line in test/rehearsal/planted.ts. Its history keeps only what the /rehearsal/ page draws (demo/src/rehearsal/domain/drawing.ts, isDrawn): ${String(history.length)} of its ${String(full.length)} entries. The replay line gives the whole run back`,
    command: `npm run rehearse -- --replay '${hunt.line}'`,
    date,
    plant: hunt.plant,
    bug: planted(hunt.plant).what,
    seed: hunt.seed,
    faultsDrawn: hunt.faults,
    replay: hunt.line,
    violation: result.found,
    history,
  };
  const path = resolve(dir, `${hunt.plant}.json`);
  const text = `${JSON.stringify(record)}\n`;
  writeFileSync(path, text);
  console.log(
    `${hunt.plant}: ${result.found.invariant} at ${String(result.found.time)}, ${String(history.length)} of ${String(full.length)} entries, ${String(Math.round(text.length / 1024))} KB`,
  );
}
console.log(`wrote ${folder}/`);
