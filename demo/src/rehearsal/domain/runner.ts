// Running festival night's rehearsal for the /rehearsal/ page (milestone 5, T8): seed after seed,
// and one run drawn on request. It's the real code, on the real simulated network and database
// (decision 0004), with no React and no clock of its own, so the page's worker drives it and the
// tests run it as it is. The worker times it, since timing is the only real clock it needs.
import {
  StallError,
  type FaultPlan,
  type NetworkMode,
  type Scenario,
} from '@kylewillett/troupe/rehearsal';
import { draw, type Drawing } from './drawing.ts';
import { festival } from './festival.ts';

/** A seed that broke an invariant. */
export interface Problem {
  readonly seed: number;
  readonly mode: NetworkMode;
  readonly invariant: string;
  readonly message: string;
}

/** What the page asks its worker. */
export type ToRunner =
  | { readonly t: 'start'; readonly mode: NetworkMode; readonly from: number }
  | { readonly t: 'stop' }
  | {
      readonly t: 'draw';
      /** Which drawing it is, so the page puts it in the right place. */
      readonly id: string;
      readonly mode: NetworkMode;
      readonly seed: number;
      readonly plan?: FaultPlan;
    };

/** What the worker answers. */
export type FromRunner =
  | {
      readonly t: 'progress';
      readonly mode: NetworkMode;
      /** Runs since the last start. */
      readonly runs: number;
      /** The next seed it will run. */
      readonly next: number;
      /** Real ms spent running them. */
      readonly ms: number;
      /** How many seeds broke an invariant, and the first {@link MAX_PROBLEMS} of them. */
      readonly failing: number;
      readonly problems: readonly Problem[];
      readonly running: boolean;
    }
  | { readonly t: 'drawn'; readonly id: string; readonly drawing: Drawing }
  | { readonly t: 'failed'; readonly id: string | undefined; readonly message: string };

/** How many problems the page is told about: the first ones, which are the ones to look at. */
export const MAX_PROBLEMS = 20;

/** Festival night's scenario for each mode, made once. */
export class Runner {
  readonly #scenarios = new Map<NetworkMode, Scenario>();

  #scenario(mode: NetworkMode): Scenario {
    let s = this.#scenarios.get(mode);
    if (s === undefined) {
      s = festival({ mode });
      this.#scenarios.set(mode, s);
    }
    return s;
  }

  /** Runs one seed, and says what it broke, if anything. A stalled run is a problem too. */
  async check(mode: NetworkMode, seed: number): Promise<Problem | undefined> {
    try {
      const run = await this.#scenario(mode).run({ seed });
      const v = run.violations[0];
      return v === undefined
        ? undefined
        : { seed, mode, invariant: v.invariant, message: v.message };
    } catch (error) {
      if (!(error instanceof StallError)) throw error;
      return { seed, mode, invariant: 'stalled', message: error.message };
    }
  }

  /** Runs one seed, or a seed with a plan in place of the one it draws, and draws it. */
  async draw(mode: NetworkMode, seed: number, plan?: FaultPlan): Promise<Drawing> {
    const run = await this.#scenario(mode).run(plan === undefined ? { seed } : { seed, plan });
    return draw(run.history, run.violations[0]);
  }
}
