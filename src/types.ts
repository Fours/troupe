import type { Logger } from './logger.js';
import type { Scheduler } from './scheduler.js';

// These interfaces grow task by task through milestone 1: each one holds only what's built.

/**
 * A handle for sending messages to one actor. It's the only way to reach an actor: you never hold
 * the actor itself, which is what lets a ref point at another process in milestone 4.
 *
 * `tell` is a property, not a method, so `ActorRef` is contravariant in `M`: a ref that accepts
 * more messages can stand in for one that accepts fewer, never the other way round.
 */
export interface ActorRef<M> {
  /** Where the actor lives in the hierarchy, for example `/user/box-office`. */
  readonly path: string;
  /**
   * Sends `msg` to the actor's mailbox and returns at once. Never throws: a message that can't be
   * delivered becomes a dead letter.
   */
  readonly tell: (msg: M) => void;
}

/** A ref to an actor of any protocol, for watching, stopping and comparing. */
export type AnyRef = ActorRef<never>;

/**
 * What an actor can see and do while it runs. Passed to `initial`, `receive` and `onSignal`. It
 * belongs to one incarnation of the actor: once that has stopped, `spawn` throws and `watch` does
 * nothing.
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
   * @throws ActorStoppedError once this actor is stopping or has stopped.
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
}

/** A lifecycle event, delivered to `onSignal`. */
export type Signal =
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
   * state, and anything returned from `postStop` is ignored. A promise holds the mailbox, as in
   * `receive`. A throw in `postStop` is logged, and the stop goes ahead.
   */
  onSignal?(state: S, signal: Signal, ctx: ActorContext<M>): S | Promise<S>;
}

/** Options for one `spawn`. */
export interface SpawnOptions {
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
  /** Where logs go. Default `consoleLogger("warn")`. */
  logger?: Logger;
  /** How many messages one actor runs per turn before others get a go. Default 10. */
  throughput?: number;
  /** How many messages run in a row before the dispatcher yields to the event loop. Default 1,000. */
  yieldAfter?: number;
}

type Timestamped<E> = E extends unknown ? { readonly seq: number; readonly at: number } & E : never;

/**
 * Something that happened in the system. `seq` counts up by one per event, across the system, and
 * `at` is the scheduler's time.
 */
export type SystemEvent = Timestamped<
  | { readonly type: 'spawned'; readonly path: string }
  /** An actor has terminated. `failure` is present when it stopped because it failed. */
  | { readonly type: 'stopped'; readonly path: string; readonly failure?: unknown }
  | {
      readonly type: 'deadLetter';
      readonly recipient: string;
      readonly message: unknown;
      /**
       * `mailboxFull`: a bounded mailbox was full. `stopped`: the actor was stopping or had
       * stopped. `terminated`: the system was terminating.
       */
      readonly reason: 'mailboxFull' | 'stopped' | 'terminated';
    }
>;

/** The system's events, delivered synchronously, in order, as they happen. */
export interface EventStream {
  /**
   * Calls `listener` with every event from now on. A listener that throws is logged and skipped.
   * @returns A function that unsubscribes.
   */
  subscribe(listener: (event: SystemEvent) => void): () => void;
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
