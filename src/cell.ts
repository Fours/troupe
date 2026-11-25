import type { Dispatcher, Runnable } from './dispatcher.js';
import type { EventBus } from './events.js';
import { checkKeys } from './checks.js';
import { ActorStoppedError, NotAChildError } from './errors.js';
import {
  INTERNALS,
  persistentHookOf,
  START,
  type CellInspection,
  type CellInternals,
  type Plant,
  type Watcher,
  type WatchTarget,
  type WithStart,
} from './internal.js';
import { safeLogger, type Logger } from './logger.js';
import { Names } from './names.js';
import { Queue } from './queue.js';
import {
  decide,
  NO_FAILURES,
  type RestartHistory,
  type SupervisorStrategy,
} from './supervision.js';
import { TimerEnvelope, TimerTable, timersFor } from './timers.js';
import type {
  ActorContext,
  ActorDef,
  ActorRef,
  AnyRef,
  PipeOptions,
  PipeSignal,
  Result,
  Signal,
  SpawnOptions,
} from './types.js';

/** A failure, kept with a flag because `throw undefined` is legal. */
type Failure = { readonly error: unknown } | undefined;

/** A settled `pipeToSelf` promise in the mailbox. Its mapper runs when it's dequeued. */
class PipeEnvelope<M> {
  constructor(
    readonly result: Result<unknown>,
    readonly map: (result: Result<unknown>) => M,
  ) {}
}

/**
 * The last item of a mailbox whose actor stops once it's dequeued: `stopWhenIdle`. A symbol no
 * one else holds, so no user message can be it.
 */
const STOP_MARKER: unique symbol = Symbol('troupe.stopWhenIdle');
type StopMarker = typeof STOP_MARKER;

/** A mailbox item with the id of its `delivered`, wrapped only while message events are on. */
class Tracked<M> {
  constructor(
    readonly id: number,
    readonly item: Untracked<M>,
  ) {}
}

/** A mailbox item without its message id. */
type Untracked<M> = M | TimerEnvelope<M> | PipeEnvelope<M> | StopMarker;

/**
 * What the user queue holds. Only timer and pipe messages are wrapped, and only while message
 * events are on is anything else, so a plain `tell` doesn't allocate. A user message can't be an
 * instance of these private classes.
 */
type Envelope<M> = Untracked<M> | Tracked<M>;

/** A message being handled whose `delivered` was published, so its `processed` is owed. */
interface Tracking {
  readonly id: number;
  readonly takenAt: number;
  /** The mailbox's size once it came out. */
  readonly depth: number;
}

type DeadLetterReason = 'mailboxFull' | 'stopped' | 'terminated';

export type { Watcher } from './internal.js';

/** What other cells, the guardian and the system see of a cell, whatever its types. */
export interface CellNode extends Watcher, WatchTarget {
  readonly ref: AnyRef;
  readonly name: string;
  readonly parent: ParentNode;
  readonly terminated: boolean;
  readonly failure: Failure;
  /** Asks the cell to stop after its current message, ahead of its queued messages. */
  requestStop(): void;
  /** Asks the cell to stop once it has handled the messages already queued. */
  stopWhenIdle(): void;
  /** Its children that haven't terminated, in spawn order. */
  readonly childCells: Map<string, CellNode>;
  /** What an inspector sees of it, read-only. */
  inspect(): CellInspection;
}

/** Something that has children: a cell, or the `/user` guardian. */
export interface ParentNode {
  readonly path: string;
  readonly names: Names;
  readonly childCells: Map<string, CellNode>;
  /** Called by a child once it has fully terminated, after its `postStop`. */
  removeChild(child: CellNode): void;
}

