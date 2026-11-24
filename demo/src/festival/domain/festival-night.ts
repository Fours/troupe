// Festival night: opening night's box office as a cluster, in one page. Three nodes host the
// shows, and a fourth, the crowd's, only routes to them. Every node is a whole actor system, on
// one in-memory network, one journal and one shard store, all on one ManualScheduler driven from
// animation frames (decision 0022), so the same seed and the same presses tell the same story.
import {
  createActorSystem,
  supervise,
  type ActorRef,
  type ActorSystem,
  type Logger,
  type SystemEvent,
} from '@kylewillett/troupe';
import {
  inMemoryNetwork,
  inMemoryShardStore,
  joinCluster,
  type Cluster,
  type EntityType,
  type ShardStore,
} from '@kylewillett/troupe/cluster';
import { inMemoryPersistence, type Persistence } from '@kylewillett/troupe/persistence';
import { ManualScheduler, seededRandom } from '@kylewillett/troupe/testkit';
import { DrivenClock, type Speed } from '../../domain/clock.ts';
import { crowd, RUSH_SIZE, type CrowdMsg } from '../../domain/crowd.ts';
import { salesBoard, type BoardMsg } from '../../domain/sales-board.ts';
import {
  SHOW_BACKOFF,
  type CustomerRequest,
  type ShowMsg,
  type StatusReply,
} from '../../domain/shows.ts';
import { festivalOffice, SHOW_IDS, showEntity } from './lineup.ts';

/** The cluster's name. */
export const CLUSTER = 'festival-night';

/** The nodes that host shows when the night starts, which are also the seeds. */
export const SEEDS: readonly string[] = ['node-1', 'node-2', 'node-3'];

/** Every address a hosting node can have: *Add a node* takes the next unused one. */
export const HOSTS: readonly string[] = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];

/** The crowd's node, which hosts no shows and only routes to them. */
export const CROWD = 'crowd';

/** The shows' entity type. */
export const SHOW_TYPE = 'show';

/**
 * How many shards the shows are spread over. With these addresses, 32 puts the twelve shows two,
 * five and five on the first three nodes, and a fourth node takes seven, so every button moves
 * something you can see. Placement depends only on the addresses and the count (decision 0030).
 */
export const SHARD_COUNT = 32;

/**
 * Membership's timings, scaled down from the defaults so a failover takes a few seconds at 1×:
 * a node that stops answering is unreachable after 1.5 s, and down 3 s after that.
 */
export const MEMBERSHIP = {
  heartbeatMs: 500,
  unreachableAfterMs: 1_500,
  downAfterMs: 3_000,
  seedTimeoutMs: 1_000,
} as const;

/**
 * Lease timings, scaled down too: a killed node's shards can be taken 4 s after its last renewal,
 * which is what a failover waits for (decision 0031).
 */
export const LEASES = { ttlMs: 4_000, renewMs: 1_000, marginMs: 1_000 } as const;

/** How often a node looks for shards that belong elsewhere, such as on a node that just joined. */
export const REBALANCE_MS = 1_000;

/** Where a node is in its life, as the page shows it. */
export type NodeState = 'joining' | 'up' | 'leaving' | 'left' | 'killed';

/** One incarnation of one node. */
export interface FestivalNode {
  /** Its address on the network, such as `node-2`, which a restart keeps. */
  readonly address: string;
  /** 1 for the address's first start, then one more for each restart. */
  readonly incarnation: number;
  /** Whether it hosts shows: every node but the crowd's. */
  readonly hosts: boolean;
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  /** Where it is now. Read it again after a change: it isn't kept up to date in a copy. */
  readonly state: NodeState;
}

/** A button press, as the page's log tells it. */
export type Press = 'kill' | 'restart' | 'add' | 'leave' | 'rush';

/** What a listener hears: an event on one node, or a press. */
export type FestivalEvent =
  | {
      readonly kind: 'event';
      readonly node: FestivalNode;
      readonly event: SystemEvent;
    }
  | {
      readonly kind: 'press';
      readonly at: number;
      readonly press: Press;
      /** The node pressed on, for every press but a rush. */
      readonly address?: string;
    };

/** Options for {@link festivalNight}. */
export interface FestivalNightOptions {
  /** Resolves after one turn of the event loop (see `DrivenClockOptions`). */
  readonly yieldToEventLoop: () => Promise<void>;
  /** The seed for every chance in the story. Default 1. */
  readonly seed?: number;
  /** Whether customers arrive on their own. Default true. */
  readonly arrivals?: boolean;
  /** The speed to start at. Default 1. */
  readonly speed?: Speed;
  /** Where the systems log. Default: nowhere, since the page tells the story from events. */
  readonly logger?: Logger;
}

