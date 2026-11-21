/**
 * Thrown by `spawn` for a name that's invalid, reserved (it starts with `$`), or already used by
 * a sibling.
 */
export class ActorNameError extends Error {
  override readonly name = 'ActorNameError';
}
