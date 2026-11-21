import type { ActorRef } from '../types.js';

/**
 * A ref that records what it's sent, for assertions. Its assertions are synchronous, because the
 * test controls time: `await kit.settle()` (or `advance`), then assert.
 */
export class TestProbe<M> {
  /** Send this to the actor under test, as a `replyTo` or a subscriber. */
  readonly ref: ActorRef<M>;
  readonly #name: string;
  readonly #received: M[] = [];

  /**
   * @internal Create probes with `kit.probe()`.
   * @param makeRef The system's ref factory, which gives the ref its `ask`.
   */
  constructor(
    path: string,
    name: string,
    makeRef: (path: string, tell: (msg: M) => void) => ActorRef<M>,
  ) {
    this.#name = name;
    this.ref = makeRef(path, (msg: M) => {
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
