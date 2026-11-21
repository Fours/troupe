import { checkInt, describe } from './checks.js';
import type { Timers } from './types.js';

/**
 * A timer's message in the mailbox. It carries its timer's generation, which is checked when it's
 * dequeued, so a cancelled or replaced timer's message is never received, even if it was already
 * queued.
 */
export class TimerEnvelope<M> {
  constructor(
    readonly key: string,
    readonly generation: number,
    readonly msg: M,
  ) {}
}

/** What a {@link TimerTable} needs from its cell. */
export interface TimerHost<M> {
  setTimer(task: () => void, delayMs: number): () => void;
  /** Queues a fired timer's message. Returns false if it became a dead letter instead. */
  enqueue(envelope: TimerEnvelope<M>): boolean;
}

interface Entry {
  readonly generation: number;
  readonly periodic: boolean;
  cancel: () => void;
}

/** One cell's keyed timers. The cell cancels them all on stop and on restart. */
export class TimerTable<M> {
  readonly #host: TimerHost<M>;
  readonly #entries = new Map<string, Entry>();
  // Counts across incarnations, so a key that's started again after a restart never matches an
  // old envelope.
  #generation = 0;

  constructor(host: TimerHost<M>) {
    this.#host = host;
  }

  start(key: string, msg: M, delayMs: number, periodic: boolean): void {
    this.cancel(key);
    const entry: Entry = { generation: ++this.#generation, periodic, cancel: () => {} };
    const arm = (): void => {
      entry.cancel = this.#host.setTimer(fire, delayMs);
    };
    const fire = (): void => {
      // Fixed delay: the next firing is measured from this one, not from when it's received.
      if (periodic) arm();
      const queued = this.#host.enqueue(new TimerEnvelope(key, entry.generation, msg));
      // A single timer whose message became a dead letter will never be received.
      if (!queued && !periodic) this.#entries.delete(key);
    };
    this.#entries.set(key, entry);
    arm();
  }

  cancel(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    entry.cancel();
    this.#entries.delete(key);
  }

  cancelAll(): void {
    for (const entry of this.#entries.values()) entry.cancel();
    this.#entries.clear();
  }

  isActive(key: string): boolean {
    return this.#entries.has(key);
  }

  /**
   * Called when an envelope is dequeued. Returns true if its timer is still current, so its
   * message should be received. A single timer is done once its message has been received.
   */
  accept(envelope: TimerEnvelope<M>): boolean {
    const entry = this.#entries.get(envelope.key);
    if (entry?.generation !== envelope.generation) return false;
    if (!entry.periodic) this.#entries.delete(envelope.key);
    return true;
  }
}

/**
 * The `ctx.timers` of one incarnation. Arguments are checked first, so a bad one always throws.
 * Once `live()` is false, every method does nothing.
 */
export function timersFor<M>(table: TimerTable<M>, live: () => boolean): Timers<M> {
  return Object.freeze({
    startSingle(key: string, msg: M, delayMs: number): void {
      checkKey(key, 'timers.startSingle');
      checkInt(delayMs, 'timers.startSingle: delayMs', { min: 0 });
      if (live()) table.start(key, msg, delayMs, false);
    },
    startPeriodic(key: string, msg: M, intervalMs: number): void {
      checkKey(key, 'timers.startPeriodic');
      checkInt(intervalMs, 'timers.startPeriodic: intervalMs');
      if (live()) table.start(key, msg, intervalMs, true);
    },
    cancel(key: string): void {
      checkKey(key, 'timers.cancel');
      if (live()) table.cancel(key);
    },
    cancelAll(): void {
      if (live()) table.cancelAll();
    },
    isActive(key: string): boolean {
      checkKey(key, 'timers.isActive');
      return live() && table.isActive(key);
    },
  });
}

function checkKey(key: unknown, where: string): void {
  if (typeof key !== 'string') {
    throw new TypeError(`${where}: key must be a string, got ${describe(key)}`);
  }
}
