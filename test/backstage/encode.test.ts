import { describe, expect, it } from 'vitest';
import { encode, LIMITS, type WireValue } from '../../src/backstage/encode.js';
import { seededRandom } from '../../src/testkit/random.js';
import { createTestKit } from '../../src/testkit/kit.js';
import { actor } from '../../src/actor.js';

/** True if `value` is made only of what JSON has: no undefined, no non-finite or -0 numbers. */
function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== 'object') return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJson);
}

const roundTrip = (value: WireValue): unknown => JSON.parse(JSON.stringify(value));

/** `depth` arrays, one inside the next, around `inner`. */
function nest(depth: number, inner: unknown): unknown {
  let value = inner;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe('encode', () => {
  it('leaves JSON values as they are', () => {
    const value = { a: 1, b: 'two', c: [true, null, { d: 2.5 }], e: {}, f: [] };
    expect(encode(value)).toStrictEqual(value);
    for (const v of [0, 1.5, -3, 'x', '', true, false, null]) expect(encode(v)).toBe(v);
  });

  it('turns an actor ref into its path, by shape, and a system ref too', () => {
    const kit = createTestKit();
    const ref = kit.system.spawn(actor({ initial: 0, receive: (s: number) => s }), 'hamlet');
    expect(encode({ to: ref })).toStrictEqual({ to: { $ref: '/user/hamlet' } });
    const remote = { path: '/user/far', tell: () => {}, ask: () => Promise.resolve(1), node: 2 };
    expect(encode(remote)).toStrictEqual({ $ref: '/user/far' });
    // Missing ask: not a ref, just an object with a function in it.
    expect(encode({ path: '/x', tell: () => {} })).toStrictEqual({
      path: '/x',
      tell: { $value: 'function tell' },
    });
  });

  it('turns an error into its name and message, subclasses included', () => {
    expect(encode(new RangeError('too far'))).toStrictEqual({
      $error: { name: 'RangeError', message: 'too far' },
    });
    class SeatError extends Error {
      override name = 'SeatError';
    }
    expect(encode([new SeatError('taken')])).toStrictEqual([
      { $error: { name: 'SeatError', message: 'taken' } },
    ]);
  });

  it('leaves undefined out of objects, nulls it in arrays, and marks it on its own', () => {
    expect(encode({ a: undefined, b: 1 })).toStrictEqual({ b: 1 });
    expect(encode([undefined, 1])).toStrictEqual([null, 1]);
    // eslint-disable-next-line no-sparse-arrays -- a hole, which reads as undefined
    expect(encode([1, , 3])).toStrictEqual([1, null, 3]);
    expect(encode(undefined)).toStrictEqual({ $value: 'undefined' });
  });

  it('describes what JSON has no word for', () => {
    class Seat {
      row = 'A';
    }
    const cases: [unknown, string][] = [
      [NaN, 'NaN'],
      [Infinity, 'Infinity'],
      [-Infinity, '-Infinity'],
      [12n, '12n'],
      [function hold() {}, 'function hold'],
      [() => {}, 'function'],
      [Symbol('seat'), 'Symbol(seat)'],
      [new Map([[1, 2]]), 'Map(1)'],
      [new Set([1, 2, 3]), 'Set(3)'],
      [new Date(0), 'Date(1970-01-01T00:00:00.000Z)'],
      [new Date(NaN), 'Date(invalid)'],
      [new Seat(), 'Seat'],
      [new Uint8Array(4), 'Uint8Array'],
      [Object.create(Object.create(null) as object) as object, 'object'],
    ];
    for (const [value, description] of cases) {
      expect(encode(value)).toStrictEqual({ $value: description });
    }
    // An object with no prototype is plain data.
    const bare = Object.create(null) as Record<string, number>;
    bare.a = 1;
    expect(encode(bare)).toStrictEqual({ a: 1 });
    expect(encode(-0)).toBe(0);
  });

  it('marks a value already on the path as a cycle, but encodes a shared one twice', () => {
    const show: Record<string, unknown> = { name: 'hamlet' };
    show.self = show;
    show.list = [show];
    expect(encode(show)).toStrictEqual({
      name: 'hamlet',
      self: { $cycle: true },
      list: [{ $cycle: true }],
    });
    const seat = { row: 'A' };
    expect(encode({ a: seat, b: [seat] })).toStrictEqual({ a: { row: 'A' }, b: [{ row: 'A' }] });
  });

  it('cuts containers past 8 levels, saying how many items it left out', () => {
    expect(encode(nest(LIMITS.depth, 1))).toStrictEqual(nest(LIMITS.depth, 1));
    expect(encode(nest(LIMITS.depth + 1, 1))).toStrictEqual(nest(LIMITS.depth, { $truncated: 1 }));
    expect(encode(nest(LIMITS.depth, { a: 1, b: 2 }))).toStrictEqual(
      nest(LIMITS.depth, { $truncated: 2 }),
    );
  });

  it('cuts arrays and objects past 200 items, and strings past 2,000 characters', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(encode(items)).toStrictEqual([...items.slice(0, 200), { $truncated: 50 }]);
    expect(encode(items.slice(0, 200))).toStrictEqual(items.slice(0, 200));

    const wide = Object.fromEntries(items.map((i) => [`k${String(i)}`, i]));
    const encoded = encode(wide) as Record<string, WireValue>;
    expect(Object.keys(encoded)).toHaveLength(201);
    expect(encoded.k199).toBe(199);
    expect(encoded.k200).toBeUndefined();
    expect(encoded.$truncated).toBe(50);

    const long = 'x'.repeat(2500);
    expect(encode(long)).toStrictEqual({ $string: 'x'.repeat(2000), $truncated: 500 });
    expect(encode('x'.repeat(2000))).toBe('x'.repeat(2000));
  });

  it('stops after 10,000 values, however the value is shaped', () => {
    const grid = Array.from({ length: 100 }, () => Array.from({ length: 200 }, () => 1));
    const encoded = encode(grid) as WireValue[][];
    const kept = encoded.flat().filter((v) => v === 1).length;
    expect(kept).toBeLessThan(LIMITS.total);
    expect(kept).toBeGreaterThan(LIMITS.total - 200);
    // The row the budget ran out in ends with a marker, and so does the grid, for the rows after.
    const rows = encoded.length - 1;
    expect(encoded.at(-1)).toStrictEqual({ $truncated: 100 - rows });
    expect(encoded[rows - 1]?.at(-1)).toHaveProperty('$truncated');
  });

  it('escapes keys that start with $, so markers in user data are not markers', () => {
    expect(encode({ $ref: '/user/x', $$a: 1, a$: 2 })).toStrictEqual({
      $$ref: '/user/x',
      $$$a: 1,
      a$: 2,
    });
    expect(encode({ $truncated: 3 })).toStrictEqual({ $$truncated: 3 });
  });

  it('keeps a __proto__ key as data, as JSON.parse does', () => {
    const parsed = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    const encoded = encode(parsed);
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype);
    expect(JSON.stringify(encoded)).toBe('{"__proto__":{"x":1}}');
  });

  it('marks what it cannot read, and carries on with the rest', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const getter = {
      get bad(): number {
        throw new Error('no');
      },
    };
    const trap = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no');
        },
      },
    );
    expect(encode({ proxy, getter, trap, ok: 1 })).toStrictEqual({
      proxy: { $value: 'unreadable' },
      getter: { $value: 'unreadable' },
      trap: { $value: 'unreadable' },
      ok: 1,
    });
  });

  it('never throws, and always gives a JSON value that survives a round trip (property test)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const value = arbitrary(seededRandom(seed), 0);
      let encoded: WireValue | undefined;
      expect(
        () => {
          encoded = encode(value);
        },
        `seed ${String(seed)}`,
      ).not.toThrow();
      expect(isJson(encoded), `seed ${String(seed)}`).toBe(true);
      expect(roundTrip(encoded as WireValue), `seed ${String(seed)}`).toStrictEqual(encoded);
    }
  });

  it('gives back any JSON value within the limits and without $ keys (property test)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const value = arbitraryJson(seededRandom(seed), 0);
      expect(encode(value), `seed ${String(seed)}`).toStrictEqual(value);
    }
  });
});

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

