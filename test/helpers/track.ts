/** A promise's outcome, read synchronously after `await kit.settle()`. */
export interface Tracked<T> {
  readonly state: 'pending' | 'resolved' | 'rejected';
  readonly value: T | undefined;
  readonly error: unknown;
}

/**
 * Records how `promise` settles, so a test can check that it's still pending at one instant and
 * settled at the next. It also handles the rejection, so a rejected promise isn't reported as
 * unhandled.
 */
export function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: { -readonly [K in keyof Tracked<T>]: Tracked<T>[K] } = {
    state: 'pending',
    value: undefined,
    error: undefined,
  };
  promise.then(
    (value) => {
      tracked.state = 'resolved';
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.state = 'rejected';
      tracked.error = error;
    },
  );
  return tracked;
}
