import { Queue } from './queue.js';
import type { Scheduler } from './scheduler.js';

/** Something the dispatcher can give a turn to: in practice, an actor's cell. */
export interface Runnable {
  /** The actor's path, for the sender of what it sends during its turn (decision 0020). */
  readonly path?: string;
  /**
   * Runs up to `max` steps synchronously.
   * @returns How many steps ran.
   */
  run(max: number): number;
}

/**
 * Shares the one thread among every actor (decision 0007). It keeps a FIFO ready queue and gives
 * each runnable up to `throughput` steps per turn. It wakes on a microtask (`runSoon`), and after
 * `yieldAfter` steps in a row it yields with a zero-delay timer, a macrotask, so I/O and timers
 * get a turn even while actors message each other without end.
 *
 * Runnables decide when they're ready, and must not schedule themselves twice: the dispatcher
 * trusts them.
 */
export class Dispatcher {
  readonly #scheduler: Scheduler;
  readonly #throughput: number;
  readonly #yieldAfter: number;
  readonly #ready = new Queue<Runnable>();
  #running = false;
  #wakePending = false;
  /**
   * The runnable whose turn this is, while one is running and `trackCurrent` is on. A cell's turn
   * is the only code that runs inside a drain, so whatever it sends, it sent (decision 0020).
   */
  current: Runnable | undefined;
  /**
   * Whether to keep `current`. Only message events need it, and storing a pointer every turn
   * costs a GC write barrier, so the system turns this on only while someone wants them.
   */
  trackCurrent = false;

  constructor(scheduler: Scheduler, throughput: number, yieldAfter: number) {
    this.#scheduler = scheduler;
    this.#throughput = throughput;
    this.#yieldAfter = yieldAfter;
  }

  /** Puts `runnable` at the back of the ready queue, and wakes the dispatcher if it's idle. */
  schedule(runnable: Runnable): void {
    this.#ready.push(runnable);
    if (this.#running || this.#wakePending) return;
    this.#wakePending = true;
    this.#scheduler.runSoon(this.#drain);
  }

  readonly #drain = (): void => {
    this.#wakePending = false;
    this.#running = true;
    let ran = 0;
    try {
      while (ran < this.#yieldAfter) {
        const next = this.#ready.shift();
        if (next === undefined) break;
        if (this.trackCurrent) this.current = next;
        ran += next.run(Math.min(this.#throughput, this.#yieldAfter - ran));
      }
    } finally {
      this.#running = false;
      this.current = undefined;
    }
    if (this.#ready.size > 0) {
      // Out of budget with work left: yield to the event loop, then carry on.
      this.#wakePending = true;
      this.#scheduler.setTimer(this.#drain, 0);
    }
  };
}
