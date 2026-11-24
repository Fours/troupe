// Cluster sharding (decision 0030): entity types, entity refs, and the regions that route to
// them. An entity ref names an entity by its type and id, never by where it lives, so it stays
// good when its shard moves, and it travels on the wire as `{ "$entity": { type, id } }`. Every
// message to an entity is encoded where it's sent and decoded where the entity runs, even on the
// same node, so placement never changes what arrives (decision 0025).
import { actor } from '../actor.js';
import { checkInt, checkKeys, describe } from '../checks.js';
import { ActorNameError } from '../errors.js';
import type { SystemHooks } from '../internal.js';
import { isValidName } from '../names.js';
import type { StandardSchemaV1 } from '../persistence/standard-schema.js';
import { checkStrategy, supervise, type SupervisorStrategy } from '../supervision.js';
import type { ActorDef, ActorRef, ActorSystem, AnyRef } from '../types.js';
import { leaseKeeper, type LeaseKeeper } from './leases.js';
import type { Member } from './membership.js';
import { Internal, regionDef, type RegionMsg, type StopReason } from './region.js';
import { utf8Bytes, type Remoting } from './remoting.js';
import { entityPath } from './shard.js';
import type { ShardStore } from './shard-store.js';
import { keyOf } from './table.js';
import type { EntityName } from './wire.js';

/** Options for {@link Sharding.init}. */
export interface EntityTypeOptions<M, S> {
  /** The type's name, the same on every node: an actor name, such as `show`. */
  type: string;
  /** The entity with this id, made on its first message and after each stop. */
  entity: (id: string) => ActorDef<M, S>;
  /**
   * How many shards the type's entities are spread over. The same on every node, and never
   * changed on a running cluster: a node whose count differs is refused. Default 64.
   */
  shardCount?: number;
  /** What happens when an entity fails (decision 0006). Default `supervise.stop()`. */
  supervision?: SupervisorStrategy;
  /** Whether this node hosts the type's shards, or only routes to them. Default true. */
  host?: boolean;
  /**
   * Checks every message an entity gets, after it's decoded on the entity's node. One that fails
   * is an `invalid` dead letter, with its issues logged. Any Standard Schema (decision 0018).
   */
  schema?: StandardSchemaV1<unknown, M>;
  /** How many messages wait for each shard while its home is found. Default 1,000. */
  bufferSize?: number;
  /**
   * Stop an entity that has had no message for `idleMs`. Messages that arrive as it stops go to
   * its next incarnation, in order. Default: entities never passivate. Not with `remember`.
   */
  passivation?: { idleMs: number };
  /**
   * Record each entity a shard starts in the shard store, and start every remembered entity as
   * soon as its shard starts on a node, rather than on its next message. An entity that stops
   * itself, or that its supervision stops, is forgotten. Default false.
   */
  remember?: boolean;
  /** How often this node looks for shards it holds that belong elsewhere. Default 2,000. */
  rebalanceMs?: number;
  /** How many shards this node hands off at once while rebalancing. Default 2. */
  maxHandoffs?: number;
}

/** An entity type, as {@link Sharding.init} registered it on this node. */
export interface EntityType<M> {
  /** The type's name. */
  readonly type: string;
  /** How many shards its entities are spread over. */
  readonly shardCount: number;
  /**
   * A ref to the entity with this id, wherever it lives now. Its path is `/sharding/<type>/<id>`
   * on every node. It can't be watched, since an entity has no single incarnation to watch.
   * @throws ActorNameError unless `id` is an actor name: 1 to 64 letters, digits, `.`, `_`, `~`
   * or `-`, starting with a letter or digit.
   */
  ref(id: string): ActorRef<M>;
}

/** Entity types on this node. */
export interface Sharding {
  /**
   * Registers an entity type on this node, and starts its region. Every node that hosts the type
   * calls it with the same `type` and `shardCount`.
   * @throws TypeError for options that can't be used, unknown ones included, or a cluster that
   * was given no shard store.
   * @throws Error if this node has registered the type already.
   */
  init<M, S>(opts: EntityTypeOptions<M, S>): EntityType<M>;
}

