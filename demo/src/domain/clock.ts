// The driven clock: virtual time for the demo's system, moved forward by the page's animation
// frames at the chosen speed (decision 0022).
import type { ManualScheduler } from '@kylewillett/troupe/testkit';

/** How fast virtual time runs against real time. 0 is paused. */
export type Speed = 0 | 0.25 | 1 | 4;

/** The speeds the page offers, slowest first. */
export const SPEEDS: readonly Speed[] = [0, 0.25, 1, 4];

/**
 * The most real time one tick counts, in ms. A backgrounded tab gets no animation frames, and
 * this stops its first frame back from fast-forwarding through everything it missed.
 */
export const MAX_TICK_MS = 250;

/** How many event-loop turns one settle may take before it gives up. */
export const MAX_ROUNDS = 1_000;

/** Thrown when the system is still busy after {@link MAX_ROUNDS} turns of the event loop. */
export class SettleError extends Error {
  /** Always `"SettleError"`. */
  override readonly name = 'SettleError';
}

/** Options for {@link DrivenClock}. */
export interface DrivenClockOptions {
  /** The system's scheduler. */
  readonly scheduler: ManualScheduler;
  /**
   * Resolves after one turn of the event loop, so every pending promise has settled. The page
   * uses a `MessageChannel`, which browsers don't clamp the way they clamp nested `setTimeout`s.
   */
  readonly yieldToEventLoop: () => Promise<void>;
  /** The speed to start at. Default 1. */
  readonly speed?: Speed;
}

/**
 * Moves a {@link ManualScheduler} forward one due time at a time, letting the system settle at
 * each, as the testkit's `advance` does. Settling between due times means a journal write that
 * resolves on a microtask always finishes before a later timer fires, and the story doesn't
 * depend on how real time was cut into frames. Every call runs in turn, never two at once.
 */
export class DrivenClock {
  readonly #scheduler: ManualScheduler;
  readonly #yield: () => Promise<void>;
  #speed: Speed;
  // Virtual ms owed by ticks and not yet run: a fraction left over at slow speeds.
  #owed = 0;
  #queue: Promise<unknown> = Promise.resolve();

  /** Creates a clock on `opts.scheduler`, at speed 1 unless told otherwise. */
  constructor(opts: DrivenClockOptions) {
    this.#scheduler = opts.scheduler;
    this.#yield = opts.yieldToEventLoop;
    this.#speed = opts.speed ?? 1;
  }

  /** The current virtual time, in ms. */
  now(): number {
    return this.#scheduler.now();
  }

  /** How fast virtual time runs. */
  get speed(): Speed {
    return this.#speed;
  }

  set speed(speed: Speed) {
    if (!SPEEDS.includes(speed)) throw new RangeError(`speed must be one of ${SPEEDS.join(', ')}`);
    this.#speed = speed;
  }

  /**
   * Counts `realMs` of real time, at most {@link MAX_TICK_MS}, at the current speed, and moves
   * virtual time on by the whole milliseconds owed. Paused, it moves nothing.
   */
  tick(realMs: number): Promise<void> {
    this.#owed += Math.min(Math.max(realMs, 0), MAX_TICK_MS) * this.#speed;
    const whole = Math.floor(this.#owed);
    this.#owed -= whole;
    return whole === 0 ? this.run(() => Promise.resolve()) : this.advance(whole);
  }

  /** Moves virtual time on by `ms`, whatever the speed, settling at every due time on the way. */
  advance(ms: number): Promise<void> {
    if (!Number.isInteger(ms) || ms < 0) {
      throw new RangeError(`advance: ms must be a non-negative integer, got ${String(ms)}`);
    }
    return this.run(async () => {
      const target = this.#scheduler.now() + ms;
      await this.#settle();
      for (;;) {
        const next = this.#scheduler.nextTimerAt();
        if (next === undefined || next > target) break;
        this.#scheduler.advanceTo(next);
        await this.#settle();
      }
      this.#scheduler.advanceTo(target);
    });
  }

  /** Runs everything that can happen without time passing. */
  settle(): Promise<void> {
    return this.run(() => this.#settle());
  }

  /**
   * Runs `task` after every call before it has finished, and before any after it starts. For
   * work that mustn't interleave with time passing, such as restarting the system. `task` gets a
   * `settle` of its own, since calling the clock's would wait for `task` itself.
   */
  run<T>(task: (turn: { readonly settle: () => Promise<void> }) => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => task({ settle: () => this.#settle() }));
    // A failed call still lets the next one run. Its caller sees the failure.
    this.#queue = result.catch(() => undefined);
    return result;
  }

  // Quiet once a full turn of the event loop has passed and nothing new became ready.
  async #settle(): Promise<void> {
    this.#scheduler.runReady();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.#yield();
      if (this.#scheduler.runReady() === 0) return;
    }
    throw new SettleError(
      `the system was still busy after ${String(MAX_ROUNDS)} turns of the event loop`,
    );
  }
}
