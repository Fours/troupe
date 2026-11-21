import { checkInt } from '../checks.js';
import { ActorNameError } from '../errors.js';
import type { Logger, LogLevel } from '../logger.js';
import { createSystem } from '../system.js';
import type { ActorSystem, ActorSystemOptions, SystemEvent } from '../types.js';
import { ManualScheduler } from './manual-scheduler.js';
import { TestProbe } from './probe.js';
import { seededRandom } from './random.js';

/** One entry the kit's logger recorded. */
export interface LogEntry {
  /** The level it was logged at. */
  readonly level: LogLevel;
  /** The message. */
  readonly msg: string;
  /** The structured fields, when any were given. An actor's entries include its `path`. */
  readonly fields?: Record<string, unknown>;
}

/** Options for {@link createTestKit}. */
export interface TestKitOptions {
  /** The seed for the system's `random`, through {@link seededRandom}. Default 1. */
  seed?: number;
  /** The virtual time to start at, in ms. Default 0. */
  startTime?: number;
  /** Options for the system under test. The kit supplies the scheduler, random and logger. */
  system?: Omit<ActorSystemOptions, 'scheduler' | 'random' | 'logger'>;
}

/** An actor system on virtual time, with probes and a record of everything it did. */
export interface TestKit {
  /** The system under test. */
  readonly system: ActorSystem;
  /** Its scheduler. Prefer `settle` and `advance` to driving it directly. */
  readonly scheduler: ManualScheduler;
  /** Every event the system published, in order. */
  readonly events: readonly SystemEvent[];
  /** Everything the system and its actors logged, at every level. */
  readonly logs: readonly LogEntry[];
  /** Creates a probe at `/temp/probe-<name>`. Names are generated when omitted. */
  probe<M>(name?: string): TestProbe<M>;
  /**
   * Runs everything that can happen without time passing: queued work, due timers and actors'
   * messages, until nothing is left.
   * @throws SettleTimeoutError if actors are still busy after 1,000 real event-loop ticks.
   */
  settle(): Promise<void>;
  /**
   * Moves virtual time forward by `ms`. Timers fire in order of due time, then of creation, with
   * the clock set to each one's due time, and the kit settles after each due time. Timers that
   * are set along the way fire too, if they fall due within `ms`. Ends settled, with the clock
   * `ms` later than it started.
   * @throws TypeError if `ms` isn't a non-negative integer.
   * @throws SettleTimeoutError as `settle` does.
   */
  advance(ms: number): Promise<void>;
  /** Terminates the system, then settles until every actor has stopped. */
  shutdown(): Promise<void>;
}

/** Thrown by `settle` when actors stay busy, for example awaiting a promise that never settles. */
export class SettleTimeoutError extends Error {
  /** Always `"SettleTimeoutError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'SettleTimeoutError';
}

const MAX_TICKS = 1000;
const PROBE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

/**
 * Creates an actor system on a {@link ManualScheduler} and a {@link seededRandom}, with a logger
 * that records into `kit.logs`. Nothing runs until you call `settle`.
 * @throws TypeError if `seed` isn't a safe integer.
 */
export function createTestKit(opts: TestKitOptions = {}): TestKit {
  const random = seededRandom(opts.seed ?? 1);
  const scheduler = new ManualScheduler(
    opts.startTime === undefined ? {} : { startTime: opts.startTime },
  );
  const logs: LogEntry[] = [];
  const record =
    (level: LogLevel) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      logs.push(fields === undefined ? { level, msg } : { level, msg, fields });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  const handle = createSystem({ ...opts.system, scheduler, random, logger });
  const events: SystemEvent[] = [];
  handle.system.events.subscribe((event) => events.push(event));

  const probeNames = new Set<string>();
  let generated = 0;

  const settle = async (): Promise<void> => {
    for (let ticks = 0; ; ticks++) {
      scheduler.runReady();
      if (handle.busy() === 0) return;
      if (ticks >= MAX_TICKS) {
        // An ask only time can complete is the likeliest culprit when one is pending.
        const hint =
          handle.pendingAsks() > 0
            ? 'is one awaiting an ask that only times out as time passes? Pipe it with pipeToSelf'
            : 'is one awaiting a promise that never settles?';
        throw new SettleTimeoutError(
          `settle: ${String(handle.busy())} actor(s) still busy after ${String(MAX_TICKS)} ` +
            `ticks; ${hint}`,
        );
      }
      // Async receive runs on real promises, so let one real event-loop turn pass. This is the
      // one place the testkit uses real time (decision 0003).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    system: handle.system,
    scheduler,
    events,
    logs,
    probe<M>(name?: string): TestProbe<M> {
      const chosen = name ?? String(++generated);
      if (!PROBE_NAME.test(chosen)) throw new ActorNameError(`probe name "${chosen}" is invalid`);
      const full = `probe-${chosen}`;
      if (probeNames.has(full)) throw new ActorNameError(`probe name "${chosen}" is already taken`);
      probeNames.add(full);
      return new TestProbe<M>(`/temp/${full}`, full, handle);
    },
    settle,
    async advance(ms: number): Promise<void> {
      checkInt(ms, 'advance: ms', { min: 0 });
      const target = scheduler.now() + ms;
      await settle();
      for (;;) {
        const next = scheduler.nextTimerAt();
        if (next === undefined || next > target) break;
        // Settling ran everything already due, so `next` is in the future. This runs every timer
        // due then, and what they queue, with the clock at `next`. The settle after it lets async
        // work they started finish before time moves on.
        scheduler.advanceTo(next);
        await settle();
      }
      scheduler.advanceTo(target);
    },
    async shutdown(): Promise<void> {
      const terminated = handle.system.terminate();
      await settle();
      await terminated;
    },
  };
}
