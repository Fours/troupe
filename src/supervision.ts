import { checkInt, checkKeys, describe } from './checks.js';

/**
 * What happens to an actor when it fails. The parent picks it when it spawns the child
 * (decision 0006). Build one with {@link supervise}.
 */
export type SupervisorStrategy =
  | { readonly type: 'stop' }
  | { readonly type: 'resume' }
  | { readonly type: 'restart'; readonly maxRestarts: number; readonly withinMs: number }
  | {
      readonly type: 'backoff';
      readonly minMs: number;
      readonly maxMs: number;
      readonly randomFactor: number;
      readonly resetAfterMs: number;
      /**
       * The fewest ms a restart must wait for a failure, or `undefined` for no minimum. See
       * {@link supervise.restartWithBackoff}. Absent when no failure raises the delay.
       */
      readonly minDelayFor?: (failure: unknown) => number | undefined;
    };

const RESTART_OPTIONS = new Set(['maxRestarts', 'withinMs']);
const BACKOFF_OPTIONS = new Set(['minMs', 'maxMs', 'randomFactor', 'resetAfterMs', 'minDelayFor']);

/** Builds supervisor strategies. Each one checks its options and throws `TypeError` for bad ones. */
export const supervise = Object.freeze({
  /** Stop the actor, with `failure` set on `terminated` and on the `stopped` event. The default. */
  stop(): SupervisorStrategy {
    return Object.freeze({ type: 'stop' });
  },

  /** Keep the actor's state, drop the message that failed, and carry on with the next one. */
  resume(): SupervisorStrategy {
    return Object.freeze({ type: 'resume' });
  },

  /**
   * Run `preRestart`, stop the children, and run `initial` again. The mailbox, the ref and the
   * actor's watchers carry over.
   * @param opts.maxRestarts The most restarts within `withinMs`. One more failure stops the
   * actor. Default `Infinity`.
   * @param opts.withinMs The rolling window that `maxRestarts` counts over, in ms. Default
   * `Infinity`.
   */
  restart(opts: { maxRestarts?: number; withinMs?: number } = {}): SupervisorStrategy {
    checkKeys(opts, RESTART_OPTIONS, 'supervise.restart');
    const { maxRestarts = Infinity, withinMs = Infinity } = opts;
    return checked({ type: 'restart', maxRestarts, withinMs }, 'supervise.restart');
  },

  /**
   * Restart, as {@link supervise.restart} does, but wait first. Restart number `n`, counting from
   * 0, waits `max(min(maxMs, minMs * 2^n), minimum) * (1 + random() * randomFactor)` ms, rounded,
   * where `minimum` is what `minDelayFor` returned for the failure, or 0. `n` goes back to 0 once
   * the actor has run for `resetAfterMs` without failing.
   * @param opts.randomFactor Jitter, so actors that failed together don't restart together.
   * Default 0.2.
   * @param opts.resetAfterMs Default `maxMs`.
   * @param opts.minDelayFor Called with each failure, the thrown value as it is. It returns the
   * fewest ms the restart must wait, such as a server's `retry-after`, or `undefined` for no
   * minimum. A minimum isn't capped by `maxMs`, and doesn't count as extra backoff steps: the next
   * failure's step is `n + 1` as usual. Jitter still applies on top, so the restart never comes
   * sooner than the minimum. A return that isn't a non-negative integer or `undefined`, or a
   * throw, is logged at `error` and the ordinary backoff applies (decision 0041).
   */
  restartWithBackoff(opts: {
    minMs: number;
    maxMs: number;
    randomFactor?: number;
    resetAfterMs?: number;
    minDelayFor?: (failure: unknown) => number | undefined;
  }): SupervisorStrategy {
    checkKeys(opts, BACKOFF_OPTIONS, 'supervise.restartWithBackoff');
    const { minMs, maxMs, randomFactor = 0.2, resetAfterMs = maxMs, minDelayFor } = opts;
    return checked(
      {
        type: 'backoff',
        minMs,
        maxMs,
        randomFactor,
        resetAfterMs,
        // Left out when absent, so a strategy without it is the same value it always was.
        ...(minDelayFor === undefined ? {} : { minDelayFor }),
      },
      'supervise.restartWithBackoff',
    );
  },
});

function checked(strategy: SupervisorStrategy, where: string): SupervisorStrategy {
  checkStrategy(strategy, where);
  return Object.freeze(strategy);
}

