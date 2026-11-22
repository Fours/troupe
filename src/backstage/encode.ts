// The wire encoding (decision 0021). Messages and states can hold anything, and a wire carries only
// JSON, so `encode` turns any value into a JSON value with markers for what JSON can't say. It runs
// on every event while Backstage is attached, so it walks once, allocates only its output, and
// never throws: an inspector must never break the system it watches.

/** A JSON value, as every Backstage frame and response is made of. */
export type WireValue =
  null | boolean | number | string | readonly WireValue[] | { readonly [key: string]: WireValue };

/** How far `encode` goes before it cuts. Tuned against the demo's states in T3 (decision 0021). */
export const LIMITS = Object.freeze({
  /** Containers nested this deep are shown; one more is cut. */
  depth: 8,
  /** Items of one array, or keys of one object. */
  items: 200,
  /** Characters of one string. */
  string: 2000,
  /** Values in one call, so a wide and deep value can't take long however it's shaped. */
  total: 10_000,
});

/** What a value becomes when reading it throws. */
const UNREADABLE = Object.freeze({ $value: 'unreadable' });

/**
 * Turns any value into a JSON value, for a wire or a UI (decision 0021). Never throws.
 *
 * - A JSON value is itself, except that object keys starting with `$` gain one more `$`, so the
 *   markers below can't be forged. Unescape a key by dropping its first `$`.
 * - An actor ref, meaning anything with a string `path` and `tell` and `ask` functions, is
 *   `{ $ref: path }`.
 * - An `Error` is `{ $error: { name, message } }`.
 * - `undefined` is left out of objects and is `null` in arrays. On its own it's
 *   `{ $value: "undefined" }`.
 * - A non-finite number, a `bigint`, a function, a symbol, a `Map`, a `Set`, a `Date` or any other
 *   class instance is `{ $value: "..." }`, a short description such as `"Map(3)"`.
 * - A value already on the path from the root is `{ $cycle: true }`.
 * - Past 8 levels of containers, a container is `{ $truncated: n }`, with `n` its items. An array
 *   past 200 items ends with `{ $truncated: n }`, and an object past 200 keys has a `$truncated: n`
 *   key, `n` being how many were left out. A string past 2,000 characters is
 *   `{ $string: "<the first 2,000>", $truncated: n }`. After 10,000 values in one call, the rest
 *   are cut the same way.
 * - A value whose reading throws, such as a revoked proxy, is `{ $value: "unreadable" }`.
 */
export function encode(value: unknown): WireValue {
  const encoded = new Encoder().at(value, 0);
  return encoded === undefined ? { $value: 'undefined' } : encoded;
}

/** One `encode` call: the containers on the current path, and what's left of the budget. */
class Encoder {
  readonly #path = new Set<object>();
  #left: number = LIMITS.total;

  /** `value` encoded, or `undefined` for `undefined`, which a container leaves out or nulls. */
  at(value: unknown, depth: number): WireValue | undefined {
    this.#left -= 1;
    switch (typeof value) {
      case 'undefined':
        return undefined;
      case 'boolean':
        return value;
      case 'string':
        return string(value);
      case 'number':
        if (Number.isFinite(value)) return value === 0 ? 0 : value; // -0 isn't JSON
        return { $value: String(value) };
      case 'bigint':
        return { $value: `${String(value)}n` };
      case 'symbol':
        return { $value: clip(value.toString()) };
      case 'function':
        return { $value: functionName(value) };
      case 'object':
        if (value === null) return null;
        return this.#object(value, depth);
    }
  }

  #object(value: object, depth: number): WireValue {
    if (this.#path.has(value)) return { $cycle: true };
    this.#path.add(value);
    try {
      return this.#container(value, depth);
    } catch {
      // A throwing getter, a proxy trap or a revoked proxy. The rest of the value still encodes.
      return UNREADABLE;
    } finally {
      this.#path.delete(value);
    }
  }

  #container(value: object, depth: number): WireValue {
    const ref = refPath(value);
    if (ref !== undefined) return { $ref: clip(ref) };
    if (value instanceof Error) {
      // Either can be set to anything at runtime.
      const { name, message } = value as { name: unknown; message: unknown };
      return { $error: { name: clip(String(name)), message: clip(String(message)) } };
    }
    if (Array.isArray(value)) return this.#array(value as readonly unknown[], depth);
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { $value: describeInstance(value) };
    return this.#plain(value as Readonly<Record<string, unknown>>, depth);
  }

  #array(items: readonly unknown[], depth: number): WireValue {
    const length = items.length;
    if (depth >= LIMITS.depth) return { $truncated: length };
    const out: WireValue[] = [];
    const shown = Math.min(length, LIMITS.items);
    for (let i = 0; i < shown; i++) {
      if (this.#left <= 0) break;
      out.push(this.at(items[i], depth + 1) ?? null);
    }
    if (out.length < length) out.push({ $truncated: length - out.length });
    return out;
  }

  #plain(record: Readonly<Record<string, unknown>>, depth: number): WireValue {
    const keys = Object.keys(record);
    if (depth >= LIMITS.depth) return { $truncated: keys.length };
    const out: Record<string, WireValue> = {};
    const shown = Math.min(keys.length, LIMITS.items);
    let seen = 0;
    for (; seen < shown; seen++) {
      if (this.#left <= 0) break;
      const key = keys[seen] as string; // seen < keys.length
      const encoded = this.at(record[key], depth + 1);
      if (encoded !== undefined) define(out, key.startsWith('$') ? `$${key}` : key, encoded);
    }
    if (seen < keys.length) define(out, '$truncated', keys.length - seen);
    return out;
  }
}

/** Sets an own property, so a `__proto__` key is data, as `JSON.parse` makes it. */
function define(out: Record<string, WireValue>, key: string, value: WireValue): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function string(value: string): WireValue {
  if (value.length <= LIMITS.string) return value;
  return { $string: value.slice(0, LIMITS.string), $truncated: value.length - LIMITS.string };
}

/** Short text for a description, which is never itself cut with a marker. */
function clip(text: string): string {
  return text.length <= LIMITS.string ? text : `${text.slice(0, LIMITS.string)}…`;
}

/**
 * The path of an actor ref, by shape rather than by brand, so a remote ref that implements
 * `ActorRef` in milestone 4 encodes the same way.
 */
function refPath(value: object): string | undefined {
  const { path, tell, ask } = value as { path?: unknown; tell?: unknown; ask?: unknown };
  if (typeof path === 'string' && typeof tell === 'function' && typeof ask === 'function') {
    return path;
  }
  return undefined;
}

function functionName(fn: { readonly name: unknown }): string {
  let name: unknown;
  try {
    name = fn.name;
  } catch {
    name = '';
  }
  return typeof name === 'string' && name !== '' ? clip(`function ${name}`) : 'function';
}

function describeInstance(value: object): string {
  if (value instanceof Map) return `Map(${String(value.size)})`;
  if (value instanceof Set) return `Set(${String(value.size)})`;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Date(invalid)' : `Date(${value.toISOString()})`;
  }
  const ctor = (value as { constructor?: unknown }).constructor;
  const name = typeof ctor === 'function' ? ctor.name : '';
  return name === '' ? 'object' : clip(name);
}