/** How a node times its leases (decision 0029). Every time is in integer milliseconds. */
export interface LeaseOptions {
  /** How long the store keeps a lease after each acquire or renewal. Default 10,000. */
  ttlMs?: number;
  /** How often this node renews its leases. Default 3,000. */
  renewMs?: number;
  /** How long before the store's expiry this node gives a lease up. Default 2,000. */
  marginMs?: number;
}

/** What sharding needs from its node. */
export interface ShardingEnv {
  readonly system: ActorSystem;
  readonly hooks: SystemHooks;
  readonly remoting: Remoting;
  readonly store: ShardStore | undefined;
  readonly leases: Required<LeaseOptions>;
  readonly maxFrameBytes: number;
  readonly members: () => readonly Member[];
}

const OPTIONS = new Set([
  'type',
  'entity',
  'shardCount',
  'supervision',
  'host',
  'schema',
  'bufferSize',
  'passivation',
  'remember',
  'rebalanceMs',
  'maxHandoffs',
]);
const LEASE_OPTIONS = new Set(['ttlMs', 'renewMs', 'marginMs']);
const MAX_SHARDS = 65_536;
const MEMBER_EVENTS = new Set([
  'memberUp',
  'memberLeaving',
  'memberDown',
  'memberRemoved',
  'reachability',
]);

/** Checks `joinCluster`'s `leases` option, and fills in the defaults. */
export function checkLeases(leases: unknown): Required<LeaseOptions> {
  if (leases === undefined) return { ttlMs: 10_000, renewMs: 3_000, marginMs: 2_000 };
  checkKeys(leases, LEASE_OPTIONS, 'joinCluster: leases');
  const { ttlMs = 10_000, renewMs = 3_000, marginMs = 2_000 } = leases as LeaseOptions;
  checkInt(ttlMs, 'joinCluster: leases.ttlMs');
  checkInt(renewMs, 'joinCluster: leases.renewMs');
  checkInt(marginMs, 'joinCluster: leases.marginMs', { min: 0 });
  if (renewMs >= ttlMs - marginMs) {
    throw new TypeError(
      `joinCluster: leases.renewMs must be less than ttlMs - marginMs, so a renewal lands ` +
        `before the deadline, got ${String(renewMs)} with ttlMs ${String(ttlMs)} and marginMs ${String(marginMs)}`,
    );
  }
  return { ttlMs, renewMs, marginMs };
}

/** Whether `value` has a shard store's shape. */
export function isShardStore(value: unknown): value is ShardStore {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return ['acquire', 'renewAll', 'release', 'holders', 'remember', 'forget', 'remembered'].every(
    (name) => typeof s[name] === 'function',
  );
}

interface Registered {
  readonly region: ActorRef<RegionMsg>;
  readonly shardCount: number;
}

/** Sharding for one node, as its cluster sees it. */
export interface ShardingNode {
  readonly api: Sharding;
  /**
   * Resolves once every region has stopped: after a leave, once each has handed its shards off.
   */
  whenStopped(): Promise<void>;
}

