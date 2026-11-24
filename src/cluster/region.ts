// An entity type's region, at /system/sharding/<type> on every node that initialises the type
// (decision 0030). Regions route: a message for an entity goes to its shard here if this node
// holds the shard's lease, to the holder's region if another node does, and otherwise waits here,
// in order, while the region finds the shard a home. Regions talk to each other with ordinary
// remote messages, so the routing is visible as everything else is.
//
// Finding a home always starts from the store, which is the only thing that says who holds a
// lease. If nobody does, the shard's desired owner by rendezvous hashing acquires it: this region,
// or the one it asks with `start`. A region that gets a message for a shard it doesn't hold sends
// it back with `notOwner`, and the sender looks again. Every wait and retry is on the scheduler,
// with jitter from the system's random (decision 0003).
import { actor } from '../actor.js';
import { internalsOf } from '../internal.js';
import { supervise } from '../supervision.js';
import type { ActorContext, ActorDef, ActorRef, AnyRef, Result } from '../types.js';
import type { LeaseKeeper } from './leases.js';
import type { Member } from './membership.js';
import { desiredOwner, shardOf } from './placement.js';
import type { Remoting } from './remoting.js';
import type { AcquireResult, LeaseHolder } from './shard-store.js';
import {
  entityPath,
  shardDef,
  ShardInternal,
  type ShardDeliver,
  type ShardEnv,
  type ShardMsg,
} from './shard.js';
import { keyOf } from './table.js';
import { parseRefUri } from './wire.js';

/** What a region needs from its entity type and its node. */
export interface RegionEnv extends ShardEnv {
  readonly shardCount: number;
  readonly host: boolean;
  readonly bufferSize: number;
  /** How often a hosting region looks for shards to hand off. */
  readonly rebalanceMs: number;
  /** How many handoffs a region runs at once while rebalancing. */
  readonly maxHandoffs: number;
  readonly remoting: Remoting;
  /** This node's leases. Only a hosting node has one. */
  readonly keeper: LeaseKeeper | undefined;
  /** The members as this node sees them, itself included. */
  readonly members: () => readonly Member[];
  /** Called once the region has stopped, so nothing more is sent to it. */
  readonly onStopped: () => void;
}

/** A message for an entity, on its way to its shard. */
export interface Envelope {
  readonly id: string;
  /** The message, as the codec encoded it. */
  readonly m: string;
  /** The original sender's full path, when it was known. */
  readonly from?: string;
  /** How many times regions have sent it back with `notOwner`. */
  readonly bounces?: number;
}

/** Why a region stops its shards as it stops. */
export type StopReason = 'leaving' | 'downed';

/**
 * What a region gets: from entity refs on its own node, a `deliver` with no `back`. From other
 * regions, a `deliver` with `back` set to the sender's region, and the rest of the protocol.
 */
export type RegionMsg =
  | (Envelope & { readonly t: 'deliver'; readonly back?: AnyRef })
  | {
      readonly t: 'hello';
      readonly shardCount: number;
      readonly host: boolean;
      readonly region: AnyRef;
      readonly reply?: true;
    }
  | { readonly t: 'start'; readonly shard: number; readonly back: AnyRef }
  | { readonly t: 'home'; readonly shard: number; readonly holder: string | null }
  | {
      readonly t: 'notOwner';
      readonly shard: number;
      readonly holder: string;
      readonly envelopes: readonly Envelope[];
    }
  | Internal;

type InternalMsg =
  | { readonly t: 'members' }
  | { readonly t: 'retry'; readonly shard: number }
  | {
      readonly t: 'holders';
      readonly shard: number;
      readonly result: Result<readonly LeaseHolder[]>;
    }
  | { readonly t: 'acquired'; readonly shard: number; readonly result: Result<AcquireResult> }
  | { readonly t: 'lost'; readonly shard: number; readonly token: number }
  | { readonly t: 'released'; readonly shard: number }
  | { readonly t: 'rebalance' }
  | { readonly t: 'claim'; readonly result: Result<readonly LeaseHolder[]> }
  | { readonly t: 'stop'; readonly reason: StopReason };

/** A message only this node can send its region: none decodes from the wire as one. */
export class Internal {
  constructor(readonly msg: InternalMsg) {}
}

