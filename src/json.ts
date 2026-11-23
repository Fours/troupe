// What a JSON value is, once for the whole package. Events and snapshot states must be JSON values
// (decision 0014): what every backend can store and give back deep-equal. Messages that cross a
// node are JSON values plus refs (decision 0025), checked by the same walk with a ref hook. The
// checks run before anything is written or sent, so a value that JSON would quietly change, such
// as `undefined` or a `Date`, fails where it's produced instead of on recovery or on another node.

/** A JSON value: what `JSON.parse` could have produced. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What a {@link JsonHooks.ref} hook says about an object that is a ref. */
export type RefVerdict = { readonly value: JsonValue } | { readonly problem: string };

/** How {@link jsonCopy} treats refs and keys. */
export interface JsonHooks {
  /**
   * Called for every object before it's checked as a plain object. `undefined` if it isn't a ref;
   * otherwise the JSON value it becomes, or why it can't be used (said of `path`, as `$.to`).
   */
  readonly ref?: (value: object, path: string) => RefVerdict | undefined;
  /** Renames every object key in the copy, such as the wire's `$` escaping. */
  readonly key?: (key: string) => string;
}

/**
 * Where `value` stops being a JSON value, as a path such as `$.items[2]` with the reason, or
 * `undefined` if it is one.
 */
export function jsonProblem(value: unknown): string | undefined {
  try {
    new Walk(undefined, false).at(value, '$');
    return undefined;
  } catch (error) {
    if (error instanceof Problem) return error.text;
    throw error;
  }
}

/** Whether `value` is a JSON value: what `JSON.parse` could have produced. */
export function isJsonValue(value: unknown): boolean {
  return jsonProblem(value) === undefined;
}

/**
 * Copies `value` as a JSON value in one walk, turning refs into what `hooks.ref` says and renaming
 * keys with `hooks.key`, or names where it stops being one, as {@link jsonProblem} does.
 *
 * A getter that throws, or a revoked proxy, propagates its error.
 */
export function jsonCopy(
  value: unknown,
  hooks: JsonHooks,
):
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly problem: string } {
  try {
    return { ok: true, value: new Walk(hooks, true).at(value, '$') };
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.text };
    throw error;
  }
}

/** Sets an own property, so a `__proto__` key is data, as `JSON.parse` makes it. */
export function defineKey(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

// Thrown inside a walk and caught at its top, so the common case, a valid value, checks nothing
// on the way back up.
class Problem extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

/**
 * One walk of a value. Without `copy` it only checks, and returns `null` from every step, so
 * checking an event allocates nothing but the set of ancestors.
 */
class Walk {
  readonly #ancestors = new Set<object>();

  constructor(
    readonly hooks: JsonHooks | undefined,
    readonly copy: boolean,
  ) {}

  at(value: unknown, path: string): JsonValue {
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        // -0 passes, as JSON.parse('-0') gives it, though it comes back as 0.
        if (Number.isFinite(value)) return value;
        throw new Problem(`${path} is ${String(value)}`);
      case 'object':
        if (value === null) return null;
        return this.#object(value, path);
      case 'undefined':
        throw new Problem(`${path} is undefined`);
      default:
        throw new Problem(`${path} is a ${typeof value}`);
    }
  }

  #object(value: object, path: string): JsonValue {
    const verdict = this.hooks?.ref?.(value, path);
    if (verdict !== undefined) {
      if ('problem' in verdict) throw new Problem(verdict.problem);
      return verdict.value;
    }
    const ancestors = this.#ancestors;
    if (ancestors.has(value)) throw new Problem(`${path} is a cycle`);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Problem(`${path} has symbol keys`);
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return this.#array(value, path);
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Problem(`${path} is not a plain object (${constructorName(value)})`);
      }
      return this.#plain(value as Readonly<Record<string, unknown>>, path);
    } finally {
      ancestors.delete(value);
    }
  }

  #array(value: readonly unknown[], path: string): JsonValue {
    const out: JsonValue[] | undefined = this.copy ? [] : undefined;
    for (let i = 0; i < value.length; i++) {
      // A hole would come back as null.
      if (!(i in value)) throw new Problem(`${path}[${String(i)}] is a hole`);
      const item = this.at(value[i], `${path}[${String(i)}]`);
      out?.push(item);
    }
    return out ?? null;
  }

  #plain(value: Readonly<Record<string, unknown>>, path: string): JsonValue {
    const out: Record<string, JsonValue> | undefined = this.copy ? {} : undefined;
    const rename = this.hooks?.key;
    for (const [key, item] of Object.entries(value)) {
      const copied = this.at(item, `${path}${keyPath(key)}`);
      if (out !== undefined) defineKey(out, rename === undefined ? key : rename(key), copied);
    }
    return out ?? null;
  }
}

function constructorName(value: object): string {
  const ctor: unknown = (value as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'an anonymous class';
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** How a key reads in a problem's path: `.name`, or `["a key"]` when it isn't an identifier. */
export function keyPath(key: string): string {
  return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}