/** Checks a strategy, including one built by hand rather than by {@link supervise}. */
export function checkStrategy(value: unknown, where: string): asserts value is SupervisorStrategy {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${where}: a supervisor strategy must be an object`);
  }
  const s = value as Record<string, unknown>;
  switch (s.type) {
    case 'stop':
    case 'resume':
      checkKeys(s, new Set(['type']), where);
      return;
    case 'restart':
      checkKeys(s, new Set(['type', ...RESTART_OPTIONS]), where);
      checkInt(s.maxRestarts, `${where}: maxRestarts`, { min: 0, infinite: true });
      checkInt(s.withinMs, `${where}: withinMs`, { infinite: true });
      return;
    case 'backoff':
      checkKeys(s, new Set(['type', ...BACKOFF_OPTIONS]), where);
      checkInt(s.minMs, `${where}: minMs`);
      checkInt(s.maxMs, `${where}: maxMs`);
      if ((s.maxMs as number) < (s.minMs as number)) {
        throw new TypeError(`${where}: maxMs must be at least minMs`);
      }
      if (
        typeof s.randomFactor !== 'number' ||
        !(s.randomFactor >= 0 && s.randomFactor < Infinity)
      ) {
        throw new TypeError(
          `${where}: randomFactor must be a finite number of at least 0, got ${describe(s.randomFactor)}`,
        );
      }
      checkInt(s.resetAfterMs, `${where}: resetAfterMs`);
      if (s.minDelayFor !== undefined && typeof s.minDelayFor !== 'function') {
        throw new TypeError(
          `${where}: minDelayFor must be a function, got ${describe(s.minDelayFor)}`,
        );
      }
      return;
    default:
      throw new TypeError(`${where}: unknown supervisor strategy type ${describe(s.type)}`);
  }
}

/** What an actor's failures so far mean for the next one. Owned by its cell. */
export interface RestartHistory {
  /** Failure times inside the window, for `restart` with a finite `withinMs`. */
  readonly times: readonly number[];
  /** Failures counted, for `restart` with an infinite window. */
  readonly count: number;
  /** Backoff restarts since the last reset: `n` in the formula. */
  readonly backoffs: number;
}

/** A history with no failures in it. */
export const NO_FAILURES: RestartHistory = Object.freeze({ times: [], count: 0, backoffs: 0 });

/** What supervision does about one failure. */
export type Decision =
  | { readonly directive: 'stop' | 'resume' }
  | { readonly directive: 'restart'; readonly attempt: number; readonly delayMs: number };

/** The facts about one failure that a strategy decides on. */
export interface FailureFacts {
  readonly now: number;
  /** When the current incarnation ran `initial`. */
  readonly startedAt: number;
  /** True if `initial` failed, so there's no state to resume with. */
  readonly inInitial: boolean;
  readonly random: () => number;
  /** The fewest ms a backoff restart must wait for this failure, from {@link minimumDelay}. */
  readonly minDelayMs: number;
}

/** What a strategy's `minDelayFor` said about a failure: a minimum, or a problem to log. */
export type MinimumDelay =
  | { readonly ms: number; readonly problem?: undefined }
  | { readonly ms: 0; readonly problem: string; readonly error?: unknown };

const NO_MINIMUM: MinimumDelay = Object.freeze({ ms: 0 });

/**
 * Asks a backoff strategy's `minDelayFor` about a failure. It runs the user's code, so it's kept
 * out of {@link decide}, and it never throws: a throw or a bad return comes back as a problem for
 * the cell to log, with no minimum, so a broken reader can't break supervision.
 */
export function minimumDelay(strategy: SupervisorStrategy, failure: unknown): MinimumDelay {
  if (strategy.type !== 'backoff' || strategy.minDelayFor === undefined) return NO_MINIMUM;
  let ms: unknown;
  try {
    ms = strategy.minDelayFor(failure);
  } catch (error) {
    return { ms: 0, problem: 'minDelayFor threw; using the backoff alone', error };
  }
  if (ms === undefined) return NO_MINIMUM;
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) {
    return {
      ms: 0,
      problem: `minDelayFor must return a non-negative integer or undefined, got ${describe(ms)}; using the backoff alone`,
    };
  }
  return { ms };
}

/**
 * Decides what to do about a failure, and returns the history to keep for the next one. Pure,
 * apart from drawing from `random`, and only for backoff. Limits and resets are worked out from
 * failure times when a failure happens, so no timer is needed to track them.
 */
export function decide(
  strategy: SupervisorStrategy,
  history: RestartHistory,
  facts: FailureFacts,
): { decision: Decision; history: RestartHistory } {
  switch (strategy.type) {
    case 'stop':
      return { decision: { directive: 'stop' }, history };
    case 'resume':
      // With no state to keep, there's nothing to resume.
      return { decision: { directive: facts.inInitial ? 'stop' : 'resume' }, history };
    case 'restart': {
      const { now } = facts;
      let next: RestartHistory;
      let count: number;
      if (strategy.withinMs === Infinity) {
        count = history.count + 1;
        next = { ...history, count };
      } else {
        const times = [...history.times.filter((t) => now - t < strategy.withinMs), now];
        count = times.length;
        next = { ...history, times };
      }
      if (count > strategy.maxRestarts) return { decision: { directive: 'stop' }, history: next };
      return { decision: { directive: 'restart', attempt: count, delayMs: 0 }, history: next };
    }
    case 'backoff': {
      const ranLongEnough = facts.now - facts.startedAt >= strategy.resetAfterMs;
      const n = ranLongEnough ? 0 : history.backoffs;
      // The minimum isn't capped by maxMs: a server's retry-after wins over our own guess.
      const base = Math.max(Math.min(strategy.maxMs, strategy.minMs * 2 ** n), facts.minDelayMs);
      const delayMs = Math.round(base * (1 + facts.random() * strategy.randomFactor));
      return {
        decision: { directive: 'restart', attempt: n + 1, delayMs },
        history: { ...history, backoffs: n + 1 },
      };
    }
  }
}
