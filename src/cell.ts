import type { Dispatcher, Runnable } from './dispatcher.js';
import type { EventBus } from './events.js';
import { safeLogger, type Logger } from './logger.js';
import { Queue } from './queue.js';
import type { ActorContext, ActorDef, ActorRef } from './types.js';

/** What a cell needs from its system. */
export interface CellHost {
  readonly dispatcher: Dispatcher;
  readonly events: EventBus;
  readonly log: Logger;
  now(): number;
  /** Called with +1 when a cell starts waiting on a promise, and -1 when it stops. */
  trackBusy(delta: 1 | -1): void;
}

/**
 * One actor: its state, mailbox and lifecycle. The dispatcher gives it turns, and it runs one
 * message at a time, holding its mailbox while an async `receive` is pending (decision 0002).
 *
 * Until milestone 1's T3 and T4 add stopping and supervision, a failure is logged and dropped: a
 * throw in `receive` keeps the old state, and a throw in `initial` leaves the actor dropping every
 * message.
 */
export class Cell<M, S> implements Runnable {
  readonly ref: ActorRef<M>;
  readonly ctx: ActorContext<M>;
  readonly #def: ActorDef<M, S>;
  readonly #host: CellHost;
  readonly #capacity: number;
  readonly #mailbox = new Queue<M>();
  readonly #log: Logger;
  #state: S | undefined;
  #started = false;
  #broken = false;
  // In the dispatcher's ready queue.
  #scheduled = false;
  // Inside run(), so a tell to self doesn't schedule the cell a second time.
  #running = false;
  // Waiting for an async receive to settle.
  #busy = false;

  constructor(path: string, def: ActorDef<M, S>, host: CellHost, capacity: number) {
    this.#def = def;
    this.#host = host;
    this.#capacity = capacity;
    this.#log = safeLogger(host.log, { path });
    this.ref = Object.freeze({
      path,
      tell: (msg: M) => {
        this.#tell(msg);
      },
    });
    this.ctx = Object.freeze({ self: this.ref, log: this.#log, now: () => host.now() });
  }

  /** Queues the actor's first step, which runs `initial`. */
  start(): void {
    this.#schedule();
  }

  run(max: number): number {
    this.#scheduled = false;
    this.#running = true;
    let steps = 0;
    try {
      while (steps < max && !this.#busy) {
        if (!this.#started) {
          steps++;
          this.#init();
          continue;
        }
        if (this.#mailbox.size === 0) break;
        // Size checked above, so shift() returns a message. M itself may include undefined.
        const msg = this.#mailbox.shift() as M;
        steps++;
        this.#receive(msg);
      }
    } finally {
      this.#running = false;
    }
    this.#scheduleIfReady();
    return steps;
  }

  #tell(msg: M): void {
    if (this.#mailbox.size >= this.#capacity) {
      this.#host.events.publish({
        type: 'deadLetter',
        recipient: this.ref.path,
        message: msg,
        reason: 'mailboxFull',
      });
      return;
    }
    this.#mailbox.push(msg);
    this.#scheduleIfReady();
  }

  #scheduleIfReady(): void {
    if (this.#scheduled || this.#running || this.#busy) return;
    if (this.#started && this.#mailbox.size === 0) return;
    this.#schedule();
  }

  #schedule(): void {
    this.#scheduled = true;
    this.#host.dispatcher.schedule(this);
  }

  #init(): void {
    this.#started = true;
    const { initial } = this.#def;
    try {
      this.#state =
        typeof initial === 'function'
          ? (initial as (ctx: ActorContext<M>) => S)(this.ctx)
          : initial;
    } catch (error) {
      this.#broken = true;
      this.#log.error('actor failed to start; its messages will be dropped', { error });
    }
  }

  #receive(msg: M): void {
    if (this.#broken) {
      this.#log.error('message dropped: the actor failed to start', { message: msg });
      return;
    }
    let result: S | Promise<S>;
    try {
      // #state is set once #init succeeds, and #broken guards the case where it didn't.
      result = this.#def.receive(this.#state as S, msg, this.ctx);
    } catch (error) {
      this.#fail(error, msg);
      return;
    }
    if (!isThenable(result)) {
      this.#state = result;
      return;
    }
    this.#busy = true;
    this.#host.trackBusy(1);
    Promise.resolve(result).then(
      (next) => {
        this.#settle();
        this.#state = next;
        this.#scheduleIfReady();
      },
      (error: unknown) => {
        this.#settle();
        this.#fail(error, msg);
        this.#scheduleIfReady();
      },
    );
  }

  #settle(): void {
    this.#busy = false;
    this.#host.trackBusy(-1);
  }

  #fail(error: unknown, msg: M): void {
    this.#log.error('actor failed on a message; dropped it and kept its state', {
      error,
      message: msg,
    });
  }
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
