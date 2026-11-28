// The planted bugs (milestone 5, T6): bugs put back one at a time, to prove each invariant catches
// what it's there for, from random seeds and without being told where to look. Each is a one-line
// change in the code it names, made only where a scenario's internals plant it, so nothing public
// can reach one. Milestone 4 found most of them by hand.

import type { ShardStore } from '../cluster/shard-store.js';
import type { Plant } from '../internal.js';
import type { FaultOptions } from './plan.js';
import type { ScenarioCluster, ScenarioOptions } from './scenario.js';

/** One planted bug: its name, what it does, and the invariants expected to catch it. */
export interface PlantedBug {
  readonly name: Plant;
  readonly what: string;
  readonly caughtBy: readonly string[];
  /**
   * The fault mix its hunt draws from, in place of the scenario's, for a bug only a rare
   * combination of faults shows. The network's mode stays the scenario's.
   */
  readonly faults?: Omit<FaultOptions, 'network'>;
  /** Membership timings its hunt uses in place of the scenario's, merged over them. */
  readonly cluster?: Omit<ScenarioCluster, 'name'>;
  /**
   * Why a later fix made the bug harmless, so its hunt is expected to find nothing: the code now
   * tolerates it, and its test shows the bug still fires and breaks no invariant (T7).
   */
  readonly tolerated?: string;
}

/** Every planted bug, in the spec's order. */
export const PLANTED: readonly PlantedBug[] = [
  {
    name: 'late-deadline',
    what: "the holder notes its deadline after the renewal returns, not before it's sent",
    caughtBy: ['oneLiveInstance'],
    // A renewal in flight when its node pauses, which a slow disk makes likely. Downing waits
    // past the run: since 0042, a holder cut off from the others downs itself and exits, which
    // ends its shards before a stretched deadline could overlap the next owner. And the margin is
    // 250 ms: the bug stretches a deadline by the renewal's round trip, which the store timeout
    // caps, so it overlaps the next owner only when the reply alone takes longer than the margin.
    // Festival's margin equals its store timeout, and 200,000 seeds didn't find it there (T7).
    faults: { only: ['slow', 'cut', 'partition'], perMinute: 30, concurrent: 3 },
    cluster: { downAfterMs: 60_000, leases: { marginMs: 250 } },
  },
  {
    name: 'early-release',
    what: 'a handoff releases the lease before its entities stop',
    caughtBy: ['oneLiveInstance'],
  },
  {
    name: 'grants-held',
    what: "the store grants a lease that's still held",
    caughtBy: ['oneLiveInstance', 'acknowledgedWritesKept'],
  },
  {
    name: 'greets-once',
    what: 'a region greets each member only once',
    caughtBy: ['recovers'],
    // New incarnations, and resets that lose the hellos between them. Since members greet the
    // seeds they lack (0042), festival's own mix took 36,233 seeds to lose a hello both ways (T7).
    faults: { only: ['kill', 'join', 'leave', 'reset'], perMinute: 30, concurrent: 3 },
  },
  {
    name: 'routes-unreachable',
    what: "a region routes to a holder it can't reach",
    caughtBy: ['failoverWithin'],
    // joinCluster's own timings, which down a node after about 15 s. Festival downs one in 4.5 s,
    // faster than its leases fail over, so routing to a holder it can't reach costs nothing there.
    cluster: { heartbeatMs: 1_000, unreachableAfterMs: 5_000, downAfterMs: 10_000 },
  },
  {
    name: 'gossip-backwards',
    what: 'gossip merge lets a status go backwards',
    caughtBy: ['recovers'],
    tolerated:
      'since keep-the-majority (0042), a member whose status goes backwards is unreachable, and is downed again before recovery is checked (0043)',
  },
  {
    name: 'early-reply',
    what: 'a persistent actor replies before its append settles',
    caughtBy: ['acknowledgedWritesKept'],
  },
];

const NAMES = new Set<string>(PLANTED.map((p) => p.name));

/** The planted bug called `name`. */
export function planted(name: Plant): PlantedBug {
  // Every Plant has a row: a test checks the two lists match.
  return PLANTED.find((p) => p.name === name) as PlantedBug;
}

/**
 * `options` as the hunt for `bug` runs them: its fault mix and membership timings in place of the
 * scenario's, where its row has its own. The network's mode stays the scenario's.
 */
export function huntOptions(options: ScenarioOptions, bug: Plant): ScenarioOptions {
  const row = planted(bug);
  const mode = options.faults?.network ?? false;
  return {
    ...options,
    ...(row.faults === undefined ? {} : { faults: { ...row.faults, network: mode } }),
    ...(row.cluster === undefined
      ? {}
      : {
          cluster: {
            ...options.cluster,
            ...row.cluster,
            leases: { ...options.cluster?.leases, ...row.cluster.leases },
          },
        }),
  };
}

/** Whether `name` is a planted bug's. */
export function isPlant(name: unknown): name is Plant {
  return typeof name === 'string' && NAMES.has(name);
}

/** A store that grants every lease, held or not: the bug milestone 4's T6 found by hand. */
export function grantsHeldLeases(store: ShardStore): ShardStore {
  return {
    ...store,
    acquire: async (lease, holder, ttlMs) => {
      const result = await store.acquire(lease, holder, ttlMs);
      return result.acquired ? result : { acquired: true, token: 1_000_000 };
    },
  };
}
