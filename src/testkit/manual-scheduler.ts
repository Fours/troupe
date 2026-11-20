import type { Scheduler } from '../scheduler.js';

/** Options for {@link ManualScheduler}. */
export interface ManualSchedulerOptions {
  /** The virtual time to start at, in ms. Default 0. */
  startTime?: number;
  /**
   * How many tasks and timers one {@link ManualScheduler.runReady} may run, without time moving,
   * before the scheduler decides something is re-queuing itself forever and throws a
   * `RangeError`. Default 100,000.
   */
  maxSteps?: number;
}

interface Timer {
  readonly due: number;
  readonly seq: number;
  readonly task: () => void;
  cancelled: boolean;
}

const OPTION_KEYS = new Set(['startTime', 'maxSteps']);

/**
 * A scheduler on virtual time, for tests and simulation (decision 0003). Nothing runs on its
 * own: queued tasks and due timers run only when you call {@link ManualScheduler.runReady} or
 * {@link ManualScheduler.advanceTo}, and time moves only through `advanceTo`.
 *
 * Queued tasks always run before timers, and timers run in order of due time, then of creation.
 * An error thrown by a task comes out of the call that ran it. The task has already left the
 * queue, so the scheduler stays usable.
 */
export class ManualScheduler implements Scheduler {
  #now: number;
  readonly #maxSteps: number;
  readonly #tasks: (() => void)[] = [];
  #taskHead = 0;
  readonly #heap: Timer[] = [];
  #seq = 0;
  #live = 0;

  constructor(opts: ManualSchedulerOptions = {}) {
    for (const key of Object.keys(opts)) {
      if (!OPTION_KEYS.has(key)) throw new TypeError(`ManualScheduler: unknown option "${key}"`);
    }
    const { startTime = 0, maxSteps = 100_000 } = opts;
    if (!Number.isFinite(startTime)) {
      throw new TypeError(
        `ManualScheduler: startTime must be a finite number, got ${String(startTime)}`,
      );
    }
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new TypeError(
        `ManualScheduler: maxSteps must be a positive integer, got ${String(maxSteps)}`,
      );
    }
    this.#now = startTime;
    this.#maxSteps = maxSteps;
  }

  /** The current virtual time, in ms. While a timer runs, this is its due time. */
  now(): number {
    return this.#now;
  }

  /** Queues `task`. It runs at the next {@link ManualScheduler.runReady} or `advanceTo`. */
  runSoon(task: () => void): void {
    this.#tasks.push(task);
  }

  /**
   * Schedules `task` at `now() + delayMs` of virtual time. A negative or `NaN` delay counts as 0,
   * as `setTimeout` treats it.
   * @returns A function that cancels the timer. It stops a timer that's already due as long as it
   * hasn't run yet.
   */
  setTimer(task: () => void, delayMs: number): () => void {
    const delay = Number.isNaN(delayMs) ? 0 : Math.max(0, delayMs);
    const timer: Timer = { due: this.#now + delay, seq: this.#seq++, task, cancelled: false };
    this.#push(timer);
    this.#live++;
    return () => {
      if (timer.cancelled) return;
      timer.cancelled = true;
      this.#live--;
    };
  }

  /**
   * Runs queued tasks and due timers, without moving time, until none are left. Tasks go first,
   * so the tasks a timer queues run before the next timer.
   * @returns How many tasks and timers ran.
   * @throws RangeError after `maxSteps` in one call, which means something re-queues itself
   * without end.
   */
  runReady(): number {
    let ran = 0;
    for (;;) {
      const task = this.#takeTask();
      if (task !== undefined) {
        ran = this.#step(ran);
        task();
        continue;
      }
      const timer = this.#peekLive();
      if (timer === undefined || timer.due > this.#now) return ran;
      this.#pop();
      timer.cancelled = true;
      this.#live--;
      ran = this.#step(ran);
      timer.task();
    }
  }

  /**
   * Moves virtual time forward to `time`, running everything that falls due on the way. Before
   * each timer runs, `now()` is set to its due time. Timers scheduled along the way also run if
   * they fall due by `time`. Ends with `now() === time`.
   * @throws RangeError if `time` is earlier than `now()`, because virtual time never goes back.
   */
  advanceTo(time: number): void {
    if (Number.isNaN(time) || time < this.#now) {
      throw new RangeError(
        `ManualScheduler: can't move time back from ${String(this.#now)} to ${String(time)}`,
      );
    }
    for (;;) {
      this.runReady();
      const next = this.#peekLive();
      if (next === undefined || next.due > time) break;
      this.#now = next.due;
    }
    this.#now = time;
  }

  /** How many timers are scheduled and not yet run or cancelled. */
  pendingTimers(): number {
    return this.#live;
  }

  // Counts one more step of a runReady call, and stops a call that will never finish.
  #step(ran: number): number {
    if (ran >= this.#maxSteps) {
      throw new RangeError(
        `ManualScheduler: more than ${String(this.#maxSteps)} tasks and timers ran at time ` +
          `${String(this.#now)}; something is re-queuing itself without end`,
      );
    }
    return ran + 1;
  }

  #takeTask(): (() => void) | undefined {
    if (this.#taskHead === this.#tasks.length) return undefined;
    const task = this.#tasks[this.#taskHead];
    this.#taskHead++;
    // Reclaim the consumed prefix once it dominates the array, so the queue can't grow forever.
    if (this.#taskHead > 1024 && this.#taskHead * 2 > this.#tasks.length) {
      this.#tasks.splice(0, this.#taskHead);
      this.#taskHead = 0;
    }
    return task;
  }

  // The earliest timer that's still live, dropping cancelled ones from the top of the heap.
  #peekLive(): Timer | undefined {
    for (;;) {
      const top = this.#heap[0];
      if (top === undefined || !top.cancelled) return top;
      this.#pop();
    }
  }

  #push(timer: Timer): void {
    const heap = this.#heap;
    heap.push(timer);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!earlier(timer, at(heap, parent))) break;
      heap[i] = at(heap, parent);
      i = parent;
    }
    heap[i] = timer;
  }

  #pop(): void {
    const heap = this.#heap;
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && earlier(at(heap, right), at(heap, left)) ? right : left;
      if (!earlier(at(heap, child), last)) break;
      heap[i] = at(heap, child);
      i = child;
    }
    heap[i] = last;
  }
}

function earlier(a: Timer, b: Timer): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}

function at(heap: Timer[], i: number): Timer {
  const timer = heap[i];
  // Callers only pass indexes below heap.length.
  if (timer === undefined) throw new Error(`ManualScheduler: heap index ${String(i)} out of range`);
  return timer;
}
