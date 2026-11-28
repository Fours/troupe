// The shape of the /rehearsal/ page's recorded data. demo/build/rehearsal-data.ts reads it from
// docs/decisions/data/ when the site builds, draws each recorded run, and the page gets it from
// virtual:rehearsal-data. Types only, so the page and the loader agree without the page importing
// Node code.
import type { FaultPlan, NetworkMode } from '@kylewillett/troupe/rehearsal';
import type { Drawing } from './domain/drawing.ts';

/** The planted bugs whose failing runs are recorded, in the spec's order. */
export const RECORDED_PLANTS = [
  'late-deadline',
  'early-release',
  'grants-held',
  'greets-once',
  'routes-unreachable',
  'early-reply',
] as const;
export type RecordedPlant = (typeof RECORDED_PLANTS)[number];

/** A planted bug's hunt, from the planted table T7 recorded (0043). */
export interface PlantedRow {
  readonly plant: string;
  readonly bug: string;
  /** The first seed that found it, or `undefined` for one the code now tolerates. */
  readonly foundAtSeed: number | undefined;
  readonly invariant: string | undefined;
  /** Faults in the found seed's plan, and in the plan it shrank to. */
  readonly faults: number | undefined;
  readonly shrunkTo: number | undefined;
  readonly shrinkRuns: number | undefined;
  /** Why it's harmless now, for one the code tolerates. */
  readonly tolerated: string | undefined;
}

/** A planted bug's failing run, drawn. */
export interface RecordedRun {
  readonly plant: RecordedPlant;
  readonly bug: string;
  readonly seed: number;
  /** The line that replays it, with `npm run rehearse -- --replay`. */
  readonly replay: string;
  readonly plan: FaultPlan;
  readonly drawing: Drawing;
}

/** A bug the hunt found in the real code (0043), with the shrunk plan of the run that showed it. */
export interface FoundBug {
  readonly name: string;
  readonly what: string;
  readonly fix: string;
  readonly record: string | undefined;
  readonly mode: NetworkMode;
  readonly seed: number;
  readonly invariant: string;
  readonly plan: FaultPlan;
}

/** The hunt's totals (0043). */
export interface HuntTotals {
  readonly seeds: number;
  readonly runs: number;
  readonly faults: number;
  readonly ms: number;
  readonly machine: string;
  /** Appends the journal's sequence check refused, the seeds they were in, and those that paused. */
  readonly fenced: { readonly refused: number; readonly seeds: number; readonly paused: number };
  /** Bugs found in Rehearsal's own checks on the way. */
  readonly checkBugs: number;
}

export interface RehearsalData {
  /** The folders in docs/decisions/data/ it was read from. */
  readonly sources: readonly string[];
  readonly planted: readonly PlantedRow[];
  readonly runs: readonly RecordedRun[];
  readonly found: readonly FoundBug[];
  readonly hunt: HuntTotals;
}
