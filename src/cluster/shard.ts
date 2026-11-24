// One shard of an entity type, at /system/sharding/<type>/<shard> on the node that holds its lease
// (decision 0030). It owns the shard's entities: it decodes each message its region hands it,
// checks it against the type's schema, and spawns the entity on its first message. Decoding here,
// on the entity's node, means an entity never shares an object with its sender, and a message
// that only works in memory fails on a one-node cluster as it would across nodes (decision 0025).
//
// The shard also stops its entities when they're idle (passivation) and when the shard moves
// (a drain, for a handoff). Either way an entity finishes what's in its mailbox first, a persist
// included, and what arrives meanwhile waits here for the entity's next incarnation, in order.
// With `remember`, the shard records the entities it starts in the store, and starts them all
// again wherever it starts next.
import { actor } from '../actor.js';
import { internalsOf, type SystemHooks } from '../internal.js';
import type { StandardSchemaV1 } from '../persistence/standard-schema.js';
import type { ActorContext, ActorDef, AnyRef, Result, SpawnOptions } from '../types.js';
import type { ShardStore } from './shard-store.js';
import type { Codec } from './wire.js';

/** A message for one entity, as its region hands it to the shard. */
export interface ShardDeliver {
  readonly t: 'deliver';
  readonly id: string;
  /** The message, as the codec encoded it. */
  readonly m: string;
  /** The original sender's full path, when it was known. */
  readonly from?: string;
}

type ShardInternalMsg =
  | { readonly t: 'drain' }
  | { readonly t: 'idle'; readonly id: string }
  | { readonly t: 'remembered'; readonly result: Result<readonly string[]> }
  | { readonly t: 'recall' };

/** A message only this node can send a shard: none decodes from the wire as one. */
export class ShardInternal {
  constructor(readonly msg: ShardInternalMsg) {}
}

/** What a shard gets. */
export type ShardMsg = ShardDeliver | ShardInternal;

/** What a shard needs from its entity type and its node. */
export interface ShardEnv {
  readonly type: string;
  readonly hooks: SystemHooks;
  readonly codec: Codec;
  readonly entity: (id: string) => ActorDef<unknown, unknown>;
  readonly spawn: SpawnOptions;
  readonly schema: StandardSchemaV1 | undefined;
  /** Stop an entity that has had no message for this long. Undefined: never. */
  readonly idleMs: number | undefined;
  /** Record started entities in the store, and start them all again when the shard starts. */
  readonly remember: boolean;
  readonly store: ShardStore;
}

/** The path an entity's messages are addressed to, and dead letters name: `/sharding/<type>/<id>`. */
export function entityPath(type: string, id: string): string {
  return `/sharding/${type}/${id}`;
}

/**
 * The shard actor's definition, for the shard whose lease is `lease`. Its state is nothing: its
 * entities are its children, and what it knows of them lives with the incarnation.
 */
export function shardDef(env: ShardEnv, lease: string): ActorDef<ShardMsg, null> {
  let shard: Shard | undefined;
  return actor<ShardMsg, null>({
    initial: (ctx) => {
      shard = new Shard(env, lease, ctx);
      return null;
    },
    receive(state, msg) {
      if (msg instanceof ShardInternal) {
        shard?.internal(msg.msg);
        return state;
      }
      const checked = shard?.check(msg);
      return checked === undefined ? state : checked.then(() => state);
    },
    onSignal(state, signal) {
      if (signal.type === 'terminated') shard?.entityStopped(signal.ref);
      return state;
    },
  });
}

/** A message that has passed its checks, on its way to an entity. */
interface Checked {
  readonly value: unknown;
  readonly from: string | undefined;
}

/** A live entity, as its shard knows it. */
interface Entity {
  readonly id: string;
  readonly ref: AnyRef;
  /** When the shard last gave it a message, by the scheduler's clock. */
  lastAt: number;
  /** The shard has asked it to stop once its mailbox is empty. */
  stopping: boolean;
  /** What arrived after that, for its next incarnation. */
  readonly held: Checked[];
}

const RECALL_MIN_MS = 100;
const RECALL_MAX_MS = 2_000;

