// Festival night, rehearsed (milestone 5, T5): the shows festival night runs, on three nodes, a
// spare that can join, and a crowd, under faults drawn from each seed. The crowd buys seats, a
// hold then its confirm, and asks shows how many they've sold, and every run is checked against
// the built-in invariants. No React and no real time, so the tests, `npm run rehearse` and the
// site's /rehearsal/ page all run the same scenario.
import { supervise } from '@kylewillett/troupe';
import {
  invariants,
  scenario,
  type FaultOptions,
  type Invariant,
  type NetworkMode,
  type Scenario,
  type ScenarioOptions,
} from '@kylewillett/troupe/rehearsal';
import {
  show,
  SHOW_BACKOFF,
  showId,
  type ConfirmReply,
  type HoldReply,
  type ShowMsg,
  type StatusReply,
} from '../../domain/shows.ts';
import {
  CLUSTER,
  CROWD,
  LEASES,
  MEMBERSHIP,
  REBALANCE_MS,
  SHARD_COUNT,
  SHOW_TYPE,
} from '../../festival/domain/festival-night.ts';
import { SHOW_IDS } from '../../festival/domain/lineup.ts';

/** The hosts that start at once. */
export const NODES: readonly string[] = ['node-1', 'node-2', 'node-3'];

/** A host that starts only when a plan joins it, so joins hand shards off as leaves do. */
export const SPARES: readonly string[] = ['node-4'];

/** Seats per show: more than any run sells, so a buy fails only if something went wrong. */
export const CAPACITY = 1_000_000;

/** How long a run lasts, in ms of simulation time: a minute, the last 20 s with no faults. */
export const DURATION_MS = 60_000;

/** How long an ask waits for a show. */
const ASK_MS = 3_000;

/** What a buy answers: the hold's refusal, or the confirm's reply. */
export type BuyReply = HoldReply | ConfirmReply;

/**
 * How far a reply shows its show had got: a confirmed buy's seats sold once it was in, or what a
 * status saw. `undefined` for anything else, such as a refused hold.
 */
export function soldIn(reply: unknown): number | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined;
  const r = reply as { ok?: unknown; sold?: unknown; kind?: unknown };
  if (r.ok !== true || typeof r.sold !== 'number') return undefined;
  return r.kind === undefined || r.kind === 'confirm' ? r.sold : undefined;
}

/**
 * The invariants for a mode. At-most-once delivery and order per pair rest on the Transport
 * contract, so chaos mode, which breaks it, checks only the rest (decision 0035).
 */
export function festivalInvariants(mode: NetworkMode): Invariant[] {
  const list = [
    invariants.oneLiveInstance(),
    invariants.acknowledgedWritesKept({
      write: 'buy',
      // A refused hold or confirm acknowledged nothing.
      acknowledged: (reply) => soldIn(reply) !== undefined,
      // A buy is kept if its show's journal confirms the hold it confirmed.
      kept: (write, journal) => {
        const confirm = write.messages[1] as { holdId?: unknown } | undefined;
        return journal.some(
          (e) =>
            e.persistenceId === showId(write.entity.id) &&
            (e.event as { type?: unknown; holdId?: unknown }).type === 'confirmed' &&
            (e.event as { holdId?: unknown }).holdId === confirm?.holdId,
        );
      },
    }),
    invariants.noStaleReads({ read: 'status', write: 'buy', position: soldIn }),
    invariants.recovers({ withinMs: 20_000 }),
    invariants.failoverWithin(),
  ];
  if (mode === 'contract') list.push(invariants.atMostOnce(), invariants.orderPerPair());
  return list;
}

/**
 * The fault mixes the hunt (T7) varies: `all`, every kind at the default rate; `nodes`, kills,
 * pauses, leaves and joins with disk faults; `network`, the network's faults alone; `clocks`,
 * drift and the database's clock jumping, with disk faults; and `heavy`, every kind at twice the
 * rate, three at once.
 */
export const MIXES = ['all', 'nodes', 'network', 'clocks', 'heavy'] as const;

/** One of {@link MIXES}. */
export type Mix = (typeof MIXES)[number];

/** Whether `name` is a mix's. */
export function isMix(name: unknown): name is Mix {
  return (MIXES as readonly unknown[]).includes(name);
}

const NODE_FAULTS = ['kill', 'pause', 'leave', 'join'] as const;
const DISK_FAULTS = ['slow', 'hang', 'error', 'lostReplies', 'cut'] as const;

/** The faults `mix` draws, with the network in `mode`. */
export function faultsOf(mode: NetworkMode, mix: Mix): FaultOptions {
  switch (mix) {
    case 'all':
      return { nodes: true, clocks: true, network: mode, disks: true };
    case 'nodes':
      return { only: [...NODE_FAULTS, ...DISK_FAULTS], network: mode };
    case 'network':
      return {
        only: [
          'partition',
          'reset',
          'delay',
          'reorder',
          ...(mode === 'chaos' ? (['lose', 'duplicate'] as const) : []),
        ],
        network: mode,
      };
    case 'clocks':
      return { only: ['drift', 'jump', ...DISK_FAULTS], network: mode };
    case 'heavy':
      return {
        nodes: true,
        clocks: true,
        network: mode,
        disks: true,
        perMinute: 12,
        concurrent: 3,
      };
  }
}

/** Festival night's scenario, with the network in `mode`, drawing faults from `mix`. */
export function festival(opts: { readonly mode?: NetworkMode; readonly mix?: Mix } = {}): Scenario {
  return scenario(festivalOptions(opts.mode ?? 'contract', opts.mix ?? 'all'));
}

/**
 * Festival night's scenario options, with the network in `mode` and faults from `mix`: for the
 * tests and `npm run rehearse`, which plant bugs in it through the package's internals.
 */
export function festivalOptions(mode: NetworkMode, mix: Mix = 'all'): ScenarioOptions {
  return {
    nodes: NODES,
    spares: SPARES,
    clients: [CROWD],
    durationMs: DURATION_MS,
    cluster: { name: CLUSTER, ...MEMBERSHIP, leases: LEASES },
    setup: ({ cluster, db, client }) =>
      cluster.sharding.init<ShowMsg, unknown>({
        type: SHOW_TYPE,
        entity: (id) => show(id, CAPACITY, db.persistence()),
        shardCount: SHARD_COUNT,
        supervision: supervise.restartWithBackoff(SHOW_BACKOFF),
        host: !client,
        rebalanceMs: REBALANCE_MS,
        remember: true,
      }),
    workload: ({ op, chance, entity }) => {
      const id = chance.pick(SHOW_IDS);
      const ref = entity<ShowMsg>(SHOW_TYPE, id);
      if (chance.next() < 0.25) {
        op('status', ref, (show) =>
          show.ask<StatusReply>((replyTo) => ({ type: 'status', show: id, replyTo }), {
            timeoutMs: ASK_MS,
          }),
        );
        return;
      }
      const customer = `fan-${String(chance.int(1, 1_000_000))}`;
      op('buy', ref, async (show): Promise<BuyReply> => {
        const held = await show.ask<HoldReply>(
          (replyTo) => ({ type: 'hold', show: id, customer, seats: 1, replyTo }),
          { timeoutMs: ASK_MS },
        );
        if (!held.ok) return held;
        return show.ask<ConfirmReply>(
          (replyTo) => ({ type: 'confirm', show: id, holdId: held.holdId, replyTo }),
          { timeoutMs: ASK_MS },
        );
      });
    },
    faults: faultsOf(mode, mix),
    invariants: festivalInvariants(mode),
  };
}
