// Membership (decision 0028): who is in the cluster, gossiped with no leader. It answers where to
// send a message and, from T6, where a shard should live. It never decides who owns a shard:
// that's the lease's job, so downing a node that's still running can't make a second owner.
//
// Every node heartbeats every other member each `heartbeatMs`, and on the same tick sends its
// whole table to one member chosen by the system's random. A member this node hasn't heard for
// `unreachableAfterMs` is unreachable, in this node's view only, and one that stays unreachable
// for `downAfterMs` is downed, which is gossiped. Membership's frames are remoting's control
// frames, sent only on an open connection, so none waits in a buffer to arrive stale.

import { checkInt, checkKeys, describe } from '../checks.js';
import type { EventBody } from '../events.js';
import { hooksOf, plantOf, type Plant, type SystemHooks } from '../internal.js';
import type { ActorSystem } from '../types.js';
import { isTransport, startRemoting, type PeerId, type Remoting } from './remoting.js';
import type { ShardStore } from './shard-store.js';
import {
  checkLeases,
  isShardStore,
  startSharding,
  type ShardingNode,
  type LeaseOptions,
  type Sharding,
} from './sharding.js';
import {
  advance,
  decodeTable,
  encodeTable,
  isAfter,
  keyOf,
  merge,
  sameTable,
  tableOf,
  type Entry,
  type Status,
  type Table,
} from './table.js';
import type { Transport } from './transport.js';
import { ADDRESS, CLUSTER_NAME } from './wire.js';

/** Options for {@link joinCluster}. Every interval is in integer milliseconds. */
export interface ClusterOptions {
  /** The cluster's name, which every node shares: lower-case letters, digits and `-`. */
  name: string;
  /** How this node reaches the others. Its `address` is this node's. */
  transport: Transport;
  /**
   * The addresses a node joins through. Only the first may form a cluster on its own, so two
   * halves can't each form one at start-up. Every node should have the same list.
   */
  seeds: readonly string[];
  /** How often this node heartbeats every other member, and gossips to one. Default 1,000. */
  heartbeatMs?: number;
  /** How long a member can go unheard before it's unreachable. Default 5,000. */
  unreachableAfterMs?: number;
  /** How long a member can stay unreachable before it's downed. Default 10,000. */
  downAfterMs?: number;
  /**
   * How long the first seed tries the others before it forms a cluster on its own. Default
   * 5,000. A node whose seeds are only itself forms one at once.
   */
  seedTimeoutMs?: number;
  /** How many messages wait for a node that has no connection. Default 10,000. */
  bufferSize?: number;
  /** The largest frame this node sends, in UTF-8 bytes. Default 1 MiB. */
  maxFrameBytes?: number;
  /**
   * Where shard leases live (decision 0029), shared by every node: `postgresShardStore` from
   * `/cluster/postgres`, or `inMemoryShardStore` for nodes in one process. Needed for sharding.
   */
  shards?: ShardStore;
  /** How this node times its shard leases. Every node should use the same. */
  leases?: LeaseOptions;
}

/** One incarnation of a node, as this node sees it. */
export interface Member {
  /** The address other nodes reach it at. */
  readonly address: string;
  /** Its uid, new on every start, so a restarted node is a new member. */
  readonly uid: number;
  /** `up`, `leaving` gracefully, or `down`: unreachable too long, by this node's or another's view. */
  readonly status: 'up' | 'leaving' | 'down';
  /** Whether this node hears its heartbeats. Each node's own view, never gossiped. */
  readonly reachable: boolean;
}

/** This node's place in a cluster. */
export interface Cluster {
  /** This node: its address, as other nodes reach it, and its uid, new on every start. */
  readonly self: { readonly address: string; readonly uid: number };
  /**
   * The members as this node sees them, itself included, sorted by address: empty until it's in
   * the cluster. A member that left is gone. One that was downed stays, as `down`, until a new
   * incarnation at its address replaces it.
   */
  members(): readonly Member[];
  /**
   * Resolves once this node is in the cluster: a member that was up let it in, or it formed the
   * cluster as the first seed. Rejects if the node leaves, is downed or terminates first.
   */
  readonly whenUp: Promise<void>;
  /** Entity types, and refs to their entities (decision 0030). */
  readonly sharding: Sharding;
  /**
   * Tells the others this node is leaving, hands each shard it holds off to its next owner,
   * then tells them it has left and closes its connections. A shard's entities finish what they
   * have first, a persist included, and messages that arrive meanwhile follow the shard. A shard
   * no other node hosts is stopped, and its lease released. Resolves once the node has left.
   * `system.terminate()` does the same, once everything under `/user` has stopped. Calling it
   * again returns the same promise.
   */
  leave(): Promise<void>;
}

