import type { NewSnapshot, SnapshotStore } from '../../src/persistence/types.js';
import { deferred, type Deferred } from './deferred.js';

/** A save the test holds in flight: it reaches the store only once released. */
export interface HeldSave {
  /** Resolves when the save is called. */
  readonly reached: Promise<void>;
  /** Lets the save through to the store. */
  release(): void;
}

/** A snapshot store that fails or holds calls on request, for persistent actor tests. */
export interface FaultySnapshots extends SnapshotStore {
  /** Every save that reached the store, in order, whether it failed or not. */
  readonly saves: readonly NewSnapshot[];
  /** How many loads reached the store. */
  readonly loads: number;
  /** Makes the next `count` saves reject with `error`, saving nothing. */
  failSaves(error: unknown, count?: number): void;
  /** Makes the next `count` loads reject with `error`. */
  failLoads(error: unknown, count?: number): void;
  /** Holds the next save until the test releases it. */
  holdNextSave(): HeldSave;
}

/** Wraps `inner`, passing every call through unless a fault is armed. */
export function faultySnapshots(inner: SnapshotStore): FaultySnapshots {
  const saves: NewSnapshot[] = [];
  const saveFaults: unknown[] = [];
  const loadFaults: unknown[] = [];
  const holds: { reached: Deferred<void>; released: Deferred<void> }[] = [];
  let loads = 0;

  return {
    saves,
    get loads() {
      return loads;
    },
    async save(persistenceId, snapshot) {
      saves.push(snapshot);
      const hold = holds.shift();
      if (hold !== undefined) {
        hold.reached.resolve();
        await hold.released.promise;
      }
      if (saveFaults.length > 0) throw saveFaults.shift();
      await inner.save(persistenceId, snapshot);
    },
    async load(persistenceId) {
      loads++;
      if (loadFaults.length > 0) {
        await Promise.resolve();
        throw loadFaults.shift();
      }
      return inner.load(persistenceId);
    },
    failSaves(error, count = 1) {
      for (let i = 0; i < count; i++) saveFaults.push(error);
    },
    failLoads(error, count = 1) {
      for (let i = 0; i < count; i++) loadFaults.push(error);
    },
    holdNextSave() {
      const hold = { reached: deferred(), released: deferred() };
      holds.push(hold);
      return {
        reached: hold.reached.promise,
        release: () => {
          hold.released.resolve();
        },
      };
    },
  };
}
