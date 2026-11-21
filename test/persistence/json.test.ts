import { describe, expect, it } from 'vitest';
import { isJsonValue, jsonProblem } from '../../src/persistence/json.js';

class Seat {
  row = 'A';
}

describe('isJsonValue', () => {
  it('accepts what JSON.parse can produce', () => {
    for (const value of [
      null,
      true,
      0,
      -0,
      -12.5,
      '',
      'text',
      [],
      [1, [2, [3]]],
      {},
      { a: { b: [null, { c: 'd' }] } },
      Object.create(null) as object,
      JSON.parse('{"__proto__": 1}') as unknown,
    ]) {
      expect(isJsonValue(value)).toBe(true);
    }
  });

  it('accepts the same object reached twice, which isn’t a cycle', () => {
    const shared = { n: 1 };
    expect(isJsonValue({ a: shared, b: shared, list: [shared, shared] })).toBe(true);
  });

  it('names the first part that isn’t JSON', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cases: [unknown, string][] = [
      [undefined, '$ is undefined'],
      [NaN, '$ is NaN'],
      [-Infinity, '$ is -Infinity'],
      [1n, '$ is a bigint'],
      [Symbol('s'), '$ is a symbol'],
      [() => 1, '$ is a function'],
      [{ a: [1, { b: undefined }] }, '$.a[1].b is undefined'],
      [{ 'odd key': NaN }, '$["odd key"] is NaN'],
      [new Date(0), '$ is not a plain object (Date)'],
      [{ seat: new Seat() }, '$.seat is not a plain object (Seat)'],
      [new Map(), '$ is not a plain object (Map)'],
      [Object.create({}) as object, '$ is not a plain object (Object)'],
      [{ [Symbol('k')]: 1 }, '$ has symbol keys'],
      // eslint-disable-next-line no-sparse-arrays -- the hole is the point
      [[1, , 3], '$[1] is a hole'],
      [cycle, '$.self is a cycle'],
    ];
    for (const [value, problem] of cases) expect(jsonProblem(value)).toBe(problem);
    for (const [value] of cases) expect(isJsonValue(value)).toBe(false);
  });

  it('names an anonymous class', () => {
    const anon = new (class {
      seat = 1;
    })();
    expect(jsonProblem(anon)).toBe('$ is not a plain object (an anonymous class)');
  });
});
