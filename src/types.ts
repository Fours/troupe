import type { Logger } from './logger.js';
import type { Scheduler } from './scheduler.js';
import type { SupervisorStrategy } from './supervision.js';

// These interfaces grow task by task through milestone 1: each one holds only what's built.

/**
 * A handle for sending messages to one actor. It's the only way to reach an actor: you never hold
 * the actor itself, which is what lets a ref point at an actor on another node.
 *
 * `tell` is a property, not a method, so `ActorRef` is contravariant in `M`: a ref that accepts
 * more messages can stand in for one that accepts fewer, never the other way round.
 */
export interface ActorRef<M> {
  /**
   * Where the actor lives. A local actor's path is its place in the hierarchy, such as
   * `/user/box-office`. An actor on another node in a cluster has the full form, its cluster,
   * node address and uid, then the path, such as `troupe://festival@node-2:2552#17/user/crowd`,
   * so two refs with the same path are the same actor. An entity ref's path is
   * `/sharding/<type>/<id>`, the same on every node, wherever the entity lives.
   */
  readonly path: string;
  /**
   * Sends `msg` to the actor's mailbox and returns at once. Never throws: a message that can't be
   * delivered becomes a dead letter.
   */
  readonly tell: (msg: M) => void;
  /**
   * Sends a request and waits for one reply. `build` gets a temporary ref under `/temp` and
   * returns the message to send, which usually carries that ref as its `replyTo`. The first reply
   * resolves the promise. Later replies become `askCompleted` dead letters.
   *
   * `R` can't be inferred from the protocol, so give it: `ref.ask<number>((replyTo) => ...)`, or
   * annotate `replyTo` as `ActorRef<number>`.
   *
   * Asking an actor that has stopped times out rather than failing fast, because a remote ref
   * can't know either (decision 0009).
   * @returns A promise of the first reply. It rejects with `AskTimeoutError` if none arrives in
   * time, with whatever `build` threw if it throws (and then nothing is sent), and with
   * `ActorSystemTerminatedError` once the system is terminating.
   * @throws TypeError for options that can't be used.
   */
  readonly ask: <R>(build: (replyTo: ActorRef<R>) => M, opts?: AskOptions) => Promise<R>;
}

/** Options for one `ask`. */
export interface AskOptions {
  /** How long to wait for the reply, in ms. Default: the system's `askTimeoutMs`. */
  timeoutMs?: number;
}

/** Why a message became a dead letter. See the `deadLetter` event. */
export type DeadLetterReason =
  | 'mailboxFull'
  | 'stopped'
  | 'askCompleted'
  | 'terminated'
  | 'unreachable'
  | 'unserializable'
  | 'invalid';

/** A ref to an actor of any protocol, for watching, stopping and comparing. */
export type AnyRef = ActorRef<never>;

/** How a promise settled, as `pipeToSelf` delivers it. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * What `pipeToSelf` needs from an `AbortSignal`, so the core needs no DOM or Node types. Every
 * runtime's `AbortSignal` fits it (decision 0038).
 */
