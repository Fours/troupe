// Option checks shared by createActorSystem, spawn and supervise. Each throws TypeError, so a bad
// option fails where it's passed in, never later.

/** Throws unless `opts` is a plain object whose keys are all in `allowed`. */
export function checkKeys(opts: unknown, allowed: ReadonlySet<string>, where: string): void {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new TypeError(`${where}: options must be an object`);
  }
  for (const key of Object.keys(opts)) {
    if (!allowed.has(key)) throw new TypeError(`${where}: unknown option "${key}"`);
  }
}

/** Throws unless `value` is a safe integer of at least `min` (1 by default), or `Infinity` when allowed. */
export function checkInt(
  value: unknown,
  what: string,
  { min = 1, infinite = false }: { min?: number; infinite?: boolean } = {},
): void {
  if (infinite && value === Infinity) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    const kind = min === 0 ? 'a non-negative integer' : 'a positive integer';
    throw new TypeError(
      `${what} must be ${kind}${infinite ? ' or Infinity' : ''}, got ${describe(value)}`,
    );
  }
}

/** Renders a bad value for an error message. */
export function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
