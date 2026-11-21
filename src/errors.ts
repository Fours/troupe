/**
 * Thrown by `spawn` for a name that's invalid, reserved (it starts with `$`), or already used by
 * a sibling that hasn't terminated yet.
 */
export class ActorNameError extends Error {
  /** Always `"ActorNameError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'ActorNameError';
}

/** Thrown by `ctx.stop(ref)` and `system.stop(ref)` when `ref` is neither self nor a child. */
export class NotAChildError extends Error {
  /** Always `"NotAChildError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'NotAChildError';
}

/** Thrown by `ctx.spawn` once the actor is stopping or has stopped. */
export class ActorStoppedError extends Error {
  /** Always `"ActorStoppedError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'ActorStoppedError';
}

/**
 * Thrown by `spawn` once `system.terminate()` has been called. Also the reason every pending and
 * later `ask` rejects.
 */
export class ActorSystemTerminatedError extends Error {
  /** Always `"ActorSystemTerminatedError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'ActorSystemTerminatedError';
}

/** The reason an `ask` rejects when no reply arrives within its timeout. */
export class AskTimeoutError extends Error {
  /** Always `"AskTimeoutError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'AskTimeoutError';
  /** The path of the actor that was asked. */
  readonly target: string;
  /** How long the ask waited, in ms. */
  readonly timeoutMs: number;

  /** @internal `ask` creates these. */
  constructor(target: string, timeoutMs: number) {
    super(`ask to ${target} got no reply within ${String(timeoutMs)} ms`);
    this.target = target;
    this.timeoutMs = timeoutMs;
  }
}