class Shard {
  readonly #env: ShardEnv;
  readonly #lease: string;
  readonly #ctx: ActorContext<ShardMsg>;
  readonly #entities = new Map<string, Entity>();
  readonly #byRef = new Map<AnyRef, string>();
  readonly #remembered = new Set<string>();
  // Store writes in order, so a remember and a forget of one id never swap.
  #writes: Promise<void> = Promise.resolve();
  #draining = false;
  #recallAttempt = 0;

  constructor(env: ShardEnv, lease: string, ctx: ActorContext<ShardMsg>) {
    this.#env = env;
    this.#lease = lease;
    this.#ctx = ctx;
    if (env.remember) this.#recall();
  }

  internal(msg: ShardInternalMsg): void {
    switch (msg.t) {
      case 'drain':
        this.#drain();
        return;
      case 'idle':
        this.#onIdle(msg.id);
        return;
      case 'remembered':
        this.#onRemembered(msg.result);
        return;
      case 'recall':
        this.#recall();
        return;
    }
  }

  /** Decodes and checks a message, then delivers it. A promise while an async schema runs. */
  check(msg: ShardDeliver): Promise<void> | undefined {
    const { type, hooks, codec, schema } = this.#env;
    const decoded = codec.decode(msg.m);
    if (!decoded.ok) {
      const recipient = entityPath(type, msg.id);
      hooks.log.warn(`sharding: a message to ${recipient} can't be decoded: ${decoded.problem}`, {
        recipient,
      });
      hooks.deadLetter(recipient, msg.m, 'unserializable');
      return undefined;
    }
    if (schema === undefined) {
      this.#deliver(msg.id, [{ value: decoded.value, from: msg.from }]);
      return undefined;
    }
    const checked = (result: StandardSchemaV1.Result<unknown>): void => {
      if (result.issues === undefined)
        this.#deliver(msg.id, [{ value: result.value, from: msg.from }]);
      else this.#invalid(msg.id, decoded.value, result.issues);
    };
    let result: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
    try {
      result = schema['~standard'].validate(decoded.value);
    } catch (error) {
      this.#invalid(msg.id, decoded.value, [{ message: `the schema threw: ${String(error)}` }]);
      return undefined;
    }
    // An async schema holds the shard's mailbox, so the entity's messages stay in order.
    if (!(result instanceof Promise)) {
      checked(result);
      return undefined;
    }
    return result.then(checked, (error: unknown) => {
      this.#invalid(msg.id, decoded.value, [{ message: `the schema threw: ${String(error)}` }]);
    });
  }