/** Sharding for one node. */
export function startSharding(env: ShardingEnv): ShardingNode {
  const { hooks, remoting } = env;
  const { address, uid } = remoting.self;
  const holder = keyOf(address, uid);
  const types = new Map<string, Registered>();
  const names = new WeakMap<object, EntityName>();
  // Regions that have stopped, which nothing more is sent to.
  const stopped = new Set<string>();
  const waitingForStop: (() => void)[] = [];
  const allStopped = (): boolean => [...types.keys()].every((type) => stopped.has(type));
  let guardian: AnyRef | undefined;
  let keeper: LeaseKeeper | undefined;
  let stopping: StopReason | undefined;

  const tellRegions = (msg: RegionMsg): void => {
    for (const [type, { region }] of types) if (!stopped.has(type)) region.tell(msg);
  };

  // Members change on the event stream, in order with everything else.
  const unsubscribe = env.system.events.subscribe((event) => {
    if (!MEMBER_EVENTS.has(event.type)) return;
    const own =
      'address' in event && event.address === address && 'uid' in event && event.uid === uid;
    if (own && (event.type === 'memberLeaving' || event.type === 'memberDown')) {
      stopping ??= event.type === 'memberDown' ? 'downed' : 'leaving';
      tellRegions(new Internal({ t: 'stop', reason: stopping }));
      return;
    }
    // A leaving node still follows the members, to hand its shards to the right ones.
    if (stopping !== 'downed') tellRegions(new Internal({ t: 'members' }));
  });
  void env.system.whenTerminated.then(() => {
    unsubscribe();
    keeper?.close();
  });

  const keeperFor = (store: ShardStore): LeaseKeeper => {
    keeper ??= leaseKeeper({
      store,
      holder,
      scheduler: hooks.scheduler,
      ...env.leases,
      onLost: (lease, token) => {
        const slash = lease.indexOf('/');
        const registered = types.get(lease.slice(0, slash));
        registered?.region.tell(
          new Internal({ t: 'lost', shard: Number(lease.slice(slash + 1)), token }),
        );
      },
    });
    return keeper;
  };

  const entityRef = (type: string, id: string): AnyRef => {
    const path = entityPath(type, id);
    const ref = hooks.makeRef<unknown>(path, (message) => {
      const registered = types.get(type);
      if (registered === undefined) {
        hooks.log.warn(`sharding: a message to ${path}, a type this node hasn't initialised`, {
          recipient: path,
        });
        hooks.deadLetter(path, message, 'unreachable');
        return;
      }
      const { codec } = remoting;
      const encoded = codec.encode(message);
      const problem = !encoded.ok
        ? encoded.problem
        : utf8Bytes(encoded.text) > env.maxFrameBytes
          ? `it is ${String(utf8Bytes(encoded.text))} bytes, over maxFrameBytes (${String(env.maxFrameBytes)})`
          : undefined;
      if (!encoded.ok || problem !== undefined) {
        hooks.log.warn(`sharding: a message to ${path} can't be sent: ${String(problem)}`, {
          recipient: path,
        });
        hooks.deadLetter(path, message, 'unserializable');
        return;
      }
      const sender = hooks.sender();
      registered.region.tell(
        sender === undefined
          ? { t: 'deliver', id, m: encoded.text }
          : { t: 'deliver', id, m: encoded.text, from: codec.uri(sender) },
      );
    });
    names.set(ref, { type, id });
    return ref;
  };

  remoting.setEntities({
    identify: (ref) => names.get(ref),
    ref: ({ type, id }) => entityRef(type, id),
  });

  const api: Sharding = Object.freeze({
    init<M, S>(opts: EntityTypeOptions<M, S>): EntityType<M> {
      const checked = checkInit(opts);
      const { type, shardCount } = checked;
      const store = env.store;
      if (store === undefined) {
        throw new TypeError(
          'sharding.init: the cluster has no shard store: pass joinCluster a `shards` option',
        );
      }
      if (types.has(type)) throw new Error(`sharding.init: "${type}" is already initialised`);
      guardian ??= hooks.spawnSystem(
        actor<never, null>({ initial: null, receive: (s) => s }),
        'sharding',
      );
      const region = hooks.spawnSystem(
        regionDef({
          type,
          hooks,
          codec: remoting.codec,
          entity: checked.entity,
          spawn: { supervision: checked.supervision },
          schema: checked.schema,
          shardCount,
          host: checked.host,
          bufferSize: checked.bufferSize,
          idleMs: checked.idleMs,
          remember: checked.remember,
          rebalanceMs: checked.rebalanceMs,
          maxHandoffs: checked.maxHandoffs,
          remoting,
          store,
          keeper: checked.host ? keeperFor(store) : undefined,
          members: env.members,
          onStopped: () => {
            stopped.add(type);
            if (allStopped()) for (const resolve of waitingForStop.splice(0)) resolve();
          },
        }),
        type,
        undefined,
        guardian,
      );
      types.set(type, { region, shardCount });
      region.tell(
        stopping === undefined
          ? new Internal({ t: 'members' })
          : new Internal({ t: 'stop', reason: stopping }),
      );
      return Object.freeze({
        type,
        shardCount,
        ref(id: string): ActorRef<M> {
          if (!isValidName(id)) {
            throw new ActorNameError(
              `entity id must be 1 to 64 letters, digits, ".", "_", "~" or "-", starting with a letter or digit, got ${describe(id)}`,
            );
          }
          return entityRef(type, id) as unknown as ActorRef<M>;
        },
      });
    },
  });
  return {
    api,
    whenStopped: () =>
      allStopped()
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waitingForStop.push(resolve);
          }),
  };
}

