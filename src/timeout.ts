// Timeouts on calls the framework makes to a store (decision 0036). A call that never settles
// would hold its caller for good: a persistent actor's mailbox, a projection's poll, a shard's
// handoff. The timer runs on the caller's scheduler (decision 0003), so virtual time reaches it.
// Never exported.

/** Schedules `task` after `delayMs`, and returns a function that cancels it. */
export type SetTimer = (task: () => void, delayMs: number) => () => void;

/**
 * Settles as `call` does, or rejects with `timedOut()` once `ms` have passed on `setTimer`,
 * whichever comes first. An answer that comes after the timeout is dropped: the outcome stays
 * unknown to the caller, which settles it by recovery, never by a late reply.
 */
export function withTimeout<T>(
  call: PromiseLike<T>,
  ms: number,
  setTimer: SetTimer,
  timedOut: () => Error,
): Promise<T> {
  // A promise settles once, so whichever comes second, the answer or the timeout, does nothing.
  return new Promise<T>((resolve, reject) => {
    const cancel = setTimer(() => {
      reject(timedOut());
    }, ms);
    Promise.resolve(call).then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        // The call's own reason, passed on as it came, whatever it is.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );
  });
}