/** What tests can set that users can't. */
export interface ClusterInternals {
  /** How long a tombstone stays in the table before it's pruned. Default 24 hours, as Akka's. */
  pruneAfterMs?: number;
}

/** A cluster, and the remoting under it, for the package's own code and tests. */
export interface ClusterHandle {
  readonly cluster: Cluster;
  readonly remoting: Remoting;
}

const OPTIONS = new Set([
  'name',
  'transport',
  'seeds',
  'heartbeatMs',
  'unreachableAfterMs',
  'downAfterMs',
  'seedTimeoutMs',
  'bufferSize',
  'maxFrameBytes',
  'shards',
  'leases',
]);
const DAY_MS = 86_400_000;
const joined = new WeakSet<ActorSystem>();

/**
 * Joins `system` to a cluster: listens on the transport, joins through a seed, and keeps the
 * member table from then on. Returns at once: `whenUp` says when the node is in.
 * @throws TypeError for options that can't be used, unknown ones included, or a system that
 * wasn't made by `createActorSystem`.
 * @throws Error if the system is already in a cluster.
 */
export function joinCluster(system: ActorSystem, opts: ClusterOptions): Cluster {
  return startCluster(system, opts).cluster;
}

/** {@link joinCluster}, with the remoting underneath and the options only tests set. */
export function startCluster(
  system: ActorSystem,
  opts: ClusterOptions,
  internals: ClusterInternals = {},
): ClusterHandle {
  const checked = checkOptions(opts);
  const hooks = hooksOf(system);
  if (joined.has(system)) throw new Error('joinCluster: this system is already in a cluster');
  const { pruneAfterMs = DAY_MS } = internals;
  checkInt(pruneAfterMs, 'joinCluster: pruneAfterMs');
  const remoting = startRemoting(system, {
    cluster: checked.name,
    transport: checked.transport,
    bufferSize: checked.bufferSize,
    maxFrameBytes: checked.maxFrameBytes,
    closeWithSystem: false,
  });
  joined.add(system);
  const membership = new Membership(system, hooks, remoting, checked, pruneAfterMs);
  return { cluster: membership.api, remoting };
}

type Checked = Required<Omit<ClusterOptions, 'shards'>> & {
  readonly shards: ShardStore | undefined;
  readonly leases: Required<LeaseOptions>;
};

function checkOptions(opts: ClusterOptions): Checked {
  checkKeys(opts, OPTIONS, 'joinCluster');
  const {
    name,
    transport,
    seeds,
    heartbeatMs = 1_000,
    unreachableAfterMs = 5_000,
    downAfterMs = 10_000,
    seedTimeoutMs = 5_000,
    bufferSize = 10_000,
    maxFrameBytes = 1_048_576,
    shards,
    leases,
  } = opts;
  if (typeof name !== 'string' || !CLUSTER_NAME.test(name)) {
    throw new TypeError(
      `joinCluster: name must be lower-case letters, digits and "-", got ${describe(name)}`,
    );
  }
  if (!isTransport(transport)) throw new TypeError('joinCluster: transport must be a Transport');
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new TypeError('joinCluster: seeds must be a non-empty array of addresses');
  }
  const seen = new Set<string>();
  for (const seed of seeds as unknown[]) {
    if (typeof seed !== 'string' || !ADDRESS.test(seed)) {
      throw new TypeError(
        `joinCluster: a seed must be an address, without "@", "#", "/" or spaces, got ${describe(seed)}`,
      );
    }
    if (seen.has(seed)) throw new TypeError(`joinCluster: seed "${seed}" is listed twice`);
    seen.add(seed);
  }
  checkInt(heartbeatMs, 'joinCluster: heartbeatMs');
  checkInt(unreachableAfterMs, 'joinCluster: unreachableAfterMs');
  if (unreachableAfterMs <= heartbeatMs) {
    throw new TypeError(
      `joinCluster: unreachableAfterMs (${String(unreachableAfterMs)}) must be more than heartbeatMs (${String(heartbeatMs)})`,
    );
  }
  checkInt(downAfterMs, 'joinCluster: downAfterMs', { min: 0 });
  checkInt(seedTimeoutMs, 'joinCluster: seedTimeoutMs', { min: 0 });
  checkInt(bufferSize, 'joinCluster: bufferSize', { min: 0 });
  checkInt(maxFrameBytes, 'joinCluster: maxFrameBytes');
  if (shards !== undefined && !isShardStore(shards)) {
    throw new TypeError('joinCluster: shards must be a ShardStore');
  }
  return {
    name,
    transport,
    seeds: Object.freeze([...(seeds as readonly string[])]),
    heartbeatMs,
    unreachableAfterMs,
    downAfterMs,
    seedTimeoutMs,
    bufferSize,
    maxFrameBytes,
    shards,
    leases: checkLeases(leases),
  };
}

