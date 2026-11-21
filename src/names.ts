import { ActorNameError } from './errors.js';

// URL-safe, so paths can go on the wire unescaped in milestone 4.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

/**
 * The names in use under one parent, and the counter for generated names (`$1`, `$2`, ...).
 * Generated names start with `$`, which a caller can't pass in, so they never clash with chosen
 * ones.
 */
export class Names {
  readonly #taken = new Set<string>();
  #generated = 0;

  /**
   * Checks `name` and claims it, or generates one when it's `undefined`.
   * @param parentPath For error messages.
   * @throws ActorNameError for an invalid, reserved or taken name.
   */
  claim(name: unknown, parentPath: string): string {
    if (name === undefined) {
      const generated = `$${String(++this.#generated)}`;
      this.#taken.add(generated);
      return generated;
    }
    if (typeof name !== 'string') {
      throw new ActorNameError(`actor name must be a string, got ${typeof name}`);
    }
    if (name.startsWith('$')) {
      throw new ActorNameError(
        `actor name "${name}" is reserved: names starting with "$" are generated`,
      );
    }
    if (!NAME.test(name)) {
      throw new ActorNameError(
        `actor name "${name}" is invalid: use 1 to 64 letters, digits, ".", "_", "~" or "-", starting with a letter or digit`,
      );
    }
    if (this.#taken.has(name)) {
      throw new ActorNameError(`actor name "${name}" is already taken under ${parentPath}`);
    }
    this.#taken.add(name);
    return name;
  }
}

/** Joins a parent path and a child name. */
export function childPath(parentPath: string, name: string): string {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}