/** What a cell needs from its system. */
export interface CellHost {
  readonly dispatcher: Dispatcher;
  readonly events: EventBus;
  readonly log: Logger;
  /**
   * The path of the actor whose code is running outside a dispatcher turn, for `delivered`'s
   * `from` (decision 0020). A cell sets it around code it runs after a promise settles. Inside a
   * turn, the dispatcher's `current` says who's running.
   */
  senderOverride: string | undefined;
  now(): number;
  /** The system's source of chance, for backoff jitter (decision 0003). */
  random(): number;
  /** The system scheduler's `setTimer`. */
  setTimer(task: () => void, delayMs: number): () => void;
  /** The bug Rehearsal planted on the system, if any (milestone 5, T6). */
  plant(): Plant | undefined;
  /**
   * Called with +1 when a cell starts waiting on a promise, from an async handler or
   * `pipeToSelf`, and -1 when it settles, with the cell's path. The testkit's `settle` waits for
   * the count to reach 0, and Rehearsal's run loop names the actors that stay busy.
   */
  trackBusy(path: string, delta: 1 | -1): void;
  /**
   * Called with +1 when a cell pipes a promise with a signal, and -1 when the pipe ends. These
   * aren't busy work: the testkit's `settle` only gives them one event-loop turn (decision 0038).
   */
  trackBounded(delta: 1 | -1): void;
  /** Makes a ref with the system's `ask`. */
  makeRef<M>(path: string, tell: (msg: M) => void): ActorRef<M>;
  /**
   * Calls `listener` synchronously when `promise` settles, if it's one of the system's asks.
   * @returns False if it isn't, so the caller must wait on the promise itself.
   */
  onAskSettled(promise: unknown, listener: (result: Result<unknown>) => void): boolean;
  /**
   * True once `terminate()` has been called, for an actor at `path` under `/user`. Under
   * `/system`, only once the system's termination tasks have settled.
   */
  terminating(path: string): boolean;
  /** Spawns an actor under `parent`, with every check `spawn` makes. */
  spawn<M, S>(
    parent: ParentNode,
    def: ActorDef<M, S>,
    name: string | undefined,
    opts: SpawnOptions | undefined,
  ): ActorRef<M>;
  /** The cell behind a ref, if it belongs to this system. */
  cellOf(ref: unknown): CellNode | undefined;
  /** What watching `ref` watches: its cell, or a remote actor's stand-in (decision 0026). */
  watchTargetOf(ref: unknown): WatchTarget | undefined;
}

/** A cell's checked spawn options. */
export interface CellOptions {
  readonly capacity: number;
  readonly supervision: SupervisorStrategy;
}

type SystemMessage =
  | { readonly type: 'stop' }
  | { readonly type: 'terminated'; readonly target: WatchTarget }
  | { readonly type: 'childrenDone' }
  | { readonly type: 'restartDue' };

type Phase = 'running' | 'restarting' | 'stopping' | 'terminated';

/** A restart that's under way: it finishes once the children are gone and the delay is over. */
interface PendingRestart {
  readonly attempt: number;
  readonly delayMs: number;
  childrenPending: boolean;
  delayPending: boolean;
  cancelDelay: (() => void) | undefined;
}

/**
 * One actor: its state, mailbox and lifecycle. The dispatcher gives it turns, and it runs one
 * message at a time, holding its mailbox while an async `receive` or `onSignal` is pending
 * (decision 0002).
 *
 * It has two queues. The system queue holds stop requests, `terminated` notices and restart
 * steps, and is always read before the user queue, so a stop jumps ahead of queued messages.
 *
 * The user queue holds messages, plus timer and `pipeToSelf` messages in envelopes that are
 * unwrapped when they're dequeued. A timer's envelope is checked against its timer's current
 * generation then, so a cancelled timer's message is never received.
 *
 * While a subscriber wants message events (decision 0020), each message is wrapped with an id as
 * it goes in, publishing `delivered`, and ends with exactly one `processed` or dead letter with
 * that id. While none does, nothing is wrapped or built. The cell names itself as the sender of
 * every `tell` during its turn, and around code it runs once an awaited handler settles.
 *
 * A definition may carry an internal start hook (`src/internal.ts`), which runs after `initial` and
 * holds the mailbox until it settles. Persistent actors recover there (decision 0011).
 *
 * Stopping goes: cancel the timers, dead-letter the user queue, stop every child and wait for them, run `postStop`,
 * then terminate, which frees the name, notifies watchers and publishes `stopped`.
 *
 * A failure goes to the strategy the parent chose (decision 0006). A restart makes a new
 * incarnation behind the same ref (decision 0008): run `preRestart`, drop the actor's own watches,
 * stop the children and wait for them and for any backoff delay, then run `initial` with a new
 * `ctx`. The mailbox, the ref and the watchers carry over.
 */
