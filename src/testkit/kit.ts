import { ActorNameError } from '../errors.js';
import type { Logger, LogLevel } from '../logger.js';
import { createSystem } from '../system.js';
import type { ActorSystem, ActorSystemOptions, SystemEvent } from '../types.js';
import { ManualScheduler } from './manual-scheduler.js';
import { TestProbe } from './probe.js';

/** One entry the kit's logger recorded. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

/** Options for {@link createTestKit}. */
export interface TestKitOptions {
  /** The virtual time to start at, in ms. Default 0. */
  startTime?: number;
  /** Options for the system under test. The kit supplies the scheduler and the logger. */
  system?: Omit<ActorSystemOptions, 'scheduler' | 'logger'>;
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
}

/** Thrown by `settle` when actors stay busy, for example awaiting a promise that never settles. */
export class SettleTimeoutError extends Error {
  override readonly name = 'SettleTimeoutError';
}

const MAX_TICKS = 1000;
const PROBE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

/**
 * Creates an actor system on a {@link ManualScheduler}, with a logger that records into
 * `kit.logs`. Nothing runs until you call `settle`.
 */
export function createTestKit(opts: TestKitOptions = {}): TestKit {
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
  const handle = createSystem({ ...opts.system, scheduler, logger });
  const events: SystemEvent[] = [];
  handle.system.events.subscribe((event) => events.push(event));

  const probeNames = new Set<string>();
  let generated = 0;

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
      return new TestProbe<M>(`/temp/${full}`, full);
    },
    async settle(): Promise<void> {
      for (let ticks = 0; ; ticks++) {
        scheduler.runReady();
        if (handle.busy() === 0) return;
        if (ticks >= MAX_TICKS) {
          throw new SettleTimeoutError(
            `settle: ${String(handle.busy())} actor(s) still busy after ${String(MAX_TICKS)} ticks; ` +
              'is one awaiting a promise that never settles?',
          );
        }
        // Async receive runs on real promises, so let one real event-loop turn pass. This is the
        // one place the testkit uses real time (decision 0003).
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