/** A JSON value with no `$` keys, no -0, at most 6 levels and 10 items per container. */
function arbitraryJson(random: Random, depth: number): unknown {
  const roll = random();
  if (depth >= 6 || roll < 0.4) {
    return pick(random, [
      () => null,
      () => random() < 0.5,
      () => Math.floor(random() * 2000) - 1000,
      () => random() * 1e6,
      () => 'abc$ é🎭"\\\n'.slice(0, Math.floor(random() * 12)),
    ])();
  }
  const size = Math.floor(random() * 10);
  if (roll < 0.7) return Array.from({ length: size }, () => arbitraryJson(random, depth + 1));
  const out: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) out[`k${String(i)}`] = arbitraryJson(random, depth + 1);
  return out;
}

/** Anything at all: every row of the encoding table, things that throw, cycles and big shapes. */
function arbitrary(random: Random, depth: number): unknown {
  const roll = random();
  if (depth >= 12 || roll < 0.45) return leaf(random);
  if (roll < 0.55) return wide(random, depth);
  const size = Math.floor(random() * 6);
  const children = Array.from({ length: size }, () => arbitrary(random, depth + 1));
  if (roll < 0.75) {
    if (random() < 0.2) children.push(children);
    return children;
  }
  const out: Record<string, unknown> = {};
  children.forEach((child, i) => {
    const key = pick(random, ['a', '$ref', '$$x', '__proto__', '$truncated', `k${String(i)}`]);
    // defineProperty, so __proto__ is a key, as JSON.parse would make it.
    Object.defineProperty(out, key, { value: child, enumerable: true, configurable: true });
  });
  if (random() < 0.2) out.self = out;
  return out;
}

function wide(random: Random, depth: number): unknown {
  const size = 150 + Math.floor(random() * 150);
  const items = Array.from({ length: size }, () => (random() < 0.9 ? 1 : leaf(random)));
  if (random() < 0.5) return items;
  return Object.fromEntries(items.map((item, i) => [`k${String(i)}`, depth > 3 ? item : [item]]));
}

function leaf(random: Random): unknown {
  return pick(random, [
    () => undefined,
    () => null,
    () => NaN,
    () => -0,
    () => Infinity,
    () => BigInt(Math.floor(random() * 100)),
    () => Symbol('s'),
    () => function named() {},
    () => new Map([[1, 1]]),
    () => new Set(),
    () => new Date(Math.floor(random() * 1e12)),
    () => new Date(NaN),
    () => new TypeError('bad'),
    () => ({ path: '/user/x', tell: () => {}, ask: () => Promise.resolve() }),
    () => 'y'.repeat(Math.floor(random() * 3000)),
    () => {
      const { proxy, revoke } = Proxy.revocable([], {});
      revoke();
      return proxy;
    },
    () =>
      Object.defineProperty({}, 'bad', {
        enumerable: true,
        get() {
          throw new Error('no');
        },
      }),
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('no');
          },
        },
      ),
    () => Math.floor(random() * 100),
    () => 'plain',
  ])();
}
