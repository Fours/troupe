import type { SystemEvent } from '@kylewillett/troupe';
import type { DrivenClock } from '../../demo/src/domain/clock.ts';
import { openingNight, type OpeningNightOptions } from '../../demo/src/domain/opening-night.ts';

/** One turn of Node's event loop: the tests' `yieldToEventLoop`. */
export const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** An opening night for a test, recording every event, messages included. */
export function testNight(opts: Omit<OpeningNightOptions, 'yieldToEventLoop'> = {}) {
  const night = openingNight({ yieldToEventLoop: nextTurn, ...opts });
  const events: SystemEvent[] = [];
  night.subscribe((event) => events.push(event));
  return { night, events };
}

/** Lets virtual time pass, 10 ms at a time, until `promise` settles, and returns its value. */
export async function answered<T>(clock: DrivenClock, promise: Promise<T>): Promise<T> {
  // An object, since TypeScript can't see the callback change a plain local.
  const state = { done: false };
  promise
    .finally(() => {
      state.done = true;
    })
    // Seen by the caller, through the returned promise.
    .catch(() => undefined);
  for (let i = 0; i < 1_000 && !state.done; i++) await clock.advance(10);
  return promise;
}

/** The events of one type, typed. */
export function only<T extends SystemEvent['type']>(
  events: readonly SystemEvent[],
  type: T,
): Extract<SystemEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);
}
