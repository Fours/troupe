// Hooks between the core and the package's other entry points. None of this is public API: the
// symbols are exported only to the package's own modules, never from an entry point, so user
// actors can't reach them. Persistent actors use them to recover before any message (milestone 2),
// Backstage uses them to read what the public API doesn't show (milestone 3), and the cluster uses
// them to put its actors under /system and to turn paths from the wire back into refs (milestone
// 4). The core still knows nothing about the network.

import type { EventBody } from './events.js';
import type { Logger } from './logger.js';
import type { Persistence } from './persistence/types.js';
import type { Scheduler } from './scheduler.js';
import type {
  ActorContext,
  ActorDef,
  ActorRef,
  ActorSystem,
  AnyRef,
  DeadLetterReason,
  SpawnOptions,
} from './types.js';

/**
 * An optional async step on an `ActorDef`, run after `initial` and before any message. It gets the
 * state `initial` made and returns the state to start with. The cell holds its mailbox until it
 * settles, and a rejection is a failure in the actor's start, the same as a throw in `initial`.
 */
export const START: unique symbol = Symbol('troupe.start');

/** What a cell offers its own `ctx`, beyond the public `ActorContext`. */
export const INTERNALS: unique symbol = Symbol('troupe.internals');

/** The start hook's shape. */
export type StartHook<M, S> = (state: S, ctx: ActorContext<M>) => Promise<S>;

/** An `ActorDef` that may carry a start hook. */
export interface WithStart<M, S> {
  readonly [START]?: StartHook<M, S>;
}

/** What `ctx[INTERNALS]` holds. */
export interface CellInternals {
  /** Publishes a system event, stamped by the system's bus. */
  publish(body: EventBody): void;
  /**
   * Counts `promise` as busy work until it settles, without holding the mailbox, so the testkit's
   * `settle` waits for it. The caller handles its rejection. Persistent actors' snapshot saves.
   */
  track(promise: PromiseLike<unknown>): void;
  /**
   * Runs `fn` with this actor as the sender of every `tell` in it, for code that runs after an
   * `await` on the actor's behalf: a persistent actor's effect steps (decision 0020).
   */
  asSender<T>(fn: () => T): T;
}

/** The internals of a `ctx` the system made. */
export function internalsOf(ctx: object): CellInternals {
  const internals = (ctx as unknown as { [INTERNALS]?: CellInternals })[INTERNALS];
  if (internals === undefined) {
    throw new TypeError('this context was not made by an actor system');
  }
  return internals;
}

/** The inspection hook on a system the core made. */
export const INSPECT: unique symbol = Symbol('troupe.inspect');

/** The inspection hook on a persistent actor's definition. */
export const PERSISTENT: unique symbol = Symbol('troupe.persistent');

/**
 * Where an actor is in its life. `starting` covers the time before `initial` has run, and a
 * persistent actor's recovery.
 */
export type ActorStatus = 'starting' | 'running' | 'restarting' | 'stopping';

/** What the tree walk shows of one live actor. Read-only: nothing here changes the actor. */
export interface CellInspection {
  readonly path: string;
  readonly status: ActorStatus;
  /** How many messages wait in its mailbox. */
  readonly depth: number;
  /** Its current state, the object itself. `undefined` before `initial` has returned. */
  readonly state: unknown;
  /** Its definition's persistent hook, when it's a persistent actor. */
  readonly persistent: PersistentHook | undefined;
}

/** What `system[INSPECT]` holds. */
export interface SystemInspection {
  /** The scheduler the system runs on. */
  readonly scheduler: Scheduler;
  /** The system's logger, wrapped so it never throws. For an inspector's own failures. */
  readonly log: Logger;
  /** Every live actor under `/user`, depth first, each parent before its children in spawn order. */
  walk(): CellInspection[];
}

/** What a persistent actor's definition offers an inspector, without touching a live actor. */
export interface PersistentHook {
  readonly persistenceId: string;
  readonly persistence: Persistence;
  /**
   * The state after event `seq`, folded from the journal's events 1 to `seq` as recovery folds
   * them, with no snapshot. `stateAt(0)` is the initial state.
   * @throws TypeError, as a rejection, unless `seq` is a non-negative integer.
   * @throws RangeError, as a rejection, when `seq` is past the journal's last event.
   */
  stateAt(seq: number): Promise<unknown>;
}

