import type { Watcher } from '../cell.js';
import type { ActorRef, AnyRef } from '../types.js';

/** What a probe needs from its system. */
export interface ProbeHost {
  /** The system's ref factory, which gives the probe's ref its `ask`. */
  makeRef<M>(path: string, tell: (msg: M) => void): ActorRef<M>;
  /** Watches `ref` on the probe's behalf, as `ctx.watch` does. */
  watch(ref: AnyRef, watcher: Watcher): void;
}

/**
 * A ref that records what it's sent, for assertions. Its assertions are synchronous, because the
 * test controls time: `await kit.settle()` (or `advance`), then assert.
 */
export class TestProbe<M> {
  /** Send this to the actor under test, as a `replyTo` or a subscriber. */
  readonly ref: ActorRef<M>;
  readonly #name: string;
  readonly #received: M[] = [];
  readonly #host: ProbeHost;
  // Refs being watched whose terminated notice hasn't arrived, and notices not yet expected.
  readonly #watching = new Set<AnyRef>();
  readonly #terminated = new Set<AnyRef>();
  readonly #watcher: Watcher = {
    notifyTerminated: (target) => {
      if (this.#watching.delete(target.ref)) this.#terminated.add(target.ref);
    },
  };

  /** @internal Create probes with `kit.probe()`. */
  constructor(path: string, name: string, host: ProbeHost) {
    this.#name = name;
    this.#host = host;
    this.ref = host.makeRef(path, (msg: M) => {
      this.#received.push(msg);
    });
  }

  /**
   * Takes the next message and checks it.
   * @param match Optional. A value it must deeply equal, or a predicate it must pass.
   * @returns The message.
   * @throws Error naming the probe and what it got, if no message is queued or it doesn't match.
   */
  expectMessage(match?: M | ((msg: M) => boolean)): M {
    if (this.#received.length === 0) {
      throw new Error(`${this.#name}: expected a message, but none arrived`);
    }
    const msg = this.#received.shift() as M;
    if (match === undefined) return msg;
    if (typeof match === 'function') {
      if (!(match as (msg: M) => boolean)(msg)) {
        throw new Error(`${this.#name}: got ${show(msg)}, which doesn't match the predicate`);
      }
    } else if (!deepEqual(msg, match)) {
      throw new Error(`${this.#name}: expected ${show(match)}, got ${show(msg)}`);
    }
    return msg;
  }

  /**
   * Checks that no message is queued.
   * @throws Error naming the probe and the first message waiting.
   */
  expectNoMessage(): void {
    if (this.#received.length > 0) {
      const extra =
        this.#received.length > 1 ? ` and ${String(this.#received.length - 1)} more` : '';
      throw new Error(`${this.#name}: expected no message, got ${show(this.#received[0])}${extra}`);
    }
  }

  /** Takes every queued message, oldest first. */
  messages(): M[] {
    return this.#received.splice(0);
  }

  /**
   * Watches an actor, for {@link TestProbe.expectTerminated}. Watching twice is the same as once,
   * and watching an actor that has already terminated records its termination at once.
   * @throws TypeError if `ref` isn't an actor of this system.
   */
  watch(ref: AnyRef): void {
    if (this.#watching.has(ref) || this.#terminated.has(ref)) return;
    // Added first, because an actor that has already terminated is reported during the call.
    this.#watching.add(ref);
    try {
      this.#host.watch(ref, this.#watcher);
    } catch (error) {
      this.#watching.delete(ref);
      throw error;
    }
  }

  /**
   * Checks that a watched actor has terminated, and takes its notice, so the probe stops watching
   * it.
   * @throws Error naming the probe and the actor, if it hasn't terminated or isn't watched.
   */
  expectTerminated(ref: AnyRef): void {
    if (this.#terminated.delete(ref)) return;
    const why = this.#watching.has(ref) ? "it hasn't" : "the probe isn't watching it";
    throw new Error(`${this.#name}: expected ${ref.path} to terminate, but ${why}`);
  }
}

/** Structural equality for plain data: primitives by `Object.is`, arrays and objects by content. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  return keysA.every((key) => Object.hasOwn(recB, key) && deepEqual(recA[key], recB[key]));
}

function show(value: unknown): string {
  try {
    // Typed as string, but JSON.stringify returns undefined for undefined and symbols.
    const json = JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'function' ? '[function]' : typeof v === 'bigint' ? `${v.toString()}n` : v,
    ) as string | undefined;
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
