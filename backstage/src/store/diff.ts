// What changed between two states, for the timeline's highlight. Both are wire values, so this
// compares JSON and needs to know nothing about markers: a marker is an object like any other.

import type { WireValue } from '@kylewillett/troupe/backstage';

/** Where a value sits in a state: JSON Pointer, so `''` is the root and `/holds/a~1b` a key. */
export type Pointer = string;

/** What {@link diff} finds. */
export interface Diff {
  /** Values in `after` that are new or different, by pointer. A changed container is listed, not its parents. */
  readonly changed: ReadonlySet<Pointer>;
  /** Keys and items gone from a container in `after`, by the container's pointer, with their old values. */
  readonly removed: ReadonlyMap<Pointer, readonly (readonly [string, WireValue])[]>;
}

/** No change at all. */
export const NO_DIFF: Diff = Object.freeze({ changed: new Set<Pointer>(), removed: new Map() });

/** A key or index as a pointer segment. */
export const segment = (key: string | number): string =>
  `/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

type Container = readonly WireValue[] | { readonly [key: string]: WireValue };

const isContainer = (value: WireValue): value is Container =>
  typeof value === 'object' && value !== null;

/**
 * Compares `before` with `after`. Objects and arrays are compared item by item, so a state with
 * one new hold has one change, not a changed root. Anything else that differs, a container
 * becoming an array included, is a change where it stands.
 */
export function diff(before: WireValue, after: WireValue): Diff {
  const changed = new Set<Pointer>();
  const removed = new Map<Pointer, (readonly [string, WireValue])[]>();

  const walk = (a: WireValue, b: WireValue, at: Pointer): void => {
    if (a === b) return;
    if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) {
      changed.add(at);
      return;
    }
    const left = a as Readonly<Record<string, WireValue>>;
    const right = b as Readonly<Record<string, WireValue>>;
    for (const key of Object.keys(right)) {
      const here = at + segment(key);
      if (Object.hasOwn(left, key)) walk(left[key] ?? null, right[key] ?? null, here);
      else changed.add(here);
    }
    for (const key of Object.keys(left)) {
      if (Object.hasOwn(right, key)) continue;
      const list = removed.get(at) ?? [];
      list.push([key, left[key] ?? null]);
      removed.set(at, list);
    }
  };

  walk(before, after, '');
  return changed.size === 0 && removed.size === 0 ? NO_DIFF : { changed, removed };
}