/** The inspection hook of a system the core made. */
export function inspectSystem(system: ActorSystem): SystemInspection {
  const inspection = (system as unknown as { [INSPECT]?: SystemInspection })[INSPECT];
  if (inspection === undefined) {
    throw new TypeError('this system was not made by createActorSystem');
  }
  return inspection;
}

/** The persistent hook of a definition, if it's a persistent actor's. */
export function persistentHookOf(def: object): PersistentHook | undefined {
  return (def as { [PERSISTENT]?: PersistentHook })[PERSISTENT];
}

/** Something told when a watched actor terminates: a cell, a testkit probe, or remoting. */
export interface Watcher {
  /** Tells the watcher that `target` has terminated. It must not throw. */
  notifyTerminated(target: WatchTarget): void;
}

/**
 * Something `ctx.watch` can watch: a local actor's cell, or an actor on another node, which
 * remoting stands in for (decision 0026).
 */
export interface WatchTarget {
  /** The watched actor's ref, as the `terminated` signal carries it. */
  readonly ref: AnyRef;
  readonly terminated: boolean;
  /** Present once it has terminated, when it stopped because it failed. */
  readonly failure: { readonly error: unknown } | undefined;
  /** Starts telling `watcher` when it terminates. Adding one twice is the same as once. */
  addWatcher(watcher: Watcher): void;
  removeWatcher(watcher: Watcher): void;
}

/** The cluster's hook on a system the core made (decision 0025). */
export const HOOKS: unique symbol = Symbol('troupe.hooks');

/** What `system[HOOKS]` holds. */
export interface SystemHooks {
  /** The scheduler the system runs on. */
  readonly scheduler: Scheduler;
  /** The system's source of chance (decision 0003). */
  readonly random: () => number;
  /** The system's logger, wrapped so it never throws. */
  readonly log: Logger;
  /**
   * Spawns an actor under `/system`, with every check `spawn` makes: a top-level one, or with
   * `parent`, a child of an actor already under `/system`, as sharding's regions are (decision
   * 0030). `terminate()` stops these after everything under `/user`, so user actors can still
   * reach the cluster as they stop.
   * @throws TypeError if `parent` isn't a live actor under `/system`.
   */
  spawnSystem<M, S>(
    def: ActorDef<M, S>,
    name?: string,
    opts?: SpawnOptions,
    parent?: AnyRef,
  ): ActorRef<M>;
  /**
   * The ref at a local path: a live actor under `/user` or `/system`, or the temporary ref of an
   * ask that's still waiting, under `/temp`. `undefined` for anything else.
   */
  lookup(path: string): AnyRef | undefined;
  /** Whether this system made `ref`, through spawn, ask, a probe or {@link SystemHooks.makeRef}. */
  owns(ref: unknown): boolean;
  /** Makes a ref with this system's `ask`, such as a remote ref. */
  makeRef<M>(path: string, tell: (msg: M) => void): ActorRef<M>;
  /** Publishes a system event, stamped by the system's bus: the cluster's member events. */
  publish(body: EventBody): void;
  /** Publishes a `deadLetter` event. */
  deadLetter(recipient: string, message: unknown, reason: DeadLetterReason): void;
  /**
   * What `ctx.watch` would watch for `ref`: a local actor's cell, or what the watch resolver
   * gives. `undefined` for a ref nothing can watch, such as a temporary ask ref.
   */
  watchTarget(ref: unknown): WatchTarget | undefined;
  /**
   * Installs what `ctx.watch` and probes use for refs that aren't local actors: remoting's
   * remote refs (decision 0026). One per system.
   * @throws Error if one is already installed.
   */
  setWatchResolver(resolve: (ref: unknown) => WatchTarget | undefined): void;
  /**
   * The path of the actor sending right now, as `delivered.from` would name it, when it's known
   * (decision 0020). Only known while a subscriber wants message events.
   */
  sender(): string | undefined;
  /** Tells `ref` with `from` as the sender, for a message from another node (decision 0026). */
  tellFrom(ref: AnyRef, message: unknown, from: string | undefined): void;
}

/** The cluster's hook on a system the core made. */
export function hooksOf(system: ActorSystem): SystemHooks {
  const hooks = (system as unknown as { [HOOKS]?: SystemHooks })[HOOKS];
  if (hooks === undefined) throw new TypeError('this system was not made by createActorSystem');
  return hooks;
}