/** Festival night, running. */
export interface FestivalNight {
  readonly clock: DrivenClock;
  /** The journal every node shares, as nodes in a real cluster share Postgres. */
  readonly persistence: Persistence;
  /** Resolves once the crowd's actors have spawned. */
  readonly started: Promise<void>;
  /** The crowd's node. */
  readonly crowd: FestivalNode;
  /** The latest incarnation of every hosting address used so far, in address order. */
  hosts(): readonly FestivalNode[];
  /** The latest incarnation at `address`, if it has started. */
  node(address: string): FestivalNode | undefined;
  /**
   * Calls `listener` with every event of every live node, and every press. Message events only
   * from the crowd's node. A killed node's events stop at once, as they would with `kill -9`.
   */
  subscribe(listener: (event: FestivalEvent) => void): () => void;
  /**
   * Calls `listener` with every node now, and with each new incarnation as it starts, before it
   * joins the cluster, so an inspector attached to it sees every spawn.
   */
  onNode(listener: (node: FestivalNode) => void): () => void;
  /** Calls `listener` whenever a node's state changes. */
  onChange(listener: () => void): () => void;
  // The buttons. Each runs in the clock's next turn, and resolves once it has.
  /** Kills the node as `kill -9` would: it vanishes from the network and the shard store. */
  kill(address: string): Promise<void>;
  /** Starts a killed or departed node again, at the same address, as a new incarnation. */
  restart(address: string): Promise<void>;
  /** Starts the next unused hosting address. Resolves with it, or `undefined` past five. */
  add(): Promise<string | undefined>;
  /** Leaves gracefully: the node hands its shards off, then stops. Resolves once it has begun. */
  leave(address: string): Promise<void>;
  /** Sends {@link RUSH_SIZE} customers at once. */
  rush(): Promise<void>;
  /** Asks a show for its seats, through the crowd's box office. Answered as time passes. */
  status(show: string, timeoutMs?: number): Promise<StatusReply>;
  /** Asks the sales board for seats sold per show. Answered as time passes. */
  totals(): Promise<Readonly<Record<string, number>>>;
  /** Stops every node at once, with no handoffs. */
  dispose(): Promise<void>;
}

const QUIET: Logger = { debug() {}, info() {}, warn() {}, error() {} };

// Every node, incarnation and use gets its own stream of chance, all from the one seed.
const streamSeed = (seed: number, node: number, incarnation: number, stream: number): number =>
  seed * 10_000 + node * 100 + incarnation * 10 + stream;

interface NodeRecord extends FestivalNode {
  state: NodeState;
  /** Whether it can reach the shard store. A kill cuts it off, so it can't release its leases. */
  reaches: boolean;
  /** Whether its events reach listeners: false from the moment it's killed. */
  heard: boolean;
  readonly shows: EntityType<ShowMsg>;
}

interface Cast {
  readonly office: ActorRef<CustomerRequest>;
  readonly crowd: ActorRef<CrowdMsg>;
  readonly board: ActorRef<BoardMsg>;
}

/**
 * Starts festival night on a {@link ManualScheduler}: three hosting nodes and the crowd's. Nothing
 * runs until the clock moves.
 */