/** Where this node is in its own life in the cluster. */
type Phase = 'joining' | 'up' | 'leaving' | 'left';

/** What this node keeps about a member beside its entry, never gossiped. */
interface Local {
  /** When this node last heard its heartbeat, or learned of it. */
  heardAt: number;
  reachable: boolean;
  /** When it became unreachable. */
  unreachableAt: number;
  /** When it became a tombstone, `down` or `removed`, for pruning. */
  tombstoneAt: number | undefined;
}

const EVENT: Readonly<Record<Status, 'memberUp' | 'memberLeaving' | 'memberDown' | undefined>> = {
  up: 'memberUp',
  leaving: 'memberLeaving',
  down: 'memberDown',
  removed: undefined,
};

/** Membership's state for one node. */
class Membership {
  readonly api: Cluster;
  readonly #hooks: SystemHooks;
  readonly #remoting: Remoting;
  readonly #opts: Checked;
  readonly #pruneAfterMs: number;
  readonly #plant: Plant | undefined;
  readonly #selfKey: string;
  #table: Table = new Map();
  readonly #local = new Map<string, Local>();
  // Keys pruned, and when. Others prune a little later than this node, since they learned of the
  // tombstone later, so their gossip would bring it back. Kept for another pruneAfterMs.
  readonly #pruned = new Map<string, number>();
  #phase: Phase = 'joining';
  #cancelTick: (() => void) | undefined;
  #cancelSeedTimeout: (() => void) | undefined;
  #resolveUp!: () => void;
  #rejectUp!: (error: Error) => void;
  #left: Promise<void> | undefined;
  readonly #sharding: ShardingNode;
  #closing: Promise<void> | undefined;
  // Tells inspectors, such as Backstage, that this node's view of the cluster may have changed.
  readonly #changed: () => void;