export class Cell<M, S> implements Runnable, CellNode, ParentNode {
  readonly ref: ActorRef<M>;
  readonly name: string;
  readonly path: string;
  readonly parent: ParentNode;
  readonly names = new Names();
  readonly childCells = new Map<string, CellNode>();
  // Watchers of this cell, kept so it can notify them when it terminates.
  readonly #watchers = new Set<Watcher>();
  readonly #watching = new Set<WatchTarget>();
  readonly #def: ActorDef<M, S>;
  readonly #host: CellHost;
  readonly #capacity: number;
  readonly #strategy: SupervisorStrategy;
  readonly #mailbox = new Queue<Envelope<M>>();
  readonly #timers: TimerTable<M>;
  readonly #system = new Queue<SystemMessage>();
  readonly #log: Logger;
  readonly #internals: CellInternals;
  #ctx: ActorContext<M>;
  // Bumped when an incarnation ends, so its ctx can tell it's stale.
  #incarnation = 0;
  #state: S | undefined;
  #started = false;
  // True once initial has returned, so there's a state to pass to preRestart and postStop.
  #hasState = false;
  // When this incarnation ran initial, for the backoff reset.
  #startedAt = 0;
  #history: RestartHistory = NO_FAILURES;
  #restart: PendingRestart | undefined;
  // Waiting for every child to terminate, for a stop or a restart.
  #awaitingChildren = false;
  #phase: Phase = 'running';
  #failure: Failure;
  // In the dispatcher's ready queue.
  #scheduled = false;
  // Inside run(), so a tell to self doesn't schedule the cell a second time.
  #running = false;
  // Waiting for an async receive or onSignal to settle.
  #busy = false;
  // How many mailbox items are Tracked, so an untracked mailbox skips the instanceof check.
  #tracked = 0;