  #invalid(id: string, message: unknown, issues: unknown): void {
    const { hooks, type } = this.#env;
    const recipient = entityPath(type, id);
    hooks.log.warn(`sharding: a message to ${recipient} failed its schema`, { recipient, issues });
    hooks.deadLetter(recipient, message, 'invalid');
  }

  /**
   * Gives `messages` to entity `id`, starting it if it isn't running. While it's stopping they
   * wait for its next incarnation. During a drain, an entity started here stops again once it
   * has handled them.
   */
  #deliver(id: string, messages: readonly Checked[]): void {
    let entity = this.#entities.get(id);
    if (entity?.stopping === true) {
      entity.held.push(...messages);
      return;
    }
    if (entity === undefined) {
      entity = this.#start(id, messages);
      if (entity === undefined) return;
    }
    const { hooks } = this.#env;
    for (const { value, from } of messages) hooks.tellFrom(entity.ref, value, from);
    entity.lastAt = this.#ctx.now();
    if (this.#draining) this.#stopWhenIdle(entity);
  }

  /** Spawns entity `id`. On failure, `messages` are dead letters. */
  #start(id: string, messages: readonly Checked[]): Entity | undefined {
    const env = this.#env;
    let ref: AnyRef;
    try {
      ref = this.#ctx.spawn(env.entity(id), id, env.spawn);
    } catch (error) {
      this.#ctx.log.error(`sharding: could not start ${env.type} "${id}"`, { id, error });
      for (const { value } of messages)
        env.hooks.deadLetter(entityPath(env.type, id), value, 'stopped');
      return undefined;
    }
    this.#ctx.watch(ref);
    const entity: Entity = { id, ref, lastAt: this.#ctx.now(), stopping: false, held: [] };
    this.#entities.set(id, entity);
    this.#byRef.set(ref, id);
    if (env.idleMs !== undefined) this.#armIdle(id, env.idleMs);
    if (env.remember && !this.#remembered.has(id)) {
      this.#remembered.add(id);
      this.#write('remember', id);
    }
    return entity;
  }

  #stopWhenIdle(entity: Entity): void {
    if (entity.stopping) return;
    entity.stopping = true;
    this.#ctx.timers.cancel(idleKey(entity.id));
    this.#env.hooks.stopWhenIdle(entity.ref);
  }

  entityStopped(ref: AnyRef): void {
    const id = this.#byRef.get(ref);
    if (id === undefined) return;
    this.#byRef.delete(ref);
    const entity = this.#entities.get(id);
    this.#entities.delete(id);
    this.#ctx.timers.cancel(idleKey(id));
    if (entity === undefined) return;
    if (!entity.stopping) {
      // It stopped itself, or its supervision stopped it: a remembered one is forgotten, and its
      // next message starts it again.
      if (this.#env.remember && this.#remembered.delete(id)) this.#write('forget', id);
    } else if (entity.held.length > 0) {
      this.#deliver(id, entity.held);
    }
    this.#finishDrain();
  }

  // ---- passivation ----

  #armIdle(id: string, delayMs: number): void {
    this.#ctx.timers.startSingle(idleKey(id), new ShardInternal({ t: 'idle', id }), delayMs);
  }

  #onIdle(id: string): void {
    const entity = this.#entities.get(id);
    const idleMs = this.#env.idleMs;
    if (entity === undefined || entity.stopping || idleMs === undefined) return;
    // One timer per entity, armed for what's left of the idle time rather than reset on every
    // message.
    const left = entity.lastAt + idleMs - this.#ctx.now();
    if (left > 0) this.#armIdle(id, left);
    else this.#stopWhenIdle(entity);
  }

  // ---- handoff ----

  /** Stops every entity once it has handled what it has, then the shard itself. */
  #drain(): void {
    this.#draining = true;
    for (const entity of this.#entities.values()) this.#stopWhenIdle(entity);
    this.#finishDrain();
  }

  #finishDrain(): void {
    if (this.#draining && this.#entities.size === 0) this.#ctx.stop();
  }

  // ---- remembered entities ----

  #recall(): void {
    if (this.#draining) return;
    this.#ctx.pipeToSelf(
      this.#env.store.remembered(this.#lease),
      (result) => new ShardInternal({ t: 'remembered', result }),
    );
  }

  #onRemembered(result: Result<readonly string[]>): void {
    if (this.#draining) return;
    if (!result.ok) {
      this.#ctx.log.warn(`sharding: could not read the entities ${this.#lease} remembers`, {
        error: result.error,
      });
      this.#recallAttempt++;
      const ceiling = Math.min(RECALL_MAX_MS, RECALL_MIN_MS * 2 ** (this.#recallAttempt - 1));
      const delay = Math.round(ceiling * (0.5 + this.#env.hooks.random() / 2));
      this.#ctx.timers.startSingle('recall', new ShardInternal({ t: 'recall' }), delay);
      return;
    }
    for (const id of result.value) {
      this.#remembered.add(id);
      if (!this.#entities.has(id)) this.#start(id, []);
    }
  }

  #write(op: 'remember' | 'forget', id: string): void {
    const { store, hooks } = this.#env;
    const lease = this.#lease;
    this.#writes = this.#writes
      .then(() => (op === 'remember' ? store.remember(lease, id) : store.forget(lease, id)))
      .catch((error: unknown) => {
        hooks.log.warn(`sharding: could not ${op} ${entityPath(this.#env.type, id)}`, {
          id,
          error,
        });
      });
    internalsOf(this.#ctx).track(this.#writes);
  }
}

function idleKey(id: string): string {
  return `idle-${id}`;
}
