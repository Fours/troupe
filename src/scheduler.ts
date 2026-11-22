/**
 * The only way the core reads time or schedules work (decision 0003). Pass one to
 * `createActorSystem` to control time, as the testkit's `ManualScheduler` does.
 */
export interface Scheduler {
  /** The current time in milliseconds. Only differences between readings matter. */
  now(): number;
  /** Runs `task` soon, after the current task finishes. Tasks run in the order they were queued. */
  runSoon(task: () => void): void;
  /**
   * Runs `task` once, after at least `delayMs` milliseconds.
   * @returns A function that cancels the timer. Calling it again, or after the timer ran, does
   * nothing.
   */
  setTimer(task: () => void, delayMs: number): () => void;
}

/**
 * A scheduler on the host's real clock and event loop: `performance.now()`, which is monotonic,
 * rounded down to whole milliseconds, `queueMicrotask`, and `setTimeout`. It works on any
 * JavaScript runtime (decision 0004).
 *
 * Its timers aren't `unref()`'d, which is Node-only, so pending timers keep a Node process alive.
 */
export function realScheduler(): Scheduler {
  return {
    // Whole milliseconds, as on virtual time, so an event's `at` and a `processed` event's
    // `durationMs` are integers whichever clock runs. Rounding down keeps it monotonic.
    now: () => Math.floor(performance.now()),
    runSoon: (task) => {
      queueMicrotask(task);
    },
    setTimer: (task, delayMs) => {
      const handle = setTimeout(task, delayMs);
      return () => {
        clearTimeout(handle);
      };
    },
  };
}