interface CheckedInit<M, S> {
  readonly type: string;
  readonly entity: (id: string) => ActorDef<M, S>;
  readonly shardCount: number;
  readonly supervision: SupervisorStrategy;
  readonly host: boolean;
  readonly schema: StandardSchemaV1<unknown, M> | undefined;
  readonly bufferSize: number;
  readonly idleMs: number | undefined;
  readonly remember: boolean;
  readonly rebalanceMs: number;
  readonly maxHandoffs: number;
}

const PASSIVATION_OPTIONS = new Set(['idleMs']);

function checkInit<M, S>(opts: EntityTypeOptions<M, S>): CheckedInit<M, S> {
  checkKeys(opts, OPTIONS, 'sharding.init');
  const {
    type,
    entity,
    shardCount = 64,
    supervision = supervise.stop(),
    host = true,
    schema,
    bufferSize = 1_000,
    passivation,
    remember = false,
    rebalanceMs = 2_000,
    maxHandoffs = 2,
  } = opts;
  if (!isValidName(type)) {
    throw new TypeError(
      `sharding.init: type must be an actor name, such as "show", got ${describe(type)}`,
    );
  }
  if (typeof entity !== 'function') {
    throw new TypeError('sharding.init: entity must be a function from an id to an actor');
  }
  checkInt(shardCount, 'sharding.init: shardCount');
  if (shardCount > MAX_SHARDS) {
    throw new TypeError(
      `sharding.init: shardCount must be at most ${String(MAX_SHARDS)}, got ${String(shardCount)}`,
    );
  }
  checkStrategy(supervision, 'sharding.init: supervision');
  if (typeof host !== 'boolean') {
    throw new TypeError(`sharding.init: host must be a boolean, got ${describe(host)}`);
  }
  if (schema !== undefined && !isStandardSchema(schema)) {
    throw new TypeError('sharding.init: schema must be a Standard Schema, with ~standard.validate');
  }
  checkInt(bufferSize, 'sharding.init: bufferSize');
  let idleMs: number | undefined;
  if (passivation !== undefined) {
    checkKeys(passivation, PASSIVATION_OPTIONS, 'sharding.init: passivation');
    idleMs = passivation.idleMs;
    checkInt(idleMs, 'sharding.init: passivation.idleMs');
  }
  if (typeof remember !== 'boolean') {
    throw new TypeError(`sharding.init: remember must be a boolean, got ${describe(remember)}`);
  }
  if (remember && idleMs !== undefined) {
    throw new TypeError(
      'sharding.init: a type with remember: true can’t passivate, since that would forget its entities',
    );
  }
  checkInt(rebalanceMs, 'sharding.init: rebalanceMs');
  checkInt(maxHandoffs, 'sharding.init: maxHandoffs');
  return {
    type,
    entity,
    shardCount,
    supervision,
    host,
    schema,
    bufferSize,
    idleMs,
    remember,
    rebalanceMs,
    maxHandoffs,
  };
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const props = (value as { '~standard'?: unknown })['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    typeof (props as { validate?: unknown }).validate === 'function'
  );
}