  constructor(
    name: string,
    path: string,
    def: ActorDef<M, S>,
    host: CellHost,
    opts: CellOptions,
    parent: ParentNode,
  ) {
    this.name = name;
    this.path = path;
    this.#def = def;
    this.#host = host;
    this.#capacity = opts.capacity;
    this.#strategy = opts.supervision;
    this.parent = parent;
    this.#log = safeLogger(host.log, { path });
    this.#internals = {
      publish: (body) => {
        host.events.publish(body);
      },
      track: (promise) => {
        host.trackBusy(this.path, 1);
        const done = (): void => {
          host.trackBusy(this.path, -1);
        };
        Promise.resolve(promise).then(done, done);
      },
      asSender: (fn) => this.#asSender(fn),
      setTimer: (task, delayMs) => host.setTimer(task, delayMs),
      plant: () => host.plant(),
    };
    this.ref = host.makeRef(path, (msg: M) => {
      this.#enqueue(msg);
    });
    this.#timers = new TimerTable<M>({
      setTimer: (task, delayMs) => host.setTimer(task, delayMs),
      enqueue: (envelope) => this.#enqueue(envelope),
    });
    this.#ctx = this.#makeContext();
  }

  get terminated(): boolean {
    return this.#phase === 'terminated';
  }

  get failure(): Failure {
    return this.#failure;
  }

  inspect(): CellInspection {
    return {
      path: this.path,
      status:
        this.#phase === 'restarting' || this.#phase === 'stopping'
          ? this.#phase
          : this.#started && this.#hasState
            ? 'running'
            : 'starting',
      depth: this.#mailbox.size,
      state: this.#hasState ? this.#state : undefined,
      persistent: persistentHookOf(this.#def),
    };
  }

  /** Queues the actor's first step, which runs `initial`. */
  start(): void {
    this.#schedule();
  }

  requestStop(): void {
    if (this.#stopping()) return;
    this.#system.push({ type: 'stop' });
    this.#scheduleIfReady();
  }

  stopWhenIdle(): void {
    if (this.#stopping()) return;
    // Past the capacity check: it's the system's, not a message, and nothing comes after it.
    this.#mailbox.push(STOP_MARKER);
    this.#scheduleIfReady();
  }

  addWatcher(watcher: Watcher): void {
    this.#watchers.add(watcher);
  }

  removeWatcher(watcher: Watcher): void {
    this.#watchers.delete(watcher);
  }

  notifyTerminated(target: WatchTarget): void {
    if (this.#phase !== 'running' || !this.#watching.has(target)) return;
    this.#system.push({ type: 'terminated', target });
    this.#scheduleIfReady();
  }

  removeChild(child: CellNode): void {
    this.childCells.delete(child.name);
    this.names.release(child.name);
    if (this.#awaitingChildren && this.childCells.size === 0) {
      this.#system.push({ type: 'childrenDone' });
      this.#scheduleIfReady();
    }
  }

  run(max: number): number {
    this.#scheduled = false;
    this.#running = true;
    let steps = 0;
    try {
      while (steps < max && !this.#busy && this.#phase !== 'terminated') {
        if (!this.#started) {
          steps++;
          this.#init();
          continue;
        }
        const sys = this.#system.shift();
        if (sys !== undefined) {
          steps++;
          this.#handleSystem(sys);
          continue;
        }
        if (this.#phase !== 'running' || this.#mailbox.size === 0) break;
        // Size checked above, so shift() returns an item. M itself may include undefined.
        const item = this.#mailbox.shift() as Envelope<M>;
        steps++;
        this.#receive(item);
      }
    } finally {
      this.#running = false;
    }
    this.#scheduleIfReady();
    return steps;
  }

  /** Runs `fn` with this actor as the sender, for code that runs outside its turn. */
  #asSender<T>(fn: () => T): T {
    const host = this.#host;
    const outer = host.senderOverride;
    host.senderOverride = this.path;
    try {
      return fn();
    } finally {
      host.senderOverride = outer;
    }
  }

  /** Builds the ctx for the current incarnation. It goes stale once that incarnation ends. */
  #makeContext(): ActorContext<M> {
    const incarnation = this.#incarnation;
    const current = () => this.#incarnation === incarnation;
    const host = this.#host;
    const ctx: ActorContext<M> = {
      self: this.ref,
      log: this.#log,
      now: () => host.now(),
      spawn: <C, CS>(def: ActorDef<C, CS>, childName?: string, opts?: SpawnOptions) => {
        if (!current() || this.#phase !== 'running') {
          throw new ActorStoppedError(
            `${this.path}: this incarnation has stopped or restarted, so it can't spawn`,
          );
        }
        return host.spawn(this, def, childName, opts);
      },
      stop: (ref?: AnyRef) => {
        this.#stop(ref);
      },
      watch: (ref: AnyRef) => {
        if (current()) this.#watch(ref);
      },
      unwatch: (ref: AnyRef) => {
        this.#unwatch(ref);
      },
      child: (childName: string) => this.childCells.get(childName)?.ref,
      children: () => [...this.childCells.values()].map((c) => c.ref),
      timers: timersFor(this.#timers, () => current() && this.#phase === 'running'),
      pipeToSelf: <T>(
        promise: PromiseLike<T>,
        map: (result: Result<T>) => M,
        opts?: PipeOptions,
      ) => {
        if (typeof map !== 'function') {
          throw new TypeError('pipeToSelf: map must be a function');
        }
        this.#pipe(promise, map, pipeSignal(opts));
      },
    };
    // Not enumerable, so spreading or logging a ctx doesn't show it.
    Object.defineProperty(ctx, INTERNALS, { value: this.#internals });
    return Object.freeze(ctx);
  }

  /** Unwraps one mailbox item and hands it to `receive`. */
  #receive(envelope: Envelope<M>): void {
    let item: Untracked<M>;
    let tracking: Tracking | undefined;
    if (this.#tracked > 0 && envelope instanceof Tracked) {
      item = envelope.item;
      tracking = this.#take(envelope);
    } else {
      // With no Tracked items in the mailbox, this one isn't.
      item = envelope as Untracked<M>;
    }
    let msg: M;
    if (item === STOP_MARKER) {
      this.requestStop();
      return;
    }
    if (item instanceof TimerEnvelope) {
      // A cancelled or replaced timer's message is dropped here, even if it was already queued.
      if (!this.#timers.accept(item)) {
        if (tracking !== undefined) this.#processed(tracking, false, true);
        return;
      }
      msg = item.msg;
    } else if (item instanceof PipeEnvelope) {
      try {
        msg = item.map(item.result);
      } catch (error) {
        if (tracking !== undefined) this.#processed(tracking, false);
        this.#fail(error, { pipeToSelf: item.result.ok ? 'ok' : 'error' });
        return;
      }
    } else {
      msg = item;
    }
    const handler = () => this.#def.receive(this.#state as S, msg, this.#ctx);
    if (tracking === undefined) this.#invoke(handler, { message: msg });
    else this.#invokeTracked(handler, { message: msg }, tracking);
  }

  /** Starts tracking a message as it's taken from the mailbox. */
  #take(envelope: Tracked<M>): Tracking {
    this.#tracked--;
    return { id: envelope.id, takenAt: this.#host.now(), depth: this.#mailbox.size };
  }

  /** Publishes the `processed` that ends a tracked message, if anyone still wants it. */
  #processed(tracking: Tracking, stateChanged: boolean, skipped = false): void {
    const { events } = this.#host;
    if (!events.messages) return;
    const body = {
      type: 'processed',
      path: this.path,
      id: tracking.id,
      durationMs: this.#host.now() - tracking.takenAt,
      depth: tracking.depth,
      stateChanged,
    } as const;
    events.publishMessage(skipped ? { ...body, skipped: true } : body);
  }

  /**
   * Waits for `promise` without making the cell busy, so the mailbox stays open (decision 0002),
   * then queues the result for its mapper.
   *
   * An ask's result is queued the moment the ask settles, with no promise hop, so piping an ask
   * runs entirely on the scheduler and isn't busy work for `settle` (decision 0010).
   */
  #pipe<T>(
    promise: PromiseLike<T>,
    map: (result: Result<T>) => M,
    signal: PipeSignal | undefined,
  ): void {
    const host = this.#host;
    // The envelope only ever passes this result to this mapper, so widening T is safe.
    const widened = map as (result: Result<unknown>) => M;
    const enqueue = (result: Result<unknown>): void => {
      this.#enqueue(new PipeEnvelope(result, widened));
    };
    if (signal !== undefined) {
      this.#pipeBounded(promise, enqueue, signal);
      return;
    }
    if (host.onAskSettled(promise, enqueue)) {
      // The result arrives through the listener. Handle the rejection here too, or a timed-out
      // ask would be an unhandled rejection.
      Promise.resolve(promise).then(undefined, () => {});
      return;
    }
    host.trackBusy(this.path, 1);
    const deliver = (result: Result<unknown>): void => {
      host.trackBusy(this.path, -1);
      enqueue(result);
    };
    Promise.resolve(promise).then(
      (value) => {
        deliver({ ok: true, value });
      },
      (error: unknown) => {
        deliver({ ok: false, error });
      },
    );
  }

  /**
   * A pipe that its signal ends, whichever comes first, so the actor's own timer or stop bounds
   * it. It isn't busy work for `settle` (decision 0038).
   */
  #pipeBounded(
    promise: PromiseLike<unknown>,
    enqueue: (result: Result<unknown>) => void,
    signal: PipeSignal,
  ): void {
    const host = this.#host;
    // Whatever comes second is dropped, and a rejection after the abort is handled here.
    const settled = Promise.resolve(promise);
    settled.then(undefined, () => {});
    if (signal.aborted) {
      enqueue({ ok: false, error: signal.reason });
      return;
    }
    host.trackBounded(1);
    let done = false;
    const finish = (result: Result<unknown>): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      host.trackBounded(-1);
      enqueue(result);
    };
    // Abort listeners run synchronously in abort(), so the rejection is queued before it returns.
    const onAbort = (): void => {
      finish({ ok: false, error: signal.reason });
    };
    signal.addEventListener('abort', onAbort);
    if (host.onAskSettled(promise, finish)) return;
    settled.then(
      (value) => {
        finish({ ok: true, value });
      },
      (error: unknown) => {
        finish({ ok: false, error });
      },
    );
  }

  #stopping(): boolean {
    return this.#phase === 'stopping' || this.#phase === 'terminated';
  }

  /** Queues a message, or makes it a dead letter. Returns false for a dead letter. */
  #enqueue(item: Untracked<M>): boolean {
    const reason = this.#host.terminating(this.path)
      ? 'terminated'
      : this.#stopping()
        ? 'stopped'
        : this.#mailbox.size >= this.#capacity
          ? 'mailboxFull'
          : undefined;
    if (reason !== undefined) {
      this.#deadLetter(item, reason, undefined);
      return false;
    }
    // While restarting, messages queue up and wait for the new incarnation.
    if (this.#host.events.messages) this.#pushTracked(item);
    else this.#mailbox.push(item);
    this.#scheduleIfReady();
    return true;
  }

  /** Queues a message with an id, and publishes its `delivered`. */
  #pushTracked(item: Untracked<M>): void {
    const host = this.#host;
    const id = host.events.nextMessageId();
    this.#mailbox.push(new Tracked(id, item));
    this.#tracked++;
    const sender = host.senderOverride ?? host.dispatcher.current?.path;
    const body = {
      type: 'delivered',
      path: this.path,
      id,
      message: sent(item),
      depth: this.#mailbox.size,
    } as const;
    host.events.publishMessage(sender === undefined ? body : { ...body, from: sender });
  }

  #deadLetter(item: Untracked<M>, reason: DeadLetterReason, id: number | undefined): void {
    const body = { type: 'deadLetter', recipient: this.path, message: sent(item), reason } as const;
    this.#host.events.publish(id === undefined ? body : { ...body, id });
  }

  #scheduleIfReady(): void {
    if (this.#scheduled || this.#running || this.#busy || this.#phase === 'terminated') return;
    // The mailbox only counts while running: a restarting cell with queued messages but nothing
    // else to do would otherwise be scheduled, run no steps, and be scheduled again forever.
    const hasWork =
      !this.#started ||
      this.#system.size > 0 ||
      (this.#phase === 'running' && this.#mailbox.size > 0);
    if (hasWork) this.#schedule();
  }

  #schedule(): void {
    this.#scheduled = true;
    this.#host.dispatcher.schedule(this);
  }

  #init(): void {
    this.#started = true;
    this.#hasState = false;
    this.#state = undefined;
    this.#startedAt = this.#host.now();
    const { initial } = this.#def;
    let state: S;
    try {
      state =
        typeof initial === 'function'
          ? (initial as (ctx: ActorContext<M>) => S)(this.#ctx)
          : initial;
    } catch (error) {
      this.#fail(error, {}, true);
      return;
    }
    const start = (this.#def as WithStart<M, S>)[START];
    if (start === undefined) {
      this.#state = state;
      this.#hasState = true;
      return;
    }
    // A persistent actor's recovery: the mailbox is held until it settles, so no message runs
    // first, and its failure is a failure in the start, like a throw in initial.
    this.#state = state;
    let started: Promise<S>;
    try {
      started = start(state, this.#ctx);
    } catch (error) {
      this.#fail(error, {}, true);
      return;
    }
    this.#awaitBusy(
      started,
      (next) => {
        this.#state = next;
        this.#hasState = true;
      },
      (error) => {
        this.#fail(error, {}, true);
      },
    );
  }

  #handleSystem(sys: SystemMessage): void {
    switch (sys.type) {
      case 'stop':
        this.#beginStop(undefined);
        return;
      case 'childrenDone':
        this.#awaitingChildren = false;
        if (this.#restart === undefined) {
          this.#postStop();
          return;
        }
        this.#restart.childrenPending = false;
        this.#finishRestart();
        return;
      case 'restartDue':
        // A stop since the timer fired cancels the restart, and this with it.
        if (this.#restart === undefined) return;
        this.#restart.delayPending = false;
        this.#finishRestart();
        return;
      case 'terminated': {
        // Dropped while stopping, and after unwatch, even if it was already queued.
        if (this.#phase !== 'running' || !this.#watching.delete(sys.target)) return;
        const onSignal = this.#def.onSignal?.bind(this.#def);
        if (onSignal === undefined) return;
        const failure = sys.target.failure;
        const signal: Signal =
          failure === undefined
            ? { type: 'terminated', ref: sys.target.ref }
            : { type: 'terminated', ref: sys.target.ref, failure: failure.error };
        this.#invoke(() => onSignal(this.#state as S, signal, this.#ctx), {
          signal: 'terminated',
          target: sys.target.ref.path,
        });
        return;
      }
    }
  }

  /**
   * Runs a handler that returns the next state, directly or as a promise. A promise makes the
   * cell busy until it settles. A throw or rejection is a failure, for supervision.
   */
  #invoke(handler: () => S | Promise<S>, context: Record<string, unknown>): void {
    let result: S | Promise<S>;
    try {
      result = handler();
    } catch (error) {
      this.#fail(error, context);
      return;
    }
    if (!isThenable(result)) {
      this.#state = result;
      return;
    }
    this.#awaitBusy(
      result,
      (next) => {
        this.#state = next;
      },
      (error) => {
        this.#fail(error, context);
      },
    );
  }

  /**
   * {@link Cell.#invoke} for a tracked message: its `processed` comes when the handler settles,
   * before any `failed`. A copy rather than a flag, so the untracked path every message takes
   * while nobody watches stays as small as it was, and V8 keeps inlining it (decision 0020).
   */
  #invokeTracked(
    handler: () => S | Promise<S>,
    context: Record<string, unknown>,
    tracking: Tracking,
  ): void {
    const before = this.#state;
    let result: S | Promise<S>;
    try {
      result = handler();
    } catch (error) {
      this.#processed(tracking, false);
      this.#fail(error, context);
      return;
    }
    if (!isThenable(result)) {
      this.#state = result;
      this.#processed(tracking, result !== before);
      return;
    }
    this.#awaitBusy(
      result,
      (next) => {
        this.#state = next;
        this.#processed(tracking, next !== before);
      },
      (error) => {
        this.#processed(tracking, false);
        this.#fail(error, context);
      },
    );
  }

  /**
   * Holds the mailbox until `promise` settles. The callbacks run as this actor's code, so a
   * `preRestart` or `postStop` they lead to has a sender, as it would inside a turn.
   */
  #awaitBusy<T>(promise: Promise<T>, ok: (value: T) => void, failed: (error: unknown) => void) {
    this.#busy = true;
    this.#host.trackBusy(this.path, 1);
    Promise.resolve(promise).then(
      (value) => {
        this.#busy = false;
        this.#host.trackBusy(this.path, -1);
        this.#asSender(() => {
          ok(value);
        });
        this.#scheduleIfReady();
      },
      (error: unknown) => {
        this.#busy = false;
        this.#host.trackBusy(this.path, -1);
        this.#asSender(() => {
          failed(error);
        });
        this.#scheduleIfReady();
      },
    );
  }

  /** Hands a failure to the strategy, then publishes and logs what it decided. */
  #fail(error: unknown, context: Record<string, unknown>, inInitial = false): void {
    const { decision, history } = decide(this.#strategy, this.#history, {
      now: this.#host.now(),
      startedAt: this.#startedAt,
      inInitial,
      random: () => this.#host.random(),
    });
    this.#history = history;
    const { directive } = decision;
    this.#host.events.publish({ type: 'failed', path: this.path, error, directive });
    this.#log.error('actor failed', { ...context, error, directive });
    switch (decision.directive) {
      case 'stop':
        this.#beginStop({ error });
        return;
      case 'resume':
        return;
      case 'restart':
        this.#beginRestart(error, decision.attempt, decision.delayMs);
        return;
    }
  }

  #beginRestart(error: unknown, attempt: number, delayMs: number): void {
    this.#phase = 'restarting';
    this.#incarnation++;
    this.#unwatchAll();
    this.#timers.cancelAll();
    const restart: PendingRestart = {
      attempt,
      delayMs,
      childrenPending: true,
      delayPending: delayMs > 0,
      cancelDelay: undefined,
    };
    this.#restart = restart;
    // The delay runs from the failure, alongside preRestart and the children stopping.
    if (delayMs > 0) {
      restart.cancelDelay = this.#host.setTimer(() => {
        this.#system.push({ type: 'restartDue' });
        this.#scheduleIfReady();
      }, delayMs);
    }
    this.#signal({ type: 'preRestart', error }, 'restarting anyway', () => {
      if (this.#stopChildren()) return;
      restart.childrenPending = false;
      this.#finishRestart();
    });
  }

  /** Starts the new incarnation, once the children are gone and the delay is over. */
  #finishRestart(): void {
    const restart = this.#restart;
    if (restart === undefined || restart.childrenPending || restart.delayPending) return;
    this.#restart = undefined;
    this.#phase = 'running';
    this.#ctx = this.#makeContext();
    // The next step runs initial again, ahead of the queued messages.
    this.#started = false;
    this.#host.events.publish({
      type: 'restarted',
      path: this.path,
      attempt: restart.attempt,
      delayMs: restart.delayMs,
    });
  }

  #stop(ref: AnyRef | undefined): void {
    if (ref === undefined || ref === this.ref) {
      this.requestStop();
      return;
    }
    const cell = this.#host.cellOf(ref);
    if (cell?.parent !== this) {
      throw new NotAChildError(`${ref.path} is not a child of ${this.path}`);
    }
    // A child that has already terminated: nothing to do.
    cell.requestStop();
  }

  #watch(ref: AnyRef): void {
    const target = this.#targetOrThrow(ref, 'watch');
    if (this.#phase !== 'running' || target === this || this.#watching.has(target)) return;
    this.#watching.add(target);
    if (target.terminated) {
      this.notifyTerminated(target);
    } else {
      target.addWatcher(this);
    }
  }

  #unwatch(ref: AnyRef): void {
    const target = this.#targetOrThrow(ref, 'unwatch');
    this.#watching.delete(target);
    target.removeWatcher(this);
  }

  #unwatchAll(): void {
    for (const target of this.#watching) target.removeWatcher(this);
    this.#watching.clear();
  }

  #targetOrThrow(ref: unknown, what: string): WatchTarget {
    const target = this.#host.watchTargetOf(ref);
    if (target === undefined) {
      throw new TypeError(`${what}: the ref is not an actor of this system`);
    }
    return target;
  }

  #beginStop(failure: Failure): void {
    if (this.#stopping()) return;
    // A stop during a restart cancels it. postStop then runs with the last state.
    this.#restart?.cancelDelay?.();
    this.#restart = undefined;
    this.#phase = 'stopping';
    this.#failure = failure;
    this.#timers.cancelAll();
    while (this.#mailbox.size > 0) {
      const envelope = this.#mailbox.shift() as Envelope<M>;
      const tracked = this.#tracked > 0 && envelope instanceof Tracked;
      if (tracked) this.#tracked--;
      const item = tracked ? envelope.item : (envelope as Untracked<M>);
      if (item === STOP_MARKER) continue;
      if (!(item instanceof TimerEnvelope)) {
        this.#deadLetter(item, 'stopped', tracked ? envelope.id : undefined);
      } else if (tracked) {
        // Its timer was cancelled just above, so its message is never received, not even as a
        // dead letter. A tracked one still owes its `processed`.
        const now = this.#host.now();
        this.#processed({ id: envelope.id, takenAt: now, depth: this.#mailbox.size }, false, true);
      }
    }
    // A restart may already be waiting for the children, and childrenDone will still come.
    if (this.#awaitingChildren || this.#stopChildren()) return;
    this.#postStop();
  }

  /** Asks every child to stop. Returns false when there are none, so there's nothing to wait for. */
  #stopChildren(): boolean {
    if (this.childCells.size === 0) return false;
    this.#awaitingChildren = true;
    for (const child of [...this.childCells.values()]) child.requestStop();
    return true;
  }

  #postStop(): void {
    this.#signal({ type: 'postStop' }, 'stopping anyway', () => {
      this.#terminate();
    });
  }

  /**
   * Runs `preRestart` or `postStop`, awaiting it if it's async, then `next`. These can't fail the
   * actor: a throw or rejection is logged, and `next` runs anyway. Skipped when there's no state.
   */
  #signal(signal: Signal, anyway: string, next: () => void): void {
    const onSignal = this.#def.onSignal?.bind(this.#def);
    if (onSignal === undefined || !this.#hasState) {
      next();
      return;
    }
    let result: S | Promise<S>;
    try {
      result = onSignal(this.#state as S, signal, this.#ctx);
    } catch (error) {
      this.#log.error(`${signal.type} threw; ${anyway}`, { error });
      next();
      return;
    }
    if (!isThenable(result)) {
      next();
      return;
    }
    this.#awaitBusy(result, next, (error) => {
      this.#log.error(`${signal.type} rejected; ${anyway}`, { error });
      next();
    });
  }

  #terminate(): void {
    this.#phase = 'terminated';
    this.#unwatchAll();
    this.parent.removeChild(this);
    for (const watcher of [...this.#watchers]) watcher.notifyTerminated(this);
    this.#watchers.clear();
    this.#host.events.publish(
      this.#failure === undefined
        ? { type: 'stopped', path: this.path }
        : { type: 'stopped', path: this.path, failure: this.#failure.error },
    );
  }
}

/** What was sent, never the cell's wrapper: a pipe's raw `Result`, a timer's message. */
function sent<M>(item: Untracked<M>): unknown {
  return item instanceof PipeEnvelope
    ? item.result
    : item instanceof TimerEnvelope
      ? item.msg
      : item;
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

const PIPE_OPTIONS = new Set(['signal']);

/** Checks `pipeToSelf`'s options where they're passed in, and returns the signal, if any. */
function pipeSignal(opts: PipeOptions | undefined): PipeSignal | undefined {
  if (opts === undefined) return undefined;
  checkKeys(opts, PIPE_OPTIONS, 'pipeToSelf');
  const { signal } = opts;
  if (signal === undefined) return undefined;
  const candidate = signal as Partial<Record<keyof PipeSignal, unknown>> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.aborted !== 'boolean' ||
    typeof candidate.addEventListener !== 'function' ||
    typeof candidate.removeEventListener !== 'function'
  ) {
    throw new TypeError('pipeToSelf: signal must be an AbortSignal');
  }
  return signal;
}
