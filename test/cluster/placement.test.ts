import { describe, expect, it } from 'vitest';
import { fnv1a, mix32 } from '../../src/hash.js';
import { desiredOwner, score, shardOf } from '../../src/cluster/placement.js';
import { schemaHash } from '../../src/persistence/postgres/pool.js';

// Milestone 4, T6: placement (decision 0030). Pure functions, so every node computes the same
// answer from the same members.

const shards = Array.from({ length: 1_000 }, (_, i) => `show/${String(i)}`);
const three = ['node-1:2552', 'node-2:2552', 'node-3:2552'];
const four = [...three, 'node-4:2552'];

function owners(candidates: readonly string[]): string[] {
  return shards.map((s) => desiredOwner(s, candidates) ?? 'none');
}

describe('the hash', () => {
  it('is FNV-1a, as the Postgres lock key always was', () => {
    // Published FNV-1a test vectors.
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
    expect(schemaHash('foobar')).toBe(0xbf9cf968 | 0);
  });

  it('mixes every bit', () => {
    expect(mix32(0)).toBe(0);
    expect(mix32(1)).not.toBe(mix32(2));
    expect(mix32(0xffffffff)).toBeGreaterThanOrEqual(0);
  });
});

describe('shardOf', () => {
  it('is the id’s hash modulo the shard count, and spreads ids evenly', () => {
    expect(shardOf('hamlet', 64)).toBe(fnv1a('hamlet') % 64);
    const counts = new Array<number>(16).fill(0);
    for (let i = 0; i < 16_000; i++) {
      const s = shardOf(`show-${String(i)}`, 16);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    for (const n of counts) expect(n).toBeGreaterThan(800);
  });
});

describe('desiredOwner', () => {
  it('gives the same owner whatever order the candidates come in', () => {
    const reversed = [...three].reverse();
    expect(owners(reversed)).toEqual(owners(three));
    expect(desiredOwner('show/1', [])).toBeUndefined();
  });

  it('spreads shards about evenly', () => {
    const counts = new Map<string, number>();
    for (const o of owners(three)) counts.set(o, (counts.get(o) ?? 0) + 1);
    for (const address of three) expect(counts.get(address)).toBeGreaterThan(280);
  });

  it('moves only the shards a new node tops, about one in four, all to it', () => {
    const before = owners(three);
    const after = owners(four);
    let moved = 0;
    for (let i = 0; i < shards.length; i++) {
      if (before[i] === after[i]) continue;
      moved++;
      expect(after[i]).toBe('node-4:2552');
      // It moved because node 4 scores highest for it.
      const shard = shards[i] ?? '';
      for (const a of three) expect(score(shard, 'node-4:2552')).toBeGreaterThan(score(shard, a));
    }
    expect(moved).toBeGreaterThan(200);
    expect(moved).toBeLessThan(300);
  });

  it('moves only a leaving node’s own shards', () => {
    const before = owners(four);
    const after = owners(three);
    for (let i = 0; i < shards.length; i++) {
      if (before[i] !== 'node-4:2552') expect(after[i]).toBe(before[i]);
    }
  });
});
