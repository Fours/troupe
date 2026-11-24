// The run loop (decision 0033), which closes virtual time. 0003 left a gap: an async receive awaits
// real promises, so the testkit's settle waits real event-loop turns while actors are busy. Here
// every call a run makes resolves on a timer of simulation time, so the loop never waits for a
// busy actor. It runs everything that's ready, yields one macrotask so the continuations that work
// started can finish, and repeats until nothing more is ready. Then it moves time to the next
// timer: an actor awaiting a simulated call is waiting on a timer, and time will reach it.

import { checkInt, checkKeys } from '../checks.js';
import type { Scheduler } from '../scheduler.js';
import type { SystemHandle } from '../system.js';
import type { ManualScheduler } from '../testkit/manual-scheduler.js';
import { openYielder, type Yielder } from './yield.js';

/** Options for a {@link RunLoop}. */
export interface RunLoopOptions {
  /**
   * How long one actor may stay busy on one message, in ms of its own clock, before the run counts
   * as stalled. Default 30,000, which is longer than any simulated call should take.
   */
  stallAfterMs?: number;
}

/** Thrown when a run can't go on: an actor is waiting on something outside the simulation. */
export class StallError extends Error {
  /** Always `"StallError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'StallError';
  /** The busy actors, each as its system's label, if it has one, and its path. */
  readonly actors: readonly string[];

  constructor(message: string, actors: readonly string[]) {
    super(message);
    this.actors = actors;
  }
}

interface Watched {
  readonly handle: SystemHandle;
  readonly clock: Scheduler;
  readonly label: string | undefined;
}

const OPTIONS = new Set(['stallAfterMs']);

/**
 * Drives one simulation: the simulation's {@link ManualScheduler}, with every node's clock on it,
 * and the actor systems it watches for stalls.
 */
export class RunLoop {
  readonly #sim: ManualScheduler;
  readonly #stallAfterMs: number;
  readonly #watched: Watched[] = [];
  #yielder: Yielder | undefined;
  #users = 0;

  /**
   * Makes a loop for `sim`.
   * @throws TypeError for options that can't be used.
   */
  constructor(sim: ManualScheduler, opts: RunLoopOptions = {}) {
    checkKeys(opts, OPTIONS, 'RunLoop');
    const { stallAfterMs = 30_000 } = opts;
    checkInt(stallAfterMs, 'RunLoop: stallAfterMs');
    this.#sim = sim;
    this.#stallAfterMs = stallAfterMs;
  }

  /** The simulation's time, in ms. */
  now(): number {
    return this.#sim.now();
  }

  /**
   * Watches a system for stalls. `clock` is its scheduler, which its busy times are on, and
   * `label`, such as its node's name, goes before its actors' paths in a {@link StallError}.
   */
  watch(handle: SystemHandle, clock: Scheduler, label?: string): void {
    this.#watched.push({ handle, clock, label });
  }

  /**
   * Stops watching a system, such as a killed node's: what's left of it in this process never
   * runs again, so its busy actors are never going to finish.
   */
  unwatch(handle: SystemHandle): void {
    const i = this.#watched.findIndex((w) => w.handle === handle);
    if (i !== -1) this.#watched.splice(i, 1);
  }

  /**
   * Runs everything that needs no simulation time to pass, and the promise continuations it
   * starts, until nothing more is ready.
   * @throws StallError if an actor is busy and nothing could ever finish it, or has been busy on
   * one message for longer than `stallAfterMs`.
   */
  async settle(): Promise<void> {
    await this.#using(async (yielder) => {
      await this.#settle(yielder);
    });
  }

  /**
   * Moves simulation time `ms` on, settling at every timer's due time on the way, and ends
   * settled at exactly `ms` later.
   * @throws TypeError unless `ms` is a non-negative integer.
   * @throws StallError as `settle` does.
   */
  async advance(ms: number): Promise<void> {
    checkInt(ms, 'RunLoop.advance: ms', { min: 0 });
    await this.#using(async (yielder) => {
      const target = this.#sim.now() + ms;
      await this.#settle(yielder);
      for (;;) {
        const next = this.#sim.nextTimerAt();
        if (next === undefined || next > target) break;
        this.#sim.advanceTo(next);
        await this.#settle(yielder);
      }
      this.#sim.advanceTo(target);
    });
  }

  /**
   * Moves simulation time on to `time`, as `advance` does.
   * @throws RangeError if `time` is earlier than now.
   */
  async runUntil(time: number): Promise<void> {
    const now = this.#sim.now();
    if (!(time >= now)) {
      throw new RangeError(
        `RunLoop.runUntil: can't move time back from ${String(now)} to ${String(time)}`,
      );
    }
    await this.advance(time - now);
  }

  // One channel for every yield while any call is running, closed once none is, so the loop never
  // keeps a Node process alive.
  async #using(body: (yielder: Yielder) => Promise<void>): Promise<void> {
    this.#yielder ??= openYielder();
    const yielder = this.#yielder;
    this.#users++;
    try {
      await body(yielder);
    } finally {
      this.#users--;
      if (this.#users === 0) {
        yielder.close();
        this.#yielder = undefined;
      }
    }
  }

  async #settle(yielder: Yielder): Promise<void> {
    this.#sim.runReady();
    // A round that started nothing new leaves only timers in the future.
    do await yielder.next();
    while (this.#sim.runReady() > 0);
    this.#checkStalls();
  }

  #checkStalls(): void {
    let busy = 0;
    for (const w of this.#watched) busy += w.handle.busy();
    if (busy === 0) return;
    const at = `at ${String(this.#sim.now())} ms of simulation time`;
    if (this.#sim.nextTimerAt() === undefined) {
      const actors = this.#busy(() => true);
      throw new StallError(
        `the run stalled ${at}: nothing is ready and no timer is set, but ${actors.join(', ')} ` +
          'is still busy. Is it awaiting a promise outside the simulation?',
        actors,
      );
    }
    const limit = this.#stallAfterMs;
    const actors = this.#busy((since, clock) => clock.now() - since >= limit);
    if (actors.length > 0) {
      throw new StallError(
        `the run stalled ${at}: ${actors.join(', ')} has been busy on one message for ` +
          `${String(limit)} ms or more. Is it awaiting a promise outside the simulation, or a ` +
          'call that never answers?',
        actors,
      );
    }
  }

  #busy(stuck: (since: number, clock: Scheduler) => boolean): string[] {
    const actors: string[] = [];
    for (const { handle, clock, label } of this.#watched) {
      if (handle.busy() === 0) continue;
      for (const { path, since } of handle.busyActors()) {
        if (stuck(since, clock)) actors.push(label === undefined ? path : `${label} ${path}`);
      }
    }
    return actors;
  }
}
