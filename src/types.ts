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

/** What an actor can see and do while it runs. Passed to `initial` and `receive`. */
export interface ActorContext<M> {
  /** This actor's own ref. The same object `spawn` returned. */
  readonly self: ActorRef<M>;
  /** The system logger, with `{ path }` added to every entry. */
  readonly log: Logger;
  /** The scheduler's current time, in ms. */
  now(): number;
}

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
  | {
      readonly type: 'deadLetter';
      readonly recipient: string;
      readonly message: unknown;
      readonly reason: 'mailboxFull';
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
   * @throws TypeError for a definition or options that can't be used.
   */
  spawn<M, S>(def: ActorDef<M, S>, name?: string, opts?: SpawnOptions): ActorRef<M>;
  /** The system's event stream. */
  readonly events: EventStream;
}
