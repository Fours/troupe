/**
 * Thrown by `spawn` for a name that's invalid, reserved (it starts with `$`), or already used by
 * a sibling that hasn't terminated yet.
 */
export class ActorNameError extends Error {
  override readonly name = 'ActorNameError';
}

/** Thrown by `ctx.stop(ref)` and `system.stop(ref)` when `ref` is neither self nor a child. */
export class NotAChildError extends Error {
  override readonly name = 'NotAChildError';
}

/** Thrown by `ctx.spawn` once the actor is stopping or has stopped. */
export class ActorStoppedError extends Error {
  override readonly name = 'ActorStoppedError';
}

/** Thrown by `spawn` once `system.terminate()` has been called. */
export class ActorSystemTerminatedError extends Error {
  override readonly name = 'ActorSystemTerminatedError';
}