const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 2_000;
// A message sent back this many times is a dead letter: its shard is moving faster than it.
const MAX_BOUNCES = 5;
// How many backoffs a region waits for a hello from every up member before it places a shard
// without the silent ones: about a second. A member that never initialises the type costs that
// once per shard, and a hello one round trip, so nodes that start together agree on placement.
const HELLO_WAIT_ATTEMPTS = 4;

/** The region actor's definition. Its routing state lives with the incarnation, not in state. */
export function regionDef(env: RegionEnv): ActorDef<RegionMsg, null> {
  let region: Region | undefined;
  return actor<RegionMsg, null>({
    initial: (ctx) => {
      region = new Region(env, ctx);
      return null;
    },
    receive(state, msg) {
      region?.receive(msg);
      return state;
    },
    onSignal(state, signal, ctx) {
      if (signal.type === 'terminated') region?.shardStopped(signal.ref);
      else if (signal.type === 'postStop') {
        region?.stopped(ctx);
        env.onStopped();
      }
      return state;
    },
  });
}

/** Why a shard this node ran was released. */
type ReleaseReason = 'leaseLost' | 'handoff' | StopReason;

/** A shard this node runs. */
interface Local {
  readonly ref: AnyRef;
  readonly token: number;
  /** Set once the shard is stopping, with why. */
  ending: ReleaseReason | undefined;
  /** It's draining for a handoff: once it stops, the lease goes and its messages follow it. */
  handingOff: boolean;
  /** Its `shardReleased` is published, and its lease released or lost. */
  released: boolean;
}

/** A shard whose messages wait here while the region finds it a home. */
interface Slot {
  buffer: Envelope[];
  /**
   * `idle`: nothing in flight. `checking`: reading the store's holders. `acquiring`: taking the
   * lease. `asking`: waiting for the desired owner's `home`. `waiting`: backing off.
   * `handoff`: the shard is draining here, and then its lease is released.
   */
  phase: 'idle' | 'checking' | 'acquiring' | 'asking' | 'waiting' | 'handoff';
  attempt: number;
  /** Regions that asked this one to start the shard, waiting for `home`. */
  waiters: AnyRef[];
  /** The holder that last sent messages back, which the store may still name for a while. */
  refusedBy: string | undefined;
}

/** What a region knows of the same type's region on another node, from its hello. */
interface Peer {
  readonly uid: number;
  readonly host: boolean;
  /** Its shard count differs, so this region never routes to it or places a shard on it. */
  readonly refused: boolean;
}

class Region {
  readonly #env: RegionEnv;
  readonly #ctx: ActorContext<RegionMsg>;
  readonly #self: { readonly address: string; readonly key: string };
  readonly #prefix: string;
  readonly #holders = new Map<number, string>();
  readonly #local = new Map<number, Local>();
  readonly #slots = new Map<number, Slot>();
  readonly #peers = new Map<string, Peer>();
  readonly #greeted = new Set<string>();
  readonly #refs = new Map<string, AnyRef>();
  // Shards being handed off, from the drain until their messages have gone to the new home.
  readonly #handoffs = new Set<number>();
  #members = new Map<string, Member>();
  #stopReason: StopReason = 'leaving';
  // The node is leaving: hand every shard off, then stop.
  #leaving = false;

  constructor(env: RegionEnv, ctx: ActorContext<RegionMsg>) {
    this.#env = env;
    this.#ctx = ctx;
    const { address, uid } = env.remoting.self;
    this.#self = { address, key: keyOf(address, uid) };
    this.#prefix = `${env.type}/`;
    if (env.host) {
      ctx.timers.startPeriodic('rebalance', new Internal({ t: 'rebalance' }), env.rebalanceMs);
    }
  }

