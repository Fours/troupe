import { describe, expect, it } from 'vitest';
import {
  advance,
  decodeTable,
  encodeTable,
  keyOf,
  merge,
  sameTable,
  tableOf,
  type Entry,
  type Status,
  type Table,
} from '../../src/cluster/table.js';
import { seededRandom } from '../../src/testkit/random.js';

// Milestone 4, T4: the member table (decision 0028). Gossip converges in any order only if merge
// is a join: commutative, associative and idempotent.

const STATUSES: readonly Status[] = ['up', 'leaving', 'down', 'removed'];
const isAddress = (a: string) => /^[^@#/\s]+$/.test(a);

/** A random table over a small set of addresses and uids, so tables overlap often. */
function arbitrary(random: () => number): Table {
  const entries: Entry[] = [];
  const count = Math.floor(random() * 7);
  for (let i = 0; i < count; i++) {
    entries.push({
      address: `node-${String(Math.floor(random() * 3))}`,
      uid: Math.floor(random() * 3),
      status: STATUSES[Math.floor(random() * STATUSES.length)] ?? 'up',
    });
  }
  return tableOf(entries);
}

/** A table as a list, so order counts too: every node must walk it the same way. */
const listed = (t: Table) => [...t.entries()];

describe('the member table', () => {
  it('merges commutatively, associatively and idempotently (property test)', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const random = seededRandom(seed);
      const [a, b, c] = [arbitrary(random), arbitrary(random), arbitrary(random)];
      expect(listed(merge(a, b)), `seed ${String(seed)}`).toEqual(listed(merge(b, a)));
      expect(listed(merge(a, merge(b, c))), `seed ${String(seed)}`).toEqual(
        listed(merge(merge(a, b), c)),
      );
      expect(listed(merge(a, a)), `seed ${String(seed)}`).toEqual(listed(a));
      // And it only moves forward: the merge keeps everything either side knew.
      for (const [key, entry] of merge(a, b)) {
        for (const side of [a, b]) {
          const known = side.get(key);
          if (known !== undefined) {
            expect(STATUSES.indexOf(entry.status)).toBeGreaterThanOrEqual(
              STATUSES.indexOf(known.status),
            );
          }
        }
      }
    }
  });

  it('keeps the furthest status for an incarnation, and keys incarnations apart', () => {
    const a = tableOf([{ address: 'n1', uid: 7, status: 'down' }]);
    const b = tableOf([
      { address: 'n1', uid: 7, status: 'up' },
      { address: 'n1', uid: 9, status: 'up' },
    ]);
    expect(listed(merge(a, b))).toEqual([
      [keyOf('n1', 7), { address: 'n1', uid: 7, status: 'down' }],
      [keyOf('n1', 9), { address: 'n1', uid: 9, status: 'up' }],
    ]);
  });

  it('sorts by address, then uid', () => {
    const t = tableOf([
      { address: 'b', uid: 1, status: 'up' },
      { address: 'a', uid: 20, status: 'up' },
      { address: 'a', uid: 3, status: 'up' },
    ]);
    expect([...t.keys()]).toEqual(['a#3', 'a#20', 'b#1']);
  });

  it('advances only forward', () => {
    const t = tableOf([{ address: 'a', uid: 1, status: 'down' }]);
    expect(advance(t, { address: 'a', uid: 1, status: 'up' })).toBe(t);
    expect(advance(t, { address: 'a', uid: 1, status: 'removed' }).get('a#1')?.status).toBe(
      'removed',
    );
  });

  it('round-trips through gossip, and refuses what isn’t a table', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const t = arbitrary(seededRandom(seed));
      const back = decodeTable(JSON.parse(JSON.stringify(encodeTable(t))), isAddress);
      expect(back && sameTable(back, t)).toBe(true);
    }
    for (const bad of [
      undefined,
      {},
      [['a', 1]],
      [['a', 1, 'gone']],
      [['a', -1, 'up']],
      [['a', 1.5, 'up']],
      [['a#b', 1, 'up']],
      [[1, 1, 'up']],
      [['a', 1, 'toString']],
      ['a'],
    ]) {
      expect(decodeTable(bad, isAddress), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('compares tables by entries', () => {
    const a = tableOf([{ address: 'a', uid: 1, status: 'up' }]);
    expect(sameTable(a, tableOf([{ address: 'a', uid: 1, status: 'up' }]))).toBe(true);
    expect(sameTable(a, tableOf([{ address: 'a', uid: 1, status: 'down' }]))).toBe(false);
    expect(sameTable(a, tableOf([{ address: 'a', uid: 2, status: 'up' }]))).toBe(false);
    expect(sameTable(a, new Map())).toBe(false);
  });
});
