// Hooks between the core and the package's other entry points. None of this is public API: the
// symbols are exported only to the package's own modules, never from an entry point, so user
// actors can't reach them. Persistent actors use them to recover before any message (milestone 2).

import type { EventBody } from './events.js';
import type { ActorContext } from './types.js';

/**
 * An optional async step on an `ActorDef`, run after `initial` and before any message. It gets the
 * state `initial` made and returns the state to start with. The cell holds its mailbox until it
 * settles, and a rejection is a failure in the actor's start, the same as a throw in `initial`.
 */
export const START: unique symbol = Symbol('troupe.start');

/** What a cell offers its own `ctx`, beyond the public `ActorContext`. */
export const INTERNALS: unique symbol = Symbol('troupe.internals');

/** The start hook's shape. */
export type StartHook<M, S> = (state: S, ctx: ActorContext<M>) => Promise<S>;

/** An `ActorDef` that may carry a start hook. */
export interface WithStart<M, S> {
  readonly [START]?: StartHook<M, S>;
}

/** What `ctx[INTERNALS]` holds. */
export interface CellInternals {
  /** Publishes a system event, stamped by the system's bus. */
  publish(body: EventBody): void;
}

/** The internals of a `ctx` the system made. */
export function internalsOf(ctx: object): CellInternals {
  const internals = (ctx as unknown as { [INTERNALS]?: CellInternals })[INTERNALS];
  if (internals === undefined) {
    throw new TypeError('this context was not made by an actor system');
  }
  return internals;
}