  receive(msg: RegionMsg): void {
    if (msg instanceof Internal) {
      this.#internal(msg.msg);
      return;
    }
    const m = msg as unknown;
    if (!isRecord(m)) {
      this.#ignore('a message that isn’t an object');
      return;
    }
    switch (m.t) {
      case 'deliver':
        this.#onDeliver(m);
        return;
      case 'hello':
        this.#onHello(m);
        return;
      case 'start':
        if (this.#isShard(m.shard) && isRef(m.back)) this.#onStart(m.shard, m.back);
        else this.#ignore('a malformed start');
        return;
      case 'home':
        if (this.#isShard(m.shard) && (m.holder === null || typeof m.holder === 'string')) {
          this.#onHome(m.shard, m.holder);
        } else {
          this.#ignore('a malformed home');
        }
        return;
      case 'notOwner':
        this.#onNotOwner(m);
        return;
      default:
        this.#ignore(`a "${String(m.t)}" message`);
    }
  }

  #internal(msg: InternalMsg): void {
    switch (msg.t) {
      case 'members':
        this.#onMembers();
        return;
      case 'retry':
        this.#onRetry(msg.shard);
        return;
      case 'holders':
        this.#onHolders(msg.shard, msg.result);
        return;
      case 'acquired':
        this.#onAcquired(msg.shard, msg.result);
        return;
      case 'lost':
        this.#onLost(msg.shard, msg.token);
        return;
      case 'released':
        this.#onReleased(msg.shard);
        return;
      case 'rebalance':
        this.#onRebalance();
        return;
      case 'claim':
        this.#onClaim(msg.result);
        return;
      case 'stop':
        this.#onStop(msg.reason);
        return;
    }
  }

  // ---- routing ----

