// One shard of an entity type, at /system/sharding/<type>/<shard> on the node that holds its lease
// (decision 0030). It owns the shard's entities: it decodes each message its region hands it,
// checks it against the type's schema, and spawns the entity on its first message. Decoding here,
// on the entity's node, means an entity never shares an object with its sender, and a message
// that only works in memory fails on a one-node cluster as it would across nodes (decision 0025).
import { actor } from '../actor.js';
import type { SystemHooks } from '../internal.js';
import type { StandardSchemaV1 } from '../persistence/standard-schema.js';
import type { ActorContext, ActorDef, AnyRef, SpawnOptions } from '../types.js';
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

/** What a shard needs from its entity type and its node. */
export interface ShardEnv {
  readonly type: string;
  readonly hooks: SystemHooks;
  readonly codec: Codec;
  readonly entity: (id: string) => ActorDef<unknown, unknown>;
  readonly spawn: SpawnOptions;
  readonly schema: StandardSchemaV1 | undefined;
}

/** The path an entity's messages are addressed to, and dead letters name: `/sharding/<type>/<id>`. */
export function entityPath(type: string, id: string): string {
  return `/sharding/${type}/${id}`;
}

/** The shard actor's definition. Its state is nothing: its entities are its children. */
export function shardDef(env: ShardEnv): ActorDef<ShardDeliver, null> {
  const { type, hooks, codec, schema } = env;

  const deliver = (ctx: ActorContext<ShardDeliver>, msg: ShardDeliver, message: unknown): void => {
    let child: AnyRef | undefined = ctx.child(msg.id);
    if (child === undefined) {
      try {
        child = ctx.spawn(env.entity(msg.id), msg.id, env.spawn);
      } catch (error) {
        ctx.log.error(`sharding: could not start ${type} "${msg.id}"`, { id: msg.id, error });
        hooks.deadLetter(entityPath(type, msg.id), message, 'stopped');
        return;
      }
    }
    hooks.tellFrom(child, message, msg.from);
  };

  const invalid = (msg: ShardDeliver, message: unknown, issues: unknown): void => {
    const recipient = entityPath(type, msg.id);
    hooks.log.warn(`sharding: a message to ${recipient} failed its schema`, { recipient, issues });
    hooks.deadLetter(recipient, message, 'invalid');
  };

  return actor<ShardDeliver, null>({
    initial: null,
    receive(state, msg, ctx) {
      const decoded = codec.decode(msg.m);
      if (!decoded.ok) {
        const recipient = entityPath(type, msg.id);
        hooks.log.warn(`sharding: a message to ${recipient} can't be decoded: ${decoded.problem}`, {
          recipient,
        });
        hooks.deadLetter(recipient, msg.m, 'unserializable');
        return state;
      }
      if (schema === undefined) {
        deliver(ctx, msg, decoded.value);
        return state;
      }
      const checked = (result: StandardSchemaV1.Result<unknown>): null => {
        if (result.issues === undefined) deliver(ctx, msg, result.value);
        else invalid(msg, decoded.value, result.issues);
        return state;
      };
      let result: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
      try {
        result = schema['~standard'].validate(decoded.value);
      } catch (error) {
        invalid(msg, decoded.value, [{ message: `the schema threw: ${String(error)}` }]);
        return state;
      }
      // An async schema holds the shard's mailbox, so the entity's messages stay in order.
      if (!(result instanceof Promise)) return checked(result);
      return result.then(checked, (error: unknown) => {
        invalid(msg, decoded.value, [{ message: `the schema threw: ${String(error)}` }]);
        return state;
      });
    },
  });
}
