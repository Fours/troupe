import { afterEach, describe, expect, it, vi } from 'vitest';
import { inMemoryShardStore } from '@kylewillett/troupe/cluster';
import { shardStoreContract } from './shard-store-contract.js';

// Milestone 4, T5: the in-memory shard store (decision 0029).

shardStoreContract('in memory', {
  unitMs: 1,
  create() {
    let time = 1_000;
    const store = inMemoryShardStore({ clock: () => time });
    return Promise.resolve({
      store,
      elapse(ms: number) {
        time += ms;
        return Promise.resolve();
      },
    });
  },
});

describe('inMemoryShardStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws TypeError for invalid options, unknown ones included', () => {
    expect(() => inMemoryShardStore({ clok: () => 1 } as never)).toThrow(
      new TypeError('inMemoryShardStore: unknown option "clok"'),
    );
    expect(() => inMemoryShardStore(null as never)).toThrow(TypeError);
    expect(() => inMemoryShardStore({ clock: 5 } as never)).toThrow(
      new TypeError('inMemoryShardStore: clock must be a function, got 5'),
    );
  });

  it('judges expiry on Date.now by default', async () => {
    let time = 50_000;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    const store = inMemoryShardStore();
    await store.acquire('show/1', 'a#1', 100);
    time += 99;
    expect(await store.acquire('show/1', 'b#2', 100)).toEqual({ acquired: false, holder: 'a#1' });
    time += 1;
    expect(await store.acquire('show/1', 'b#2', 100)).toEqual({ acquired: true, token: 2 });
  });

  it('expires a lease exactly at its TTL on its clock', async () => {
    let time = 0;
    const store = inMemoryShardStore({ clock: () => time });
    await store.acquire('show/1', 'a#1', 100);
    time = 99;
    expect(await store.holders('')).toHaveLength(1);
    time = 100;
    expect(await store.holders('')).toEqual([]);
  });

  it('rejects, and changes nothing, when its clock reads anything but integer ms', async () => {
    let time: number = 10;
    const store = inMemoryShardStore({ clock: () => time });
    time = 1.5;
    await expect(store.acquire('show/1', 'a#1', 100)).rejects.toThrow(TypeError);
    time = 10;
    expect(await store.holders('')).toEqual([]);
  });

  it('answers on a microtask, as a real store answers later', async () => {
    const store = inMemoryShardStore({ clock: () => 0 });
    const order: string[] = [];
    const acquired = store.acquire('show/1', 'a#1', 100).then(() => order.push('acquired'));
    order.push('returned');
    await acquired;
    expect(order).toEqual(['returned', 'acquired']);
  });
});