  #onDeliver(m: Record<string, unknown>): void {
    const { id, m: text, from, bounces, back } = m;
    if (
      typeof id !== 'string' ||
      typeof text !== 'string' ||
      (from !== undefined && typeof from !== 'string') ||
      (bounces !== undefined && (typeof bounces !== 'number' || !Number.isSafeInteger(bounces)))
    ) {
      this.#ignore('a malformed deliver');
      return;
    }
    const envelope: Envelope = {
      id,
      m: text,
      ...(from === undefined ? {} : { from }),
      ...(bounces === undefined ? {} : { bounces }),
    };
    const shard = shardOf(id, this.#env.shardCount);
    if (back === undefined) {
      this.#route(shard, envelope, true);
      return;
    }
    if (!isRef(back)) {
      this.#ignore('a deliver whose back isn’t a ref');
      return;
    }
    // From another region, which thinks this node holds the shard.
    if (this.#deliverLocally(shard, envelope)) return;
    const slot = this.#slots.get(shard);
    if (slot !== undefined && slot.phase !== 'idle') {
      // This region is finding the shard a home already: it may well be here.
      this.#enqueue(shard, envelope, false);
      return;
    }
    asRegion(back).tell({ t: 'notOwner', shard, holder: this.#self.key, envelopes: [envelope] });
  }

  /** Sends `envelope` on towards its shard, or holds it here until the shard has a home. */
  #route(shard: number, envelope: Envelope, begin: boolean): void {
    if (this.#deliverLocally(shard, envelope)) return;
    const holder = this.#holders.get(shard);
    if (holder !== undefined && holder !== this.#self.key && this.#usable(holder)) {
      const region = this.#regionOf(holder);
      if (region !== undefined) {
        region.tell({ t: 'deliver', ...envelope, back: this.#ctx.self });
        return;
      }
    }
    this.#enqueue(shard, envelope, begin);
  }

  /** Hands `envelope` to the local shard, if this node runs it and still holds its lease. */
  #deliverLocally(shard: number, envelope: Envelope): boolean {
    const local = this.#local.get(shard);
    if (local === undefined || local.ending !== undefined) return false;
    if (this.#env.keeper?.holds(this.#lease(shard)) !== true) return false;
    const msg: ShardDeliver =
      envelope.from === undefined
        ? { t: 'deliver', id: envelope.id, m: envelope.m }
        : { t: 'deliver', id: envelope.id, m: envelope.m, from: envelope.from };
    asShard(local.ref).tell(msg);
    return true;
  }

  #enqueue(shard: number, envelope: Envelope, begin: boolean): void {
    const slot = this.#slot(shard);
    if (slot.buffer.length >= this.#env.bufferSize) {
      this.#deadLetter(envelope, 'unreachable');
      return;
    }
    slot.buffer.push(envelope);
    if (begin && slot.phase === 'idle') this.#begin(shard, slot);
  }

  #slot(shard: number): Slot {
    let slot = this.#slots.get(shard);
    if (slot === undefined) {
      slot = { buffer: [], phase: 'idle', attempt: 0, waiters: [], refusedBy: undefined };
      this.#slots.set(shard, slot);
    }
    return slot;
  }

  /** Starts finding the shard a home: first, ask the store who holds it. */
  #begin(shard: number, slot: Slot): void {
    if (slot.buffer.length === 0 && slot.waiters.length === 0) {
      this.#dropSlot(shard);
      return;
    }
    if (this.#local.has(shard)) {
      // Its last incarnation here is still stopping.
      this.#backoff(shard, slot);
      return;
    }
    slot.phase = 'checking';
    this.#ctx.pipeToSelf(
      this.#env.store.holders(this.#prefix),
      (result) => new Internal({ t: 'holders', shard, result }),
    );
  }

  #onHolders(shard: number, result: Result<readonly LeaseHolder[]>): void {
    if (result.ok) this.#learn(result.value);
    const slot = this.#slots.get(shard);
    if (slot?.phase !== 'checking') return;
    if (!result.ok) {
      this.#ctx.log.warn(`sharding: could not read the holders of ${this.#env.type}`, {
        error: result.error,
      });
      this.#backoff(shard, slot);
      return;
    }
    const holder = this.#holders.get(shard);
    if (
      holder !== undefined &&
      holder !== this.#self.key &&
      holder !== slot.refusedBy &&
      this.#usable(holder)
    ) {
      this.#flush(shard, slot);
      return;
    }
    this.#place(shard, slot);
  }

  /** Replaces the cache with the store's holders, keeping the shards this node runs. */
  #learn(holders: readonly LeaseHolder[]): void {
    const seen = new Set<number>();
    for (const { lease, holder } of holders) {
      if (!lease.startsWith(this.#prefix)) continue;
      const shard = Number(lease.slice(this.#prefix.length));
      if (!this.#isShard(shard)) continue;
      seen.add(shard);
      if (!this.#local.has(shard)) this.#holders.set(shard, holder);
    }
    for (const shard of [...this.#holders.keys()]) {
      if (!seen.has(shard) && !this.#local.has(shard)) this.#holders.delete(shard);
    }
  }

  /** Nobody usable holds the shard: its desired owner should take it. */
  #place(shard: number, slot: Slot): void {
    if (slot.attempt < HELLO_WAIT_ATTEMPTS && this.#silentPeers()) {
      this.#backoff(shard, slot);
      return;
    }
    const owner = desiredOwner(this.#lease(shard), this.#candidates());
    if (owner === undefined && this.#leaving) {
      // Nowhere to go: what waits becomes dead letters as the region stops.
      this.#handoffs.delete(shard);
      slot.phase = 'idle';
      this.#checkLeft();
      return;
    }
    if (owner === undefined) {
      this.#backoff(shard, slot);
      return;
    }
    if (owner === this.#self.address) {
      this.#acquire(shard, slot);
      return;
    }
    const member = [...this.#members.values()].find(
      (m) => m.address === owner && m.status === 'up',
    );
    const region = member === undefined ? undefined : this.#regionAt(member.address, member.uid);
    if (region === undefined) {
      this.#backoff(shard, slot);
      return;
    }
    region.tell({ t: 'start', shard, back: this.#ctx.self });
    // The timer is the ask's timeout: no home by then, and the region looks again.
    this.#backoff(shard, slot);
    slot.phase = 'asking';
  }

  #acquire(shard: number, slot: Slot): void {
    const keeper = this.#env.keeper;
    if (keeper === undefined) {
      this.#backoff(shard, slot);
      return;
    }
    slot.phase = 'acquiring';
    this.#ctx.pipeToSelf(
      keeper.acquire(this.#lease(shard)),
      (result) => new Internal({ t: 'acquired', shard, result }),
    );
  }

  #onAcquired(shard: number, result: Result<AcquireResult>): void {
    const slot = this.#slot(shard);
    const waiters = slot.waiters;
    slot.waiters = [];
    let holder: string | null = null;
    if (!result.ok) {
      this.#ctx.log.warn(`sharding: could not acquire ${this.#lease(shard)}`, {
        error: result.error,
      });
    } else if (result.value.acquired) {
      this.#startShard(shard, result.value.token);
      holder = this.#self.key;
    } else {
      holder = result.value.holder;
      this.#holders.set(shard, holder);
    }
    for (const back of waiters) asRegion(back).tell({ t: 'home', shard, holder });
    if (holder === null) {
      this.#backoff(shard, slot);
    } else if (holder === slot.refusedBy) {
      // The holder that sent these back still has the lease in the store, though it has let the
      // shard go: wait a backoff for it to be released or expire, rather than bounce them
      // straight back. Only once, in case it has taken the shard back since.
      slot.refusedBy = undefined;
      this.#backoff(shard, slot);
    } else {
      this.#flush(shard, slot);
    }
  }

  #startShard(shard: number, token: number): void {
    const env = this.#env;
    env.hooks.publish({
      type: 'shardAcquired',
      entityType: env.type,
      shard,
      node: this.#self.key,
      token,
    });
    const ref = this.#ctx.spawn(shardDef(env, this.#lease(shard)), String(shard), {
      supervision: supervise.resume(),
    });
    this.#ctx.watch(ref);
    this.#local.set(shard, { ref, token, ending: undefined, handingOff: false, released: false });
    this.#holders.set(shard, this.#self.key);
  }

  /** Routes what waited, now the shard has a home. What still can't go backs off and retries. */
  #flush(shard: number, slot: Slot): void {
    const waiting = slot.buffer;
    slot.buffer = [];
    slot.phase = 'idle';
    for (const envelope of waiting) this.#route(shard, envelope, false);
    if (slot.buffer.length > 0) {
      this.#backoff(shard, slot);
      return;
    }
    // A handoff is over once what waited for it has gone on.
    if (this.#handoffs.delete(shard)) this.#checkLeft();
    if (slot.waiters.length === 0) {
      this.#ctx.timers.cancel(retryKey(shard));
      this.#dropSlot(shard);
    }
  }

  #dropSlot(shard: number): void {
    this.#slots.delete(shard);
    if (this.#handoffs.delete(shard)) this.#checkLeft();
  }

  #backoff(shard: number, slot: Slot): void {
    slot.attempt++;
    slot.phase = 'waiting';
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (slot.attempt - 1));
    const delay = Math.round(ceiling * (0.5 + this.#env.hooks.random() / 2));
    this.#ctx.timers.startSingle(retryKey(shard), new Internal({ t: 'retry', shard }), delay);
  }

  #onRetry(shard: number): void {
    const slot = this.#slots.get(shard);
    if (slot === undefined || (slot.phase !== 'waiting' && slot.phase !== 'asking')) return;
    this.#begin(shard, slot);
  }

  #onStart(shard: number, back: AnyRef): void {
    if (this.#local.has(shard)) {
      const holds = this.#local.get(shard)?.ending === undefined;
      asRegion(back).tell({ t: 'home', shard, holder: holds ? this.#self.key : null });
      return;
    }
    if (!this.#env.host || this.#env.keeper === undefined || this.#leaving) {
      asRegion(back).tell({ t: 'home', shard, holder: null });
      return;
    }
    const slot = this.#slot(shard);
    slot.waiters.push(back);
    if (slot.phase === 'acquiring') return;
    this.#ctx.timers.cancel(retryKey(shard));
    this.#acquire(shard, slot);
  }

  #onHome(shard: number, holder: string | null): void {
    if (holder !== null && holder !== this.#self.key && !this.#local.has(shard)) {
      this.#holders.set(shard, holder);
    }
    const slot = this.#slots.get(shard);
    if (slot?.phase !== 'asking') return;
    this.#ctx.timers.cancel(retryKey(shard));
    slot.refusedBy = undefined;
    if (holder === null) this.#backoff(shard, slot);
    else this.#flush(shard, slot);
  }

  #onNotOwner(m: Record<string, unknown>): void {
    const { shard, holder, envelopes } = m;
    if (!this.#isShard(shard) || typeof holder !== 'string' || !Array.isArray(envelopes)) {
      this.#ignore('a malformed notOwner');
      return;
    }
    if (this.#holders.get(shard) === holder) this.#holders.delete(shard);
    const slot = this.#slot(shard);
    slot.refusedBy = holder;
    for (const item of envelopes as unknown[]) {
      if (!isEnvelope(item)) continue;
      const bounces = (item.bounces ?? 0) + 1;
      if (bounces > MAX_BOUNCES) {
        this.#ctx.log.warn(
          `sharding: a message to ${entityPath(this.#env.type, item.id)} came back ${String(bounces)} times`,
          { id: item.id },
        );
        this.#deadLetter(item, 'unreachable');
        continue;
      }
      this.#enqueue(shard, { ...item, bounces }, true);
    }
    if (slot.buffer.length === 0 && slot.phase === 'idle' && slot.waiters.length === 0) {
      this.#dropSlot(shard);
    }
  }

  // ---- shards this node runs ----

  #onLost(shard: number, token: number): void {
    const local = this.#local.get(shard);
    if (local?.token !== token || local.released) return;
    // At the deadline, whatever else is going on, a handoff included: the entities stop now.
    local.ending ??= 'leaseLost';
    local.released = true;
    this.#released(shard, token, 'leaseLost');
    this.#holders.delete(shard);
    this.#ctx.stop(local.ref);
  }

  shardStopped(ref: AnyRef): void {
    for (const [shard, local] of this.#local) {
      if (local.ref !== ref) continue;
      this.#local.delete(shard);
      if (local.ending === undefined) {
        // Shards resume after a failure, so only a stop the region didn't ask for gets here.
        this.#ctx.log.error(`sharding: shard ${this.#lease(shard)} stopped by itself`);
        this.#release(shard, local, this.#stopReason);
      }
      if (this.#holders.get(shard) === this.#self.key) this.#holders.delete(shard);
      if (local.handingOff) {
        // Its entities have all stopped: now the lease can go, and then the messages follow.
        if (local.released) this.#onReleased(shard);
        else this.#release(shard, local, local.ending ?? 'handoff', this.#ctx, true);
        return;
      }
      const slot = this.#slots.get(shard);
      if (slot?.phase === 'waiting') this.#begin(shard, slot);
      return;
    }
  }

  /** The region has stopped, after its shards: their entities are gone, so their leases go. */
  stopped(ctx: ActorContext<RegionMsg>): void {
    for (const [shard, local] of this.#local) {
      if (!local.released) this.#release(shard, local, local.ending ?? this.#stopReason, ctx);
    }
    this.#local.clear();
    this.#handoffs.clear();
    for (const slot of this.#slots.values()) {
      for (const envelope of slot.buffer) this.#deadLetter(envelope, 'stopped');
    }
    this.#slots.clear();
  }

  /**
   * Publishes the shard's release and gives its lease up. With `then`, tells the region
   * `released` once the store has answered, either way, so a handoff can go on.
   */
  #release(
    shard: number,
    local: Local,
    reason: ReleaseReason,
    ctx: ActorContext<RegionMsg> = this.#ctx,
    then = false,
  ): void {
    local.released = true;
    this.#released(shard, local.token, reason);
    const keeper = this.#env.keeper;
    if (keeper === undefined) return;
    const lease = this.#lease(shard);
    const releasing = keeper.release(lease).catch((error: unknown) => {
      // It expires in the store instead.
      this.#env.hooks.log.warn(`sharding: could not release ${lease}`, { error });
    });
    if (then) ctx.pipeToSelf(releasing, () => new Internal({ t: 'released', shard }));
    else internalsOf(ctx).track(releasing);
  }

  #released(shard: number, token: number, reason: ReleaseReason): void {
    this.#env.hooks.publish({
      type: 'shardReleased',
      entityType: this.#env.type,
      shard,
      node: this.#self.key,
      token,
      reason,
    });
  }

  // ---- rebalancing and handoff ----

  /**
   * Hands off shards whose desired owner is now another node, a few at a time. With `remember`,
   * also takes the shards nobody holds that this node should own, so their remembered entities
   * start without waiting for a message.
   */
  #onRebalance(): void {
    if (this.#leaving || this.#env.keeper === undefined) return;
    if (this.#env.remember && !this.#silentPeers()) {
      this.#ctx.pipeToSelf(
        this.#env.store.holders(this.#prefix),
        (result) => new Internal({ t: 'claim', result }),
      );
    }
    const candidates = this.#candidates();
    for (const [shard, local] of this.#local) {
      if (this.#handoffs.size >= this.#env.maxHandoffs) return;
      if (local.ending !== undefined) continue;
      const owner = desiredOwner(this.#lease(shard), candidates);
      if (owner !== undefined && owner !== this.#self.address) {
        this.#handOff(shard, local, 'handoff');
      }
    }
  }

  #onClaim(result: Result<readonly LeaseHolder[]>): void {
    if (!result.ok) {
      this.#ctx.log.warn(`sharding: could not read the holders of ${this.#env.type}`, {
        error: result.error,
      });
      return;
    }
    if (this.#leaving) return;
    this.#learn(result.value);
    const held = new Set(result.value.map(({ lease }) => lease));
    const candidates = this.#candidates();
    for (let shard = 0; shard < this.#env.shardCount; shard++) {
      const lease = this.#lease(shard);
      if (held.has(lease) || this.#local.has(shard) || this.#slots.has(shard)) continue;
      if (desiredOwner(lease, candidates) !== this.#self.address) continue;
      this.#acquire(shard, this.#slot(shard));
    }
  }

  /**
   * Starts moving a shard: its messages wait here from now on, and its entities stop once
   * they've handled what they have, a persist included. The lease goes only after that.
   */
  #handOff(shard: number, local: Local, reason: 'handoff' | 'leaving'): void {
    local.ending = reason;
    local.handingOff = true;
    this.#handoffs.add(shard);
    const slot = this.#slot(shard);
    this.#ctx.timers.cancel(retryKey(shard));
    slot.phase = 'handoff';
    asShard(local.ref).tell(new ShardInternal({ t: 'drain' }));
  }

  /** A handed-off shard's lease is gone: its desired owner takes it, and what waited follows. */
  #onReleased(shard: number): void {
    const slot = this.#slots.get(shard);
    if (slot?.phase !== 'handoff') return;
    slot.phase = 'idle';
    slot.attempt = 0;
    slot.refusedBy = undefined;
    this.#place(shard, slot);
  }

  #onStop(reason: StopReason): void {
    this.#stopReason = reason;
    if (reason === 'downed') {
      this.#ctx.stop();
      return;
    }
    if (this.#leaving) return;
    this.#leaving = true;
    this.#members = new Map(this.#env.members().map((m) => [keyOf(m.address, m.uid), m]));
    this.#ctx.timers.cancel('rebalance');
    for (const [shard, local] of this.#local) {
      if (local.ending === undefined) this.#handOff(shard, local, 'leaving');
    }
    this.#checkLeft();
  }

  /** A leaving region stops once every shard it held has gone, with its messages. */
  #checkLeft(): void {
    if (this.#leaving && this.#local.size === 0 && this.#handoffs.size === 0) this.#ctx.stop();
  }

  // ---- members and peers ----

  #onMembers(): void {
    this.#members = new Map(this.#env.members().map((m) => [keyOf(m.address, m.uid), m]));
    for (const [key, member] of this.#members) {
      if (key === this.#self.key || member.status === 'down' || this.#greeted.has(key)) continue;
      this.#greeted.add(key);
      this.#regionAt(member.address, member.uid)?.tell(this.#hello(false));
    }
    this.#kick();
  }

  #hello(reply: boolean): RegionMsg {
    const { shardCount, host } = this.#env;
    const hello = { t: 'hello', shardCount, host, region: this.#ctx.self } as const;
    return reply ? { ...hello, reply: true } : hello;
  }

  #onHello(m: Record<string, unknown>): void {
    const { shardCount, host, region, reply } = m;
    const address = isRef(region) ? parseRefUri(region.path) : undefined;
    if (
      address === undefined ||
      typeof shardCount !== 'number' ||
      typeof host !== 'boolean' ||
      address.address === this.#self.address
    ) {
      this.#ignore('a malformed hello');
      return;
    }
    const refused = shardCount !== this.#env.shardCount;
    const known = this.#peers.get(address.address);
    this.#peers.set(address.address, { uid: address.uid, host, refused });
    if (refused && !(known?.uid === address.uid && known.refused)) {
      this.#ctx.log.error(
        `sharding: refused ${address.address} for ${this.#env.type}: its shardCount is ` +
          `${String(shardCount)}, and this node's is ${String(this.#env.shardCount)}`,
        { address: address.address, shardCount, expected: this.#env.shardCount },
      );
    }
    const key = keyOf(address.address, address.uid);
    if (reply !== true) asRegion(region as AnyRef).tell(this.#hello(true));
    this.#greeted.add(key);
    this.#kick();
  }

  /** Members or peers changed: shards that were backing off look again now. */
  #kick(): void {
    for (const [shard, slot] of this.#slots) {
      if (slot.phase !== 'waiting') continue;
      this.#ctx.timers.cancel(retryKey(shard));
      this.#begin(shard, slot);
    }
  }

  /** Whether an up, reachable member hasn't said yet whether it hosts the type. */
  #silentPeers(): boolean {
    for (const [key, member] of this.#members) {
      if (key === this.#self.key || member.status !== 'up' || !member.reachable) continue;
      if (this.#peers.get(member.address)?.uid !== member.uid) return true;
    }
    return false;
  }

  /** The addresses that may own a shard: up, reachable from here, and hosting the type. */
  #candidates(): string[] {
    const out: string[] = [];
    for (const [key, member] of this.#members) {
      if (member.status !== 'up' || !member.reachable) continue;
      if (key === this.#self.key) {
        if (this.#env.host && !this.#leaving) out.push(member.address);
        continue;
      }
      const peer = this.#peers.get(member.address);
      if (peer?.uid === member.uid && peer.host && !peer.refused) out.push(member.address);
    }
    return out;
  }

  /**
   * Whether messages can go to the holder: a member this node can reach, that isn't down, and
   * wasn't refused. Messages for a holder this node can't reach wait here and look again, rather
   * than in remoting's buffer until the holder is downed, so a killed holder's shards answer from
   * elsewhere as soon as its lease expires (found by T8, decision 0031).
   */
  #usable(holder: string): boolean {
    const member = this.#members.get(holder);
    if (member === undefined || member.status === 'down' || !member.reachable) return false;
    const peer = this.#peers.get(member.address);
    return !(peer?.uid === member.uid && peer.refused);
  }

  #regionOf(holder: string): ActorRef<RegionMsg> | undefined {
    const member = this.#members.get(holder);
    return member === undefined ? undefined : this.#regionAt(member.address, member.uid);
  }

  #regionAt(address: string, uid: number): ActorRef<RegionMsg> | undefined {
    const key = keyOf(address, uid);
    let ref = this.#refs.get(key);
    if (ref === undefined) {
      const { cluster } = this.#env.remoting.self;
      const uri = `troupe://${cluster}@${address}#${String(uid)}/system/sharding/${this.#env.type}`;
      try {
        ref = this.#env.remoting.ref(uri);
      } catch {
        return undefined;
      }
      this.#refs.set(key, ref);
    }
    return asRegion(ref);
  }

  // ---- helpers ----

  #lease(shard: number): string {
    return `${this.#prefix}${String(shard)}`;
  }

  #isShard(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value < this.#env.shardCount
    );
  }

  #deadLetter(envelope: Envelope, reason: 'unreachable' | 'stopped'): void {
    const decoded = this.#env.codec.decode(envelope.m);
    this.#env.hooks.deadLetter(
      entityPath(this.#env.type, envelope.id),
      decoded.ok ? decoded.value : envelope.m,
      reason,
    );
  }

  #ignore(what: string): void {
    this.#ctx.log.warn(`sharding: ${this.#env.type} ignored ${what}`);
  }
}

/** A shard's ref, with its protocol. */
function asShard(ref: AnyRef): ActorRef<ShardMsg> {
  return ref as unknown as ActorRef<ShardMsg>;
}

/** A region's ref, with its protocol: refs from the wire arrive as refs of no protocol. */
function asRegion(ref: AnyRef): ActorRef<RegionMsg> {
  return ref as unknown as ActorRef<RegionMsg>;
}

function retryKey(shard: number): string {
  return `retry-${String(shard)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRef(value: unknown): value is AnyRef {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.tell === 'function' &&
    typeof value.ask === 'function'
  );
}

function isEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value)) return false;
  const { id, m, from, bounces } = value;
  return (
    typeof id === 'string' &&
    typeof m === 'string' &&
    (from === undefined || typeof from === 'string') &&
    (bounces === undefined || (typeof bounces === 'number' && Number.isSafeInteger(bounces)))
  );
}
