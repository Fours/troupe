import { describe, expect, it } from 'vitest';
import { diff, NO_DIFF, segment } from '../../backstage/src/store/diff.ts';

describe('diff', () => {
  it('finds nothing between equal values', () => {
    expect(diff({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(NO_DIFF);
    expect(diff(3, 3)).toBe(NO_DIFF);
  });

  it('points at the values that changed, not their parents', () => {
    const before = { seq: 3, state: { sold: 2, holds: { 'h-1': { seats: 2 } }, nextId: 2 } };
    const after = {
      seq: 4,
      state: { sold: 2, holds: { 'h-1': { seats: 2 }, 'h-2': { seats: 1 } }, nextId: 3 },
    };
    const { changed, removed } = diff(before, after);
    expect([...changed].sort()).toEqual(['/seq', '/state/holds/h-2', '/state/nextId']);
    expect(removed.size).toBe(0);
  });

  it('lists what was removed, under its container, with its old value', () => {
    const { changed, removed } = diff(
      { holds: { a: 1, b: 2 }, list: [1, 2, 3] },
      { holds: { b: 2 }, list: [1, 2] },
    );
    expect(changed.size).toBe(0);
    expect([...removed]).toEqual([
      ['/holds', [['a', 1]]],
      ['/list', [['2', 3]]],
    ]);
  });

  it('calls a change of kind a change where it stands', () => {
    expect([...diff({ a: [1] }, { a: { 0: 1 } }).changed]).toEqual(['/a']);
    expect([...diff({ a: null }, { a: {} }).changed]).toEqual(['/a']);
    expect([...diff([1], 'x').changed]).toEqual(['']);
    expect([...diff({ a: { $ref: '/user/x' } }, { a: { $ref: '/user/y' } }).changed]).toEqual([
      '/a/$ref',
    ]);
  });

  it('escapes keys as JSON Pointer does', () => {
    expect(segment('a/b~c')).toBe('/a~1b~0c');
    expect([...diff({}, { 'a/b': 1 }).changed]).toEqual(['/a~1b']);
  });
});
