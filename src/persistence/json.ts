// Events and snapshot states are JSON values (decision 0014): what every backend can store and give
// back deep-equal. These checks run before anything is written, so a value that JSON would quietly
// change, such as `undefined` or a `Date`, fails where it's produced instead of on recovery.

/**
 * Where `value` stops being a JSON value, as a path such as `$.items[2]` with the reason, or
 * `undefined` if it is one.
 */
export function jsonProblem(value: unknown): string | undefined {
  return problemAt(value, '$', new Set());
}

/** Whether `value` is a JSON value: what `JSON.parse` could have produced. */
export function isJsonValue(value: unknown): boolean {
  return jsonProblem(value) === undefined;
}

function problemAt(value: unknown, path: string, ancestors: Set<object>): string | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      // -0 passes, as JSON.parse('-0') gives it, though it comes back as 0.
      return Number.isFinite(value) ? undefined : `${path} is ${String(value)}`;
    case 'object':
      if (value === null) return undefined;
      return objectProblem(value, path, ancestors);
    case 'undefined':
      return `${path} is undefined`;
    default:
      return `${path} is a ${typeof value}`;
  }
}

function objectProblem(value: object, path: string, ancestors: Set<object>): string | undefined {
  if (ancestors.has(value)) return `${path} is a cycle`;
  if (Object.getOwnPropertySymbols(value).length > 0) return `${path} has symbol keys`;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return arrayProblem(value, path, ancestors);
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return `${path} is not a plain object (${constructorName(value)})`;
    }
    for (const [key, item] of Object.entries(value)) {
      const problem = problemAt(item, `${path}${keyPath(key)}`, ancestors);
      if (problem !== undefined) return problem;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function arrayProblem(
  value: readonly unknown[],
  path: string,
  ancestors: Set<object>,
): string | undefined {
  for (let i = 0; i < value.length; i++) {
    // A hole would come back as null.
    if (!(i in value)) return `${path}[${String(i)}] is a hole`;
    const problem = problemAt(value[i], `${path}[${String(i)}]`, ancestors);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function constructorName(value: object): string {
  const ctor: unknown = (value as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'an anonymous class';
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function keyPath(key: string): string {
  return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}