  constructor(
    system: ActorSystem,
    hooks: SystemHooks,
    remoting: Remoting,
    opts: Checked,
    pruneAfterMs: number,
  ) {
    this.#hooks = hooks;
    this.#remoting = remoting;
    this.#opts = opts;
    this.#pruneAfterMs = pruneAfterMs;
    this.#plant = plantOf(system);
    const { address, uid } = remoting.self;
    this.#selfKey = keyOf(address, uid);
    const whenUp = new Promise<void>((resolve, reject) => {
      this.#resolveUp = resolve;
      this.#rejectUp = reject;
    });
    // Handled here, so a node nobody awaits doesn't raise an unhandled rejection when it leaves.
    whenUp.catch(() => {});
    remoting.onControl((from, frame) => {
      this.#onControl(from, frame);
    });
    remoting.onPeer((peer) => {
      this.#onPeer(peer);
    });
    remoting.whenListening.then(
      () => {
        this.#start();
      },
      (error: unknown) => {
        void this.#shutdown(error instanceof Error ? error : new Error(String(error)));
      },
    );
    // terminate() leaves gracefully once /user has stopped, handing shards off before /system
    // stops. The cluster closes remoting itself, after saying goodbye.
    hooks.onTerminate(() => this.#leave());
    const members = (): Member[] => this.#members();
    this.#sharding = startSharding({
      system,
      hooks,
      remoting,
      store: opts.shards,
      leases: opts.leases,
      maxFrameBytes: opts.maxFrameBytes,
      members,
      changed: () => {
        this.#changed();
      },
    });
    this.#changed = hooks.setCluster(
      Object.freeze({
        address,
        uid,
        members,
        entityTypes: () => this.#sharding.entityTypes(),
      }),
    );
    this.api = Object.freeze({
      self: Object.freeze({ address, uid }),
      members,
      whenUp,
      sharding: this.#sharding.api,
      leave: () => this.#leave(),
    });
  }

  // ---- the node's own life ----

  #start(): void {
    if (this.#phase !== 'joining') return;
    const { seeds, seedTimeoutMs, heartbeatMs } = this.#opts;
    const address = this.#remoting.self.address;
    this.#cancelTick = this.#every(heartbeatMs, () => {
      this.#tick();
    });
    if (seeds[0] === address) {
      if (seeds.length === 1) {
        this.#formAlone();
        return;
      }
      this.#cancelSeedTimeout = this.#hooks.scheduler.setTimer(() => {
        this.#cancelSeedTimeout = undefined;
        this.#formAlone();
      }, seedTimeoutMs);
    }
    this.#sendJoins();
  }

  /** A timer that runs `task` every `ms` until it's cancelled. */
  #every(ms: number, task: () => void): () => void {
    let cancel: () => void = () => {};
    let stopped = false;
    const arm = (): void => {
      cancel = this.#hooks.scheduler.setTimer(() => {
        if (stopped) return;
        arm();
        task();
      }, ms);
    };
    arm();
    return () => {
      stopped = true;
      cancel();
    };
  }

  #formAlone(): void {
    if (this.#phase !== 'joining') return;
    this.#hooks.log.info(`cluster: ${this.#remoting.self.address} formed the cluster alone`, {
      address: this.#remoting.self.address,
    });
    this.#becomeUp(new Map());
  }

  /** This node is in: `table` is what let it in, which this node's own entry joins. */
  #becomeUp(table: Table): void {
    this.#phase = 'up';
    this.#cancelSeedTimeout?.();
    this.#cancelSeedTimeout = undefined;
    const { address, uid } = this.#remoting.self;
    this.#apply(advance(table, { address, uid, status: 'up' }));
    this.#resolveUp();
  }

  #leave(): Promise<void> {
    if (this.#left !== undefined) return this.#left;
    if (this.#phase === 'joining') {
      this.#left = this.#shutdown(new Error('the node left before it was in the cluster'));
      return this.#left;
    }
    const { address, uid } = this.#remoting.self;
    this.#phase = 'leaving';
    // Publishing `leaving` tells the regions to hand their shards off, and the others to stop
    // placing shards here. Once the regions have stopped, the others hear this node has gone.
    this.#apply(advance(this.#table, { address, uid, status: 'leaving' }));
    this.#gossipToAll();
    this.#left = this.#sharding.whenStopped().then(() => {
      if (this.#phase === 'leaving') {
        this.#apply(advance(this.#table, { address, uid, status: 'removed' }));
        this.#gossipToAll();
      }
      return this.#shutdown(undefined);
    });
    return this.#left;
  }

  /** A trusted member says this node is down: it leaves, and can come back only as a new uid. */
  #downed(by: string): void {
    if (this.#phase !== 'up' && this.#phase !== 'leaving') return;
    const { address, uid } = this.#remoting.self;
    this.#hooks.log.warn(`cluster: ${by} downed this node, so it has left the cluster`, {
      address,
      by,
    });
    this.#apply(advance(this.#table, { address, uid, status: 'down' }));
  }

  #shutdown(error: Error | undefined): Promise<void> {
    if (this.#phase === 'left' && this.#closing !== undefined) return this.#closing;
    this.#phase = 'left';
    this.#cancelTick?.();
    this.#cancelTick = undefined;
    this.#cancelSeedTimeout?.();
    this.#cancelSeedTimeout = undefined;
    this.#rejectUp(error ?? new Error('the node left the cluster before it was up'));
    const closing = this.#remoting.close();
    this.#closing = closing;
    this.#left ??= closing;
    return closing;
  }

  // ---- the table ----

  /**
   * Makes `next` this node's table, and publishes what changed: an event for each entry that
   * moved, in table order. Another incarnation at this node's own address is an old one of this
   * node, so it's retired first.
   */
  #apply(next: Table): void {
    const self = this.#remoting.self;
    next = this.#retire(next, { address: self.address, uid: self.uid });
    const previous = this.#table;
    this.#table = next;
    const now = this.#hooks.scheduler.now();
    for (const [key, entry] of next) {
      const before = previous.get(key);
      if (before?.status === entry.status) continue;
      let local = this.#local.get(key);
      if (local === undefined) {
        local = { heardAt: now, reachable: true, unreachableAt: 0, tombstoneAt: undefined };
        this.#local.set(key, local);
      }
      if (local.tombstoneAt === undefined && isAfter(entry.status, 'leaving')) {
        local.tombstoneAt = now;
      }
      const type = EVENT[entry.status];
      if (type !== undefined) {
        this.#publish({ type, address: entry.address, uid: entry.uid });
      } else if (before !== undefined) {
        this.#publish({ type: 'memberRemoved', address: entry.address, uid: entry.uid });
      }
      if (key !== this.#selfKey && isAfter(entry.status, 'leaving')) {
        this.#remoting.nodeDown(entry.address, entry.uid);
      }
    }
    const own = next.get(this.#selfKey);
    if (own?.status === 'down' && this.#phase !== 'left') void this.#shutdown(undefined);
  }

  /** `table` with every other incarnation at `current`'s address removed. */
  #retire(table: Table, current: PeerId): Table {
    let next = table;
    for (const entry of table.values()) {
      if (
        entry.address === current.address &&
        entry.uid !== current.uid &&
        entry.status !== 'removed'
      ) {
        next = advance(next, { ...entry, status: 'removed' });
      }
    }
    return next;
  }

  /** Publishes a member event, and tells inspectors the view has changed. */
  #publish(body: EventBody): void {
    this.#hooks.publish(body);
    this.#changed();
  }

  #members(): Member[] {
    const members: Member[] = [];
    for (const [key, entry] of this.#table) {
      if (entry.status === 'removed') continue;
      const reachable = key === this.#selfKey || (this.#local.get(key)?.reachable ?? true);
      members.push(
        Object.freeze({
          address: entry.address,
          uid: entry.uid,
          status: entry.status,
          reachable,
        }),
      );
    }
    return members;
  }

  /** The other members this node talks to: up or leaving, not itself. */
  #peers(): Entry[] {
    return [...this.#table.entries()]
      .filter(([key, e]) => key !== this.#selfKey && !isAfter(e.status, 'leaving'))
      .map(([, e]) => e);
  }

  /** Whether a member is one this node still listens to: up or leaving. */
  #trusts(from: PeerId): boolean {
    const entry = this.#table.get(keyOf(from.address, from.uid));
    return entry !== undefined && !isAfter(entry.status, 'leaving');
  }

  /** Whether this node has downed or removed `from`, so it no longer listens to it. */
  #distrusts(from: PeerId): boolean {
    const entry = this.#table.get(keyOf(from.address, from.uid));
    return entry !== undefined && isAfter(entry.status, 'leaving');
  }

  // ---- the tick ----

  #tick(): void {
    if (this.#phase === 'joining') {
      this.#sendJoins();
      return;
    }
    if (this.#phase !== 'up') return;
    const peers = this.#peers();
    for (const peer of peers) this.#remoting.signal(peer.address, { t: 'hb' });
    this.#checkReachability(peers);
    this.#gossipToOne();
    this.#prune();
  }

  #sendJoins(): void {
    const address = this.#remoting.self.address;
    for (const seed of this.#opts.seeds) {
      if (seed !== address) this.#remoting.signal(seed, { t: 'join' });
    }
  }

  #checkReachability(peers: readonly Entry[]): void {
    const now = this.#hooks.scheduler.now();
    const { unreachableAfterMs, downAfterMs } = this.#opts;
    for (const peer of peers) {
      const local = this.#local.get(keyOf(peer.address, peer.uid));
      if (local === undefined) continue;
      if (local.reachable && now - local.heardAt >= unreachableAfterMs) {
        local.reachable = false;
        local.unreachableAt = now;
        this.#hooks.log.info(`cluster: ${peer.address} is unreachable`, { address: peer.address });
        this.#publish({
          type: 'reachability',
          address: peer.address,
          uid: peer.uid,
          reachable: false,
        });
      }
      if (!local.reachable && now - local.unreachableAt >= downAfterMs) {
        this.#hooks.log.warn(
          `cluster: downed ${peer.address}, unreachable for ${String(now - local.unreachableAt)} ms`,
          { address: peer.address },
        );
        this.#apply(advance(this.#table, { ...peer, status: 'down' }));
      }
    }
  }

  #gossipToOne(): void {
    const peers = this.#peers();
    const reachable = peers.filter(
      (p) => this.#local.get(keyOf(p.address, p.uid))?.reachable === true,
    );
    const pool = reachable.length > 0 ? reachable : peers;
    if (pool.length === 0) return;
    const target = pool[Math.floor(this.#hooks.random() * pool.length)];
    if (target !== undefined) this.#gossip(target.address, false);
  }

  #gossipToAll(): void {
    for (const peer of this.#peers()) this.#gossip(peer.address, false);
  }

  #gossip(address: string, reply: boolean): void {
    const frame: Record<string, unknown> = { t: 'gossip', members: encodeTable(this.#table) };
    if (reply) frame.reply = true;
    this.#remoting.signal(address, frame);
  }

  #prune(): void {
    const now = this.#hooks.scheduler.now();
    let next: Map<string, Entry> | undefined;
    for (const [key, entry] of this.#table) {
      const local = this.#local.get(key);
      if (local?.tombstoneAt === undefined || now - local.tombstoneAt < this.#pruneAfterMs) {
        continue;
      }
      if (key === this.#selfKey) continue;
      next ??= new Map(this.#table);
      next.delete(key);
      this.#local.delete(key);
      this.#pruned.set(key, now);
      if (entry.status === 'down') {
        this.#publish({ type: 'memberRemoved', address: entry.address, uid: entry.uid });
      }
    }
    if (next !== undefined) this.#table = next;
    for (const [key, at] of this.#pruned) {
      if (now - at >= this.#pruneAfterMs) this.#pruned.delete(key);
    }
  }

  // ---- frames ----

  #onPeer(peer: PeerId): void {
    // A join goes out as soon as a seed can hear it, not on the next tick. A new incarnation at
    // a known address is retired by the join that brings it, and by its own gossip.
    if (this.#phase === 'joining' && this.#opts.seeds.includes(peer.address)) {
      this.#remoting.signal(peer.address, { t: 'join' });
    }
  }

  #onControl(from: PeerId, frame: Readonly<Record<string, unknown>>): void {
    if (this.#phase === 'left') return;
    switch (frame.t) {
      case 'hb':
        this.#onHeartbeat(from);
        return;
      case 'join':
        this.#onJoin(from);
        return;
      case 'gossip':
        this.#onGossip(from, frame);
        return;
      case 'downed':
        // Only from a member this node still trusts: a node this one has downed can't make it
        // leave, so two sides of a partition that down each other leave two clusters, not none.
        if (this.#trusts(from)) this.#downed(from.address);
        return;
      default:
        this.#hooks.log.warn(`cluster: ignored a "${String(frame.t)}" frame from ${from.address}`, {
          address: from.address,
        });
    }
  }

  #onHeartbeat(from: PeerId): void {
    const local = this.#local.get(keyOf(from.address, from.uid));
    if (local === undefined) return;
    local.heardAt = this.#hooks.scheduler.now();
    if (local.reachable) return;
    local.reachable = true;
    this.#hooks.log.info(`cluster: ${from.address} is reachable again`, { address: from.address });
    this.#publish({
      type: 'reachability',
      address: from.address,
      uid: from.uid,
      reachable: true,
    });
  }

  #onJoin(from: PeerId): void {
    // Only a member lets another in, so a node that isn't in a cluster can't start one.
    if (this.#phase !== 'up') return;
    const key = keyOf(from.address, from.uid);
    const known = this.#table.get(key);
    if (known !== undefined && isAfter(known.status, 'leaving')) return;
    if (known === undefined) {
      this.#apply(this.#retire(advance(this.#table, { ...from, status: 'up' }), from));
    }
    this.#gossip(from.address, true);
  }

  #onGossip(from: PeerId, frame: Readonly<Record<string, unknown>>): void {
    const decoded = decodeTable(frame.members, (a) => ADDRESS.test(a));
    const received =
      decoded === undefined || this.#pruned.size === 0
        ? decoded
        : new Map([...decoded].filter(([key]) => !this.#pruned.has(key)));
    if (received === undefined) {
      this.#hooks.log.warn(`cluster: ignored gossip from ${from.address} that isn’t a table`, {
        address: from.address,
      });
      return;
    }
    if (this.#phase === 'joining') {
      // The welcome: a member's table with this node in it.
      if (received.get(this.#selfKey)?.status === 'up') this.#becomeUp(received);
      return;
    }
    // Gossip from a member this node hasn't heard of yet is welcome: it was let in elsewhere.
    if (this.#distrusts(from)) return;
    const next =
      this.#plant === 'gossip-backwards'
        ? // Planted (T6): what the gossip says wins, so a status can go backwards.
          tableOf([
            ...[...this.#table].filter(([key]) => !received.has(key)).map(([, entry]) => entry),
            ...received.values(),
          ])
        : merge(this.#table, received);
    if (!sameTable(next, this.#table)) this.#apply(next);
    // Push-pull: a node that knew more answers, once, so two nodes agree after one exchange.
    if (frame.reply !== true && !sameTable(this.#table, received)) this.#gossip(from.address, true);
  }
}
