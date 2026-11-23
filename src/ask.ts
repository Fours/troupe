import { checkInt, checkKeys } from './checks.js';
import { ActorSystemTerminatedError, AskTimeoutError } from './errors.js';
import type { EventBus } from './events.js';
import type { ActorRef, AnyRef, AskOptions, Result } from './types.js';

const ASK_OPTIONS = new Set(['timeoutMs']);
const TEMP_PATH = '/temp';

/** How an ask came out, once it has, and who wants to know at once (decision 0010). */
interface Outcome {
  result: Result<unknown> | undefined;
  readonly listeners: ((result: Result<unknown>) => void)[];
}

/** What an {@link Asker} needs from its system. */
export interface AskerHost {
  readonly events: EventBus;
  readonly systemName: string;
  readonly defaultTimeoutMs: number;
  setTimer(task: () => void, delayMs: number): () => void;
}

/**
 * Makes refs and runs `ask` for one system (decision 0009). Every ref, whether it belongs to a
 * cell, an ask or a probe, gets its `ask` from here, so asking works the same whatever is behind
 * the ref.
 *
 * An ask's temporary ref, under `/temp`, isn't an actor. It has no mailbox: a reply resolves the
 * promise as soon as it's told. It publishes no `spawned` or `stopped` events.
 */
export class Asker {
  readonly #host: AskerHost;
  // Rejects each ask that's still waiting, for terminate().
  readonly #pending = new Set<(error: Error) => void>();
  readonly #outcomes = new WeakMap<object, Outcome>();
  // Every ref this asker made, so the wire can refuse refs from another system (decision 0025).
  readonly #made = new WeakSet<object>();
  // The temporary refs of asks still waiting, by path, so a reply from another node can find
  // its ask (decision 0025).
  readonly #temps = new Map<string, AnyRef>();
  #generated = 0;
  #terminated = false;

  constructor(host: AskerHost) {
    this.#host = host;
  }

  /** Freezes `path` and `tell` into a ref, with an `ask` that targets it. */
  ref<M>(path: string, tell: (msg: M) => void): ActorRef<M> {
    const ref: ActorRef<M> = Object.freeze({
      path,
      tell,
      ask: <R>(build: (replyTo: ActorRef<R>) => M, opts?: AskOptions) => this.ask(ref, build, opts),
    });
    this.#made.add(ref);
    return ref;
  }

  /** Whether this asker made `ref`: a cell's, an ask's, a probe's, or one made through `ref`. */
  owns(ref: unknown): boolean {
    return typeof ref === 'object' && ref !== null && this.#made.has(ref);
  }

  /** The temporary ref at `path`, while its ask waits for a reply or its timeout. */
  temp(path: string): AnyRef | undefined {
    return this.#temps.get(path);
  }

  /**
   * Rejects every pending ask, and every later one, with `ActorSystemTerminatedError`. It does
   * this at once rather than after `/user` has stopped: an actor whose async `receive` awaits an
   * ask can't stop until that ask settles.
   */
  terminate(): void {
    this.#terminated = true;
    for (const reject of [...this.#pending]) reject(this.#terminatedError());
  }

  /**
   * Calls `listener` synchronously when `promise`, an ask's promise, settles, or at once if it
   * already has. This keeps `pipeToSelf` of an ask on the scheduler, with no promise hop
   * (decision 0010).
   * @returns False, doing nothing, if `promise` isn't one this asker made.
   */
  onSettled(promise: unknown, listener: (result: Result<unknown>) => void): boolean {
    const outcome = typeof promise === 'object' && promise !== null && this.#outcomes.get(promise);
    if (!outcome) return false;
    if (outcome.result === undefined) outcome.listeners.push(listener);
    else listener(outcome.result);
    return true;
  }

  ask<M, R>(
    target: ActorRef<M>,
    build: (replyTo: ActorRef<R>) => M,
    opts: AskOptions | undefined,
  ): Promise<R> {
    // Checked before anything else, so bad options throw where they're passed in.
    const timeoutMs = this.#timeout(opts);
    if (typeof build !== 'function') throw new TypeError('ask: build must be a function');
    if (this.#terminated) return Promise.reject(this.#terminatedError());
    const { events } = this.#host;
    const outcome: Outcome = { result: undefined, listeners: [] };
    const settled = (result: Result<unknown>): void => {
      outcome.result = result;
      for (const listener of outcome.listeners.splice(0)) listener(result);
    };
    const promise = new Promise<R>((resolve, reject) => {
      const path = `${TEMP_PATH}/$${String(++this.#generated)}`;
      let done = false;
      let cancelTimer = (): void => {};
      const finish = (): boolean => {
        if (done) return false;
        done = true;
        cancelTimer();
        this.#pending.delete(fail);
        this.#temps.delete(path);
        return true;
      };
      const fail = (error: Error): void => {
        if (!finish()) return;
        reject(error);
        settled({ ok: false, error });
      };
      const replyTo = this.ref<R>(path, (reply) => {
        if (finish()) {
          resolve(reply);
          settled({ ok: true, value: reply });
          return;
        }
        const reason = this.#terminated ? 'terminated' : 'askCompleted';
        events.publish({ type: 'deadLetter', recipient: path, message: reply, reason });
      });
      let msg: M;
      try {
        msg = build(replyTo);
      } catch (error) {
        // Nothing has been sent and no timer set. A reply through a ref that build kept is then
        // an askCompleted dead letter. Throwing from the executor rejects with build's error.
        done = true;
        settled({ ok: false, error });
        throw error;
      }
      cancelTimer = this.#host.setTimer(() => {
        fail(new AskTimeoutError(target.path, timeoutMs));
      }, timeoutMs);
      this.#pending.add(fail);
      this.#temps.set(path, replyTo);
      target.tell(msg);
    });
    this.#outcomes.set(promise, outcome);
    return promise;
  }

  /** How many asks are still waiting for a reply or their timeout. */
  pending(): number {
    return this.#pending.size;
  }

  #timeout(opts: AskOptions | undefined): number {
    if (opts === undefined) return this.#host.defaultTimeoutMs;
    checkKeys(opts, ASK_OPTIONS, 'ask');
    if (opts.timeoutMs === undefined) return this.#host.defaultTimeoutMs;
    checkInt(opts.timeoutMs, 'ask: timeoutMs');
    return opts.timeoutMs;
  }

  #terminatedError(): ActorSystemTerminatedError {
    return new ActorSystemTerminatedError(
      `system "${this.#host.systemName}" is terminating, so the ask can't complete`,
    );
  }
}
