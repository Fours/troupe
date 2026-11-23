// The shard store contract (milestone 4, T5, decision 0029): what every ShardStore must do. The
// in-memory store runs it in npm test, and the Postgres store in test:integration, so both are
// held to the same rules. Time passes on the store's own clock: the in-memory store's is moved by
// hand, and Postgres's passes in pg_sleep, so expiry is never judged on the test's clock.
import { describe, expect, it } from 'vitest';
import type { ShardStore } from '@kylewillett/troupe/cluster';

/** A fresh, empty store, and a way to let `ms` pass on its clock. */
export interface ContractStore {
  readonly store: ShardStore;
  readonly elapse: (ms: number) => Promise<void>;
}

/** How the contract makes a store for each test. */
export interface ContractBackend {
  create(): Promise<ContractStore>;
  /**
   * The unit of the contract's times, in ms. The in-memory store's clock moves exactly, so 1 will
   * do. Postgres's passes in real time between round trips, so it needs room.
   */
  readonly unitMs: number;
}

export function shardStoreContract(name: string, backend: ContractBackend): void {
  describe(`${name}: shard store contract`, () => {
    // Times in units: a lease lives TTL, and the contract checks it well inside or well past that.
    const u = backend.unitMs;
    const TTL = 10 * u;

    it('acquires a free lease with token 1', async () => {
      const { store } = await backend.create();
      expect(await store.acquire('show/1', 'a#1', TTL)).toEqual({ acquired: true, token: 1 });
      expect(await store.holders('show/')).toEqual([{ lease: 'show/1', holder: 'a#1' }]);
    });

    it('fails on a held lease, and says who holds it', async () => {
      const { store } = await backend.create();
      await store.acquire('show/1', 'a#1', TTL);
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({
        acquired: false,
        holder: 'a#1',
      });
      expect(await store.holders('show/')).toEqual([{ lease: 'show/1', holder: 'a#1' }]);
    });

    it('lets the holder acquire its own live lease again, with the same token, and extends it', async () => {
      const { store, elapse } = await backend.create();
      await store.acquire('show/1', 'a#1', TTL);
      await elapse(6 * u);
      expect(await store.acquire('show/1', 'a#1', TTL)).toEqual({ acquired: true, token: 1 });
      // Past the first TTL, inside the second.
      await elapse(6 * u);
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({
        acquired: false,
        holder: 'a#1',
      });
    });

    it('takes an expired lease with a higher token, for another holder or the same one', async () => {
      const { store, elapse } = await backend.create();
      await store.acquire('show/1', 'a#1', TTL);
      await elapse(TTL + u);
      expect(await store.holders('show/')).toEqual([]);
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({ acquired: true, token: 2 });
      await elapse(TTL + u);
      // The same holder again, but a new ownership: the token still goes up.
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({ acquired: true, token: 3 });
    });

    it('renews every live lease of one holder, and returns their names, sorted', async () => {
      const { store, elapse } = await backend.create();
      await store.acquire('show/2', 'a#1', TTL);
      await store.acquire('show/1', 'a#1', TTL);
      await store.acquire('show/3', 'b#2', TTL);
      await elapse(6 * u);
      expect(await store.renewAll('a#1', TTL)).toEqual(['show/1', 'show/2']);
      // a's leases were renewed past their first TTL. b's wasn't.
      await elapse(6 * u);
      expect(await store.holders('show/')).toEqual([
        { lease: 'show/1', holder: 'a#1' },
        { lease: 'show/2', holder: 'a#1' },
      ]);
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({
        acquired: false,
        holder: 'a#1',
      });
      expect(await store.renewAll('nobody#0', TTL)).toEqual([]);
    });

    it('never renews an expired lease, so a late renewal can’t take it back', async () => {
      const { store, elapse } = await backend.create();
      await store.acquire('show/1', 'a#1', TTL);
      await elapse(TTL + u);
      expect(await store.renewAll('a#1', TTL)).toEqual([]);
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({ acquired: true, token: 2 });
    });

    it('releases a lease only for its holder with its token', async () => {
      const { store } = await backend.create();
      await store.acquire('show/1', 'a#1', TTL);
      await store.release('show/1', 'a#1', 2);
      await store.release('show/1', 'b#2', 1);
      expect(await store.holders('show/')).toEqual([{ lease: 'show/1', holder: 'a#1' }]);

      await store.release('show/1', 'a#1', 1);
      expect(await store.holders('show/')).toEqual([]);
      expect(await store.renewAll('a#1', TTL)).toEqual([]);
      // Released, not forgotten: the next owner's token carries on.
      expect(await store.acquire('show/1', 'b#2', TTL)).toEqual({ acquired: true, token: 2 });
      // The old holder's stale release can't free the new owner's lease.
      await store.release('show/1', 'a#1', 1);
      expect(await store.holders('show/')).toEqual([{ lease: 'show/1', holder: 'b#2' }]);
      // Releasing a lease that never existed does nothing.
      await store.release('show/9', 'a#1', 1);
    });

    it('lists the live holders by prefix, sorted by lease', async () => {
      const { store, elapse } = await backend.create();
      await store.acquire('show/3', 'a#1', TTL);
      await store.acquire('venue/1', 'b#2', TTL);
      await store.acquire('show/1', 'b#2', TTL);
      await store.acquire('shows/1', 'a#1', TTL);
      const { token } = (await store.acquire('show/2', 'a#1', TTL)) as { token: number };
      await store.release('show/2', 'a#1', token);
      expect(await store.holders('show/')).toEqual([
        { lease: 'show/1', holder: 'b#2' },
        { lease: 'show/3', holder: 'a#1' },
      ]);
      expect((await store.holders('')).map((h) => h.lease)).toEqual([
        'show/1',
        'show/3',
        'shows/1',
        'venue/1',
      ]);
      // Prefixes are text, not patterns.
      expect(await store.holders('show_')).toEqual([]);
      expect(await store.holders('%')).toEqual([]);
      await elapse(TTL + u);
      expect(await store.holders('')).toEqual([]);
    });

    it('remembers and forgets entities, per shard', async () => {
      const { store } = await backend.create();
      expect(await store.remembered('show/1')).toEqual([]);
      await store.remember('show/1', 'macbeth');
      await store.remember('show/1', 'hamlet');
      await store.remember('show/1', 'hamlet');
      await store.remember('show/2', 'lear');
      expect(await store.remembered('show/1')).toEqual(['hamlet', 'macbeth']);
      expect(await store.remembered('show/2')).toEqual(['lear']);

      await store.forget('show/1', 'hamlet');
      await store.forget('show/1', 'nobody');
      expect(await store.remembered('show/1')).toEqual(['macbeth']);
      expect(await store.remembered('show/2')).toEqual(['lear']);
    });

    it('rejects bad arguments with TypeError, and changes nothing', async () => {
      const { store } = await backend.create();
      const bad = ['', 7, null, 'a\u0000b', 'lone \ud800'];
      for (const value of bad) {
        await expect(store.acquire(value as string, 'a#1', TTL)).rejects.toThrow(TypeError);
        await expect(store.acquire('show/1', value as string, TTL)).rejects.toThrow(TypeError);
        await expect(store.renewAll(value as string, TTL)).rejects.toThrow(TypeError);
        await expect(store.release(value as string, 'a#1', 1)).rejects.toThrow(TypeError);
        await expect(store.release('show/1', value as string, 1)).rejects.toThrow(TypeError);
        await expect(store.remember(value as string, 'x')).rejects.toThrow(TypeError);
        await expect(store.remember('show/1', value as string)).rejects.toThrow(TypeError);
        await expect(store.forget('show/1', value as string)).rejects.toThrow(TypeError);
        await expect(store.remembered(value as string)).rejects.toThrow(TypeError);
      }
      for (const prefix of [7, null, 'a\u0000']) {
        await expect(store.holders(prefix as string)).rejects.toThrow(TypeError);
      }
      for (const ttl of [0, -1, 1.5, NaN, '10', Infinity]) {
        await expect(store.acquire('show/1', 'a#1', ttl as number)).rejects.toThrow(TypeError);
        await expect(store.renewAll('a#1', ttl as number)).rejects.toThrow(TypeError);
      }
      for (const token of [0, 1.5, '1']) {
        await expect(store.release('show/1', 'a#1', token as number)).rejects.toThrow(TypeError);
      }
      expect(await store.holders('')).toEqual([]);
      expect(await store.remembered('show/1')).toEqual([]);
    });

    it('keeps text exactly, astral characters included', async () => {
      const { store } = await backend.create();
      await store.acquire('show/🎭', 'nöde-1:2552#7', TTL);
      expect(await store.holders('show/🎭')).toEqual([
        { lease: 'show/🎭', holder: 'nöde-1:2552#7' },
      ]);
      await store.remember('show/🎭', 'hamlet-🎭');
      expect(await store.remembered('show/🎭')).toEqual(['hamlet-🎭']);
    });
  });
}