export function festivalNight(opts: FestivalNightOptions): FestivalNight {
  const { seed = 1, arrivals = true, logger = QUIET } = opts;
  const scheduler = new ManualScheduler();
  const clock = new DrivenClock({
    scheduler,
    yieldToEventLoop: opts.yieldToEventLoop,
    speed: opts.speed ?? 1,
  });
  const now = () => scheduler.now();
  const network = inMemoryNetwork({ scheduler });
  const store = inMemoryShardStore({ clock: now });
  const persistence = inMemoryPersistence({ clock: now });
  const listeners = new Set<(event: FestivalEvent) => void>();
  const watchers = new Set<(node: FestivalNode) => void>();
  const changeListeners = new Set<() => void>();
  const nodes = new Map<string, NodeRecord>();

  const emit = (event: FestivalEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const changed = (): void => {
    for (const listener of changeListeners) listener();
  };
  const setState = (record: NodeRecord, state: NodeState): void => {
    if (record.state === state) return;
    record.state = state;
    changed();
  };

  const start = (address: string): NodeRecord => {
    const hosts = address !== CROWD;
    const incarnation = (nodes.get(address)?.incarnation ?? 0) + 1;
    const index = hosts ? HOSTS.indexOf(address) + 1 : 0;
    const system = createActorSystem({
      name: address,
      scheduler,
      random: seededRandom(streamSeed(seed, index, incarnation, 0)),
      logger,
    });
    // Filled in below. The record exists first, so the store's gate and the event stream can
    // read it from the start.
    const record = { address, incarnation, hosts, system, state: 'joining' } as NodeRecord;
    record.reaches = true;
    record.heard = true;
    system.events.subscribe(
      (event) => {
        if (record.heard) emit({ kind: 'event', node: record, event });
      },
      hosts ? undefined : { messages: true },
    );
    nodes.set(address, record);
    for (const watcher of watchers) watcher(record);
    const cluster = joinCluster(system, {
      name: CLUSTER,
      transport: network.transport(address),
      seeds: SEEDS,
      ...MEMBERSHIP,
      shards: gate(store, () => record.reaches),
      leases: LEASES,
    });
    const shows = cluster.sharding.init<ShowMsg, unknown>({
      type: SHOW_TYPE,
      entity: showEntity(persistence),
      shardCount: SHARD_COUNT,
      supervision: supervise.restartWithBackoff(SHOW_BACKOFF),
      host: hosts,
      rebalanceMs: REBALANCE_MS,
      // A shard that lands on a node starts its shows at once, so a show that fails over or moves
      // is back, with its journal, before its next customer arrives.
      remember: true,
    });
    Object.assign(record, { cluster, shows });
    cluster.whenUp.then(
      () => {
        if (record.state === 'joining') setState(record, 'up');
      },
      () => undefined,
    );
    changed();
    return record;
  };

  const crowdNode = start(CROWD);
  for (const address of SEEDS) start(address);

  const cast = (): Cast => {
    const { system, shows } = crowdNode;
    const office = system.spawn(festivalOffice(shows), 'box-office');
    const board = system.spawn(salesBoard(persistence), 'sales-board');
    const people = system.spawn(
      crowd({
        office,
        shows: SHOW_IDS,
        random: seededRandom(streamSeed(seed, 0, 1, 1)),
        arrivals,
      }),
      'crowd',
    );
    // Opening the doors: every show starts on its node at once, rather than on its first customer.
    for (const show of SHOW_IDS) {
      office
        .ask<StatusReply>((replyTo) => ({ type: 'status', show, replyTo }), { timeoutMs: 10_000 })
        .catch(() => undefined);
    }
    return { office, crowd: people, board };
  };

  let actors: Cast | undefined;
  const started = clock.run(() => {
    actors = cast();
    return Promise.resolve();
  });
  const press = <T>(task: (cast: Cast) => T): Promise<T> =>
    clock.run(() => {
      if (actors === undefined) throw new Error('festival night has not started');
      return Promise.resolve(task(actors));
    });
  const query = <T>(ask: (cast: Cast) => Promise<T>): Promise<T> =>
    press((c) => ({ answer: ask(c) })).then(({ answer }) => answer);
  const live = (address: string): NodeRecord | undefined => {
    const record = nodes.get(address);
    return record?.hosts === true && (record.state === 'joining' || record.state === 'up')
      ? record
      : undefined;
  };

  const killNode = (record: NodeRecord): void => {
    record.heard = false;
    record.reaches = false;
    network.kill(record.address);
    setState(record, 'killed');
    // Its actors stop in the background. It can't reach the store or the network, so it can't
    // release a lease or hand anything off: the others wait for its leases to expire.
    record.system.terminate().catch(() => undefined);
  };

  return {
    clock,
    persistence,
    started,
    crowd: crowdNode,
    hosts: () => HOSTS.flatMap((a) => nodes.get(a) ?? []),
    node: (address) => nodes.get(address),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onNode(listener) {
      watchers.add(listener);
      for (const record of nodes.values()) listener(record);
      return () => {
        watchers.delete(listener);
      };
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    kill: (address) =>
      press(() => {
        const record = live(address);
        if (record === undefined) return;
        emit({ kind: 'press', at: now(), press: 'kill', address });
        killNode(record);
      }),
    restart: (address) =>
      press(() => {
        const record = nodes.get(address);
        if (record?.hosts !== true || (record.state !== 'killed' && record.state !== 'left')) {
          return;
        }
        emit({ kind: 'press', at: now(), press: 'restart', address });
        start(address);
      }),
    add: () =>
      press(() => {
        const address = HOSTS.find((a) => !nodes.has(a));
        if (address === undefined) return undefined;
        emit({ kind: 'press', at: now(), press: 'add', address });
        start(address);
        return address;
      }),
    leave: (address) =>
      press(() => {
        const record = live(address);
        if (record === undefined) return;
        emit({ kind: 'press', at: now(), press: 'leave', address });
        setState(record, 'leaving');
        record.cluster
          .leave()
          .then(() => record.system.terminate())
          .then(
            () => {
              setState(record, 'left');
            },
            () => {
              setState(record, 'left');
            },
          );
      }),
    rush: () =>
      press(({ crowd: people }) => {
        emit({ kind: 'press', at: now(), press: 'rush' });
        people.tell({ type: 'rush', count: RUSH_SIZE });
      }),
    status: (show, timeoutMs = 5_000) =>
      query(({ office }) =>
        office.ask<StatusReply>((replyTo) => ({ type: 'status', show, replyTo }), { timeoutMs }),
      ),
    totals: () => query(({ board }) => board.ask((replyTo) => ({ type: 'totals', replyTo }))),
    dispose: () =>
      clock.run(() => {
        for (const record of nodes.values()) {
          if (record.state !== 'killed' && record.state !== 'left') killNode(record);
        }
        listeners.clear();
        return Promise.resolve();
      }),
  };
}

/** `store`, as one node reaches it: every call fails once `reaches` says it can't. */
function gate(store: ShardStore, reaches: () => boolean): ShardStore {
  const cut =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      reaches() ? call(...args) : Promise.reject(new Error('this node cannot reach the store'));
  return {
    acquire: cut(store.acquire.bind(store)),
    renewAll: cut(store.renewAll.bind(store)),
    release: cut(store.release.bind(store)),
    holders: cut(store.holders.bind(store)),
    remember: cut(store.remember.bind(store)),
    forget: cut(store.forget.bind(store)),
    remembered: cut(store.remembered.bind(store)),
  };
}