export interface PipeSignal {
  /** Whether it has aborted already. */
  readonly aborted: boolean;
  /** Why it aborted: what the pipe delivers as its error. */
  readonly reason: unknown;
  /** Adds the listener the pipe waits on. */
  addEventListener(type: 'abort', listener: () => void): void;
  /** Removes it, once the promise has settled first. */
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Options for `pipeToSelf`. */
export interface PipeOptions {
  /**
   * Ends the pipe when it aborts: the actor gets `map({ ok: false, error: signal.reason })` at
   * once, without waiting for the promise, and whatever the promise does later is ignored. A pipe
   * with a signal doesn't count as busy for the testkit's `settle`, so `advance` lets time pass
   * while it's pending. Abort it from one of the actor's timers or from its `postStop`, so
   * something on the scheduler always ends it (decision 0038).
   */
  readonly signal?: PipeSignal | undefined;
}

/**
 * Keyed timers that send the actor a message. They belong to one incarnation: every timer is
 * cancelled when the actor stops or restarts, and a stale context's timer methods do nothing.
 */
export interface Timers<M> {
  /**
   * Sends `msg` once, after `delayMs`. Replaces any timer with the same key.
   * @throws TypeError unless `key` is a string and `delayMs` an integer of at least 0.
   */
  startSingle(key: string, msg: M, delayMs: number): void;
  /**
   * Sends `msg` every `intervalMs`, measured from each firing, until cancelled. Replaces any timer
   * with the same key.
   * @throws TypeError unless `key` is a string and `intervalMs` a positive integer.
   */
  startPeriodic(key: string, msg: M, intervalMs: number): void;
  /**
   * Cancels the timer with this key, if there is one. Its message is never received, even if it's
   * already in the mailbox.
   */
  cancel(key: string): void;
  /** Cancels every timer. */
  cancelAll(): void;
  /**
   * True while the timer with this key can still deliver: a periodic one until it's cancelled, a
   * single one until its message has been received.
   */
  isActive(key: string): boolean;
}

/**
 * What an actor can see and do while it runs. Passed to `initial`, `receive` and `onSignal`. It
 * belongs to one incarnation of the actor: once that has stopped or restarted, `spawn` throws and
 * `watch` does nothing. A restart gets a new context, with the same `self`.
 */
export interface ActorContext<M> {
  /** This actor's own ref. The same object `spawn` returned. */
  readonly self: ActorRef<M>;
  /** The system logger, with `{ path }` added to every entry. */
  readonly log: Logger;
  /** The scheduler's current time, in ms. */
  now(): number;
  /**
   * Starts a child actor under this one and returns its ref at once.
   * @param name Optional. Generated as `$1`, `$2` and so on when omitted.
   * @throws ActorNameError for an invalid, reserved or taken name.
   * @throws ActorStoppedError once this incarnation is stopping, restarting or has stopped.
   * @throws ActorSystemTerminatedError once the system is terminating.
   * @throws TypeError for a definition or options that can't be used.
   */
  spawn<C, CS>(def: ActorDef<C, CS>, name?: string, opts?: SpawnOptions): ActorRef<C>;
  /**
   * Stops this actor after its current message, or stops a child after its current message,
   * ahead of anything else in its mailbox. Stopping a child that has already terminated does
   * nothing.
   * @param ref Omit, or pass `ctx.self`, to stop this actor.
   * @throws NotAChildError if `ref` is neither this actor nor one of its children.
   */
  stop(ref?: AnyRef): void;
  /**
   * Asks to be told when `ref` stops, with a `terminated` signal. Watching twice is the same as
   * once, and watching an actor that has already terminated signals at once.
   * @throws TypeError if `ref` isn't an actor of this system.
   */
  watch(ref: AnyRef): void;
  /**
   * Stops watching `ref`. No `terminated` for it arrives afterwards, even one already queued.
   * @throws TypeError if `ref` isn't an actor of this system.
   */
  unwatch(ref: AnyRef): void;
  /** The child with this name, until it has terminated. */
  child(name: string): AnyRef | undefined;
  /** The children that haven't terminated yet, in spawn order. */
  children(): readonly AnyRef[];
  /** This incarnation's timers. */
  readonly timers: Timers<M>;
  /**
   * Waits for `promise` without holding the mailbox, then sends the actor `map(result)`. `map`
   * runs inside the actor when that message is taken, so a mapper that throws is a failure for
   * supervision. If the actor has stopped by then, the raw `Result` becomes a dead letter. Unlike
   * timers, a result still arrives after a restart, as a `self.tell` would. With `opts.signal`,
   * the signal aborting ends the pipe early, and the pipe isn't busy work for `settle`
   * ({@link PipeOptions}).
   * @throws TypeError if `map` isn't a function, or `opts` has an unknown key or a `signal` that
   * isn't an abort signal.
   */
  pipeToSelf<T>(promise: PromiseLike<T>, map: (result: Result<T>) => M, opts?: PipeOptions): void;
}

/** A lifecycle event, delivered to `onSignal`. */
export type Signal =
  /**
   * The actor failed and is about to restart. Runs with the old state, before the children are
   * stopped. Skipped when `initial` failed, since there's no state.
   */
  | { readonly type: 'preRestart'; readonly error: unknown }
  /** The actor has stopped, after all its children. The last thing it runs. */
  | { readonly type: 'postStop' }
  /**
   * An actor this one watches has terminated. `failure` is present when it stopped because it
   * failed.
   */
  | { readonly type: 'terminated'; readonly ref: AnyRef; readonly failure?: unknown };

/**
 * An actor definition: an initial state and a reducer. Create one with `actor()`, and spawn it
 * as often as you like. State should be plain data (decision 0001).
 */
export interface ActorDef<M, S> {
  /**
   * The starting state, or a factory for it. It runs as the actor's first step, after `spawn`
   * returns and before any message. A function is always called as a factory.
   */
  initial: S | ((ctx: ActorContext<M>) => S);
  /**
   * Handles one message and returns the next state. If it returns a promise, the actor takes no
   * other message until the promise settles (decision 0002).
   */
  receive(state: S, msg: M, ctx: ActorContext<M>): S | Promise<S>;
  /**
   * Handles lifecycle signals. Optional. The state returned from `terminated` becomes the new
   * state, and anything returned from `preRestart` or `postStop` is ignored. A promise holds the
   * mailbox, as in `receive`. A throw in `preRestart` or `postStop` is logged, and the restart or
   * stop goes ahead.
   */
  onSignal?(state: S, signal: Signal, ctx: ActorContext<M>): S | Promise<S>;
}

/** Options for one `spawn`. */
export interface SpawnOptions {
  /** What happens when the actor fails (decision 0006). Default `supervise.stop()`. */
  supervision?: SupervisorStrategy;
  /** Mailbox limits. Default: unbounded. */
  mailbox?: {
    /** The most messages the mailbox holds. A `tell` past it becomes a `mailboxFull` dead letter. */
    capacity?: number;
  };
}

/** Options for `createActorSystem`. Every field is optional. */
export interface ActorSystemOptions {
  /** The system's name: lower-case letters, digits and `-`. Default `"troupe"`. */
  name?: string;
  /** Where time and scheduling come from (decision 0003). Default `realScheduler()`. */
  scheduler?: Scheduler;
  /** Where chance comes from, for backoff jitter (decision 0003). Default `Math.random`. */
  random?: () => number;
  /** Where logs go. Default `consoleLogger("warn")`. */
  logger?: Logger;
  /** How long `ask` waits for a reply when it isn't given `timeoutMs`, in ms. Default 5,000. */
  askTimeoutMs?: number;
  /** How many messages one actor runs per turn before others get a go. Default 10. */
  throughput?: number;
  /** How many messages run in a row before the dispatcher yields to the event loop. Default 1,000. */
  yieldAfter?: number;
}

type Timestamped<E> = E extends unknown ? { readonly seq: number; readonly at: number } & E : never;

/**
 * Something that happened in the system. `seq` orders events across the system: each event takes
 * the next one. It doesn't count a subscriber's events, since one that didn't ask for message
 * events sees gaps while another subscriber did. `at` is the scheduler's time.
 */
export type SystemEvent = Timestamped<
  | { readonly type: 'spawned'; readonly path: string }
  /** An actor has terminated. `failure` is present when it stopped because it failed. */
  | { readonly type: 'stopped'; readonly path: string; readonly failure?: unknown }
  /** An actor failed, and supervision chose `directive`. */
  | {
      readonly type: 'failed';
      readonly path: string;
      readonly error: unknown;
      readonly directive: 'stop' | 'resume' | 'restart';
    }
  /**
   * An actor is about to run `initial` again. `attempt` counts restarts from 1, since the
   * restart window or the backoff last reset. `delayMs` is the backoff it waited, 0 for a restart.
   */
  | {
      readonly type: 'restarted';
      readonly path: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  /**
   * A persistent actor's journal append succeeded and its events were applied. They hold sequence
   * numbers `fromSeq` to `toSeq`.
   */
  | {
      readonly type: 'persisted';
      readonly path: string;
      readonly persistenceId: string;
      readonly fromSeq: number;
      readonly toSeq: number;
    }
  /**
   * A persistent actor finished recovering, with `lastSeq` the sequence number of its last event.
   * `snapshotSeq` is where its snapshot left off, 0 without one, so `lastSeq - snapshotSeq` events
   * were replayed. (Not `seq`, which every event already has: its place in the event stream.)
   */
  | {
      readonly type: 'recovered';
      readonly path: string;
      readonly persistenceId: string;
      readonly snapshotSeq: number;
      readonly lastSeq: number;
    }
  /**
   * A message went into an actor's mailbox. Published only to subscribers that asked for
   * messages. Every one ends with exactly one `processed`, or a `deadLetter` with its `id`.
   */
  | {
      readonly type: 'delivered';
      readonly path: string;
      /** Unique per message in this system, so the event that ends it can be matched to it. */
      readonly id: number;
      /**
       * The sending actor's path, when it's known: the actor whose handler was running when the
       * message was sent, before any `await` (decision 0020). Absent for a send after an `await`,
       * from a timer, or from outside any actor.
       */
      readonly from?: string;
      /** The message itself, not a copy. */
      readonly message: unknown;
      /** The mailbox's size after this message went in. */
      readonly depth: number;
    }
  /**
   * An actor finished handling a message, including any async work it awaited. Published only to
   * subscribers that asked for messages. When the handler fails, this comes before the `failed`.
   */
  | {
      readonly type: 'processed';
      readonly path: string;
      /** The `id` of the message's `delivered`. */
      readonly id: number;
      /** Scheduler time from taking the message to settling. 0 under virtual time for sync work. */
      readonly durationMs: number;
      /** The mailbox's size after this message came out. */
      readonly depth: number;
      /** Whether the handler returned a different state object. */
      readonly stateChanged: boolean;
      /** Present, and true, for a cancelled timer's message, which no handler saw. */
      readonly skipped?: true;
    }
  /**
   * In a cluster, a member joined, in this node's view: this node itself once it's in the
   * cluster, or another node it has learned of (decision 0028). A member is one incarnation of a
   * node: its address and its uid, new on every start.
   */
  | { readonly type: 'memberUp'; readonly address: string; readonly uid: number }
  /** In a cluster, a member began leaving gracefully. Placement stops using it. */
  | { readonly type: 'memberLeaving'; readonly address: string; readonly uid: number }
  /**
   * In a cluster, a member was downed, by this node or another, after being unreachable too long.
   * Messages to it are `unreachable` dead letters, and watches on its actors signal `terminated`.
   * It stays in the table, as `down`, until a new incarnation at its address replaces it.
   */
  | { readonly type: 'memberDown'; readonly address: string; readonly uid: number }
  /**
   * In a cluster, a member is gone from this node's table: it left, or a new incarnation at its
   * address replaced it.
   */
  | { readonly type: 'memberRemoved'; readonly address: string; readonly uid: number }
  /**
   * In a cluster, this node stopped hearing a member's heartbeats, or started again. Each node's
   * own view, never gossiped.
   */
  | {
      readonly type: 'reachability';
      readonly address: string;
      readonly uid: number;
      readonly reachable: boolean;
    }
  /**
   * In a cluster, this node acquired the lease on a shard of an entity type and started it
   * (decision 0030). `node` is this node's holder name, `<address>#<uid>`. `token` goes up by one
   * every time the lease changes hands, so a history can tell one ownership from the next.
   */
  | {
      readonly type: 'shardAcquired';
      readonly entityType: string;
      readonly shard: number;
      readonly node: string;
      readonly token: number;
    }
  /**
   * In a cluster, this node stopped owning a shard. `leaseLost`: its lease ran out by this node's
   * clock, before it could be renewed, and its entities are stopping. Otherwise its entities have
   * stopped and the lease is being given up: `leaving`, as the node leaves or terminates,
   * `downed`, as it leaves because it was downed, or `handoff`, to move the shard to another node.
   */
  | {
      readonly type: 'shardReleased';
      readonly entityType: string;
      readonly shard: number;
      readonly node: string;
      readonly token: number;
      readonly reason: 'handoff' | 'leaving' | 'leaseLost' | 'downed';
    }
  | {
      readonly type: 'deadLetter';
      readonly recipient: string;
      readonly message: unknown;
      /**
       * The `id` of the message's `delivered`, when it had one: it was in the mailbox while
       * message events were on, and a stop drained it.
       */
      readonly id?: number;
      /**
       * `mailboxFull`: a bounded mailbox was full. `stopped`: the actor was stopping or had
       * stopped. `askCompleted`: a reply to an `ask` that had already been answered or had timed
       * out. `terminated`: the system was terminating.
       *
       * In a cluster: `unreachable`: its node couldn't be reached, or was down. `unserializable`:
       * the message wasn't JSON plus refs, or was too big to send. `invalid`: the message failed
       * its entity type's schema.
       */
      readonly reason: DeadLetterReason;
    }
>;

/** The system's events, delivered synchronously, in order, as they happen. */
export interface EventStream {
  /**
   * Calls `listener` with every event from now on. A listener that throws is logged and skipped.
   *
   * `delivered` and `processed` go only to listeners that pass `{ messages: true }`. While none
   * has, the system doesn't build them at all (decision 0020).
   * @returns A function that unsubscribes.
   * @throws TypeError unless `listener` is a function, and `opts` an object whose `messages`, if
   * set, is a boolean.
   */
  subscribe(listener: (event: SystemEvent) => void, opts?: { messages?: boolean }): () => void;
}

/** A running actor system: the root of an actor hierarchy. */
export interface ActorSystem {
  /** The name it was created with. */
  readonly name: string;
  /**
   * Starts a top-level actor under `/user` and returns its ref at once.
   * @param name Optional. Generated as `$1`, `$2` and so on when omitted.
   * @throws ActorNameError for an invalid, reserved or taken name.
   * @throws ActorSystemTerminatedError once `terminate()` has been called.
   * @throws TypeError for a definition or options that can't be used.
   */
  spawn<M, S>(def: ActorDef<M, S>, name?: string, opts?: SpawnOptions): ActorRef<M>;
  /**
   * Stops a top-level actor after its current message. Stopping one that has already terminated
   * does nothing.
   * @throws NotAChildError if `ref` isn't a top-level actor of this system.
   */
  stop(ref: AnyRef): void;
  /** The system's event stream. */
  readonly events: EventStream;
  /**
   * Stops every actor, children first, and resolves once the last one has terminated. After it's
   * called, `spawn` throws and every `tell` becomes a `terminated` dead letter. Calling it again
   * returns the same promise.
   */
  terminate(): Promise<void>;
  /** Resolves once the system has terminated. */
  readonly whenTerminated: Promise<void>;
}
