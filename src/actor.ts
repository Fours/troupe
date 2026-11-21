import type { ActorDef } from './types.js';

/**
 * Defines an actor: an initial state and a reducer (decision 0001). Returns the definition
 * unchanged. It exists so TypeScript infers and checks the message type `M` and the state type `S`
 * in one place.
 *
 * @example
 * const counter = actor<CounterMsg, number>({
 *   initial: 0,
 *   receive: (count, msg) => (msg.type === 'inc' ? count + msg.by : count),
 * });
 */
export function actor<M, S>(def: ActorDef<M, S>): ActorDef<M, S> {
  return def;
}
