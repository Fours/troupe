import type { Dispatcher, Runnable } from './dispatcher.js';
import type { EventBus } from './events.js';
import { ActorStoppedError, NotAChildError } from './errors.js';
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
 * What the user queue holds. Only timer and pipe messages are wrapped, so a plain `tell` doesn't
 * allocate. A user message can't be an instance of these private classes.
 */
type Envelope<M> = M | TimerEnvelope<M> | PipeEnvelope<M>;

type DeadLetterReason = 'mailboxFull' | 'stopped' | 'terminated';

/** Something told when a watched cell terminates: another cell, or a testkit probe. */
export interface Watcher {
  /** Tells the watcher that `target` has terminated. It must not throw. */
  notifyTerminated(target: CellNode): void;
}

/** What other cells, the guardian and the system see of a cell, whatever its types. */
export interface CellNode extends Watcher {
  readonly ref: AnyRef;
  readonly name: string;
  readonly parent: ParentNode;
  readonly terminated: boolean;
  readonly failure: Failure;
  /** Asks the cell to stop after its current message, ahead of its queued messages. */
  requestStop(): void;
  /** Watchers of this cell, kept so it can notify them when it terminates. */
  readonly watchers: Set<Watcher>;
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
  now(): number;
  /** The system's source of chance, for backoff jitter (decision 0003). */
  random(): number;
  /** The system scheduler's `setTimer`. */
  setTimer(task: () => void, delayMs: number): () => void;
  /**
   * Called with +1 when a cell starts waiting on a promise, from an async handler or
   * `pipeToSelf`, and -1 when it settles. The testkit's `settle` waits for the count to reach 0.
   */
  trackBusy(delta: 1 | -1): void;
  /** Makes a ref with the system's `ask`. */
  makeRef<M>(path: string, tell: (msg: M) => void): ActorRef<M>;
  /**
   * Calls `listener` synchronously when `promise` settles, if it's one of the system's asks.
   * @returns False if it isn't, so the caller must wait on the promise itself.
   */
  onAskSettled(promise: unknown, listener: (result: Result<unknown>) => void): boolean;
  /** True once `terminate()` has been called. */
  terminating(): boolean;
  /** Spawns an actor under `parent`, with every check `spawn` makes. */
  spawn<M, S>(
    parent: ParentNode,
    def: ActorDef<M, S>,
    name: string | undefined,
    opts: SpawnOptions | undefined,
  ): ActorRef<M>;
  /** The cell behind a ref, if it belongs to this system. */
  cellOf(ref: unknown): CellNode | undefined;
}

/** A cell's checked spawn options. */
export interface CellOptions {
  readonly capacity: number;
  readonly supervision: SupervisorStrategy;
}

type SystemMessage =
  | { readonly type: 'stop' }
  | { readonly type: 'terminated'; readonly target: CellNode }
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
  readonly watchers = new Set<Watcher>();
  readonly #watching = new Set<CellNode>();
  readonly #def: ActorDef<M, S>;
  readonly #host: CellHost;
  readonly #capacity: number;
  readonly #strategy: SupervisorStrategy;
  readonly #mailbox = new Queue<Envelope<M>>();
  readonly #timers: TimerTable<M>;
  readonly #system = new Queue<SystemMessage>();
  readonly #log: Logger;
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

  /** Queues the actor's first step, which runs `initial`. */
  start(): void {
    this.#schedule();
  }

  requestStop(): void {
    if (this.#stopping()) return;
    this.#system.push({ type: 'stop' });
    this.#scheduleIfReady();
  }

  notifyTerminated(target: CellNode): void {
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

  /** Builds the ctx for the current incarnation. It goes stale once that incarnation ends. */
  #makeContext(): ActorContext<M> {
    const incarnation = this.#incarnation;
    const current = () => this.#incarnation === incarnation;
    const host = this.#host;
    return Object.freeze({
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
      pipeToSelf: <T>(promise: PromiseLike<T>, map: (result: Result<T>) => M) => {
        if (typeof map !== 'function') {
          throw new TypeError('pipeToSelf: map must be a function');
        }
        this.#pipe(promise, map);
      },
    });
  }

  /** Unwraps one mailbox item and hands it to `receive`. */
  #receive(item: Envelope<M>): void {
    let msg: M;
    if (item instanceof TimerEnvelope) {
      // A cancelled or replaced timer's message is dropped here, even if it was already queued.
      if (!this.#timers.accept(item)) return;
      msg = item.msg;
    } else if (item instanceof PipeEnvelope) {
      try {
        msg = item.map(item.result);
      } catch (error) {
        this.#fail(error, { pipeToSelf: item.result.ok ? 'ok' : 'error' });
        return;
      }
    } else {
      msg = item;
    }
    this.#invoke(() => this.#def.receive(this.#state as S, msg, this.#ctx), { message: msg });
  }

  /**
   * Waits for `promise` without making the cell busy, so the mailbox stays open (decision 0002),
   * then queues the result for its mapper.
   *
   * An ask's result is queued the moment the ask settles, with no promise hop, so piping an ask
   * runs entirely on the scheduler and isn't busy work for `settle` (decision 0010).
   */
  #pipe<T>(promise: PromiseLike<T>, map: (result: Result<T>) => M): void {
    const host = this.#host;
    // The envelope only ever passes this result to this mapper, so widening T is safe.
    const widened = map as (result: Result<unknown>) => M;
    const enqueue = (result: Result<unknown>): void => {
      this.#enqueue(new PipeEnvelope(result, widened));
    };
    if (host.onAskSettled(promise, enqueue)) {
      // The result arrives through the listener. Handle the rejection here too, or a timed-out
      // ask would be an unhandled rejection.
      Promise.resolve(promise).then(undefined, () => {});
      return;
    }
    host.trackBusy(1);
    const deliver = (result: Result<unknown>): void => {
      host.trackBusy(-1);
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

  #stopping(): boolean {
    return this.#phase === 'stopping' || this.#phase === 'terminated';
  }

  /** Queues a message, or makes it a dead letter. Returns false for a dead letter. */
  #enqueue(item: Envelope<M>): boolean {
    const reason = this.#host.terminating()
      ? 'terminated'
      : this.#stopping()
        ? 'stopped'
        : this.#mailbox.size >= this.#capacity
          ? 'mailboxFull'
          : undefined;
    if (reason !== undefined) {
      this.#deadLetter(item, reason);
      return false;
    }
    // While restarting, messages queue up and wait for the new incarnation.
    this.#mailbox.push(item);
    this.#scheduleIfReady();
    return true;
  }

  /** Publishes what was sent, never the cell's wrapper: a pipe's raw `Result`, a timer's message. */
  #deadLetter(item: Envelope<M>, reason: DeadLetterReason): void {
    const message =
      item instanceof PipeEnvelope
        ? item.result
        : item instanceof TimerEnvelope
          ? (item.msg as unknown)
          : item;
    this.#host.events.publish({ type: 'deadLetter', recipient: this.path, message, reason });
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
    try {
      this.#state =
        typeof initial === 'function'
          ? (initial as (ctx: ActorContext<M>) => S)(this.#ctx)
          : initial;
      this.#hasState = true;
    } catch (error) {
      this.#fail(error, {}, true);
    }
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

  #awaitBusy<T>(promise: Promise<T>, ok: (value: T) => void, failed: (error: unknown) => void) {
    this.#busy = true;
    this.#host.trackBusy(1);
    Promise.resolve(promise).then(
      (value) => {
        this.#busy = false;
        this.#host.trackBusy(-1);
        ok(value);
        this.#scheduleIfReady();
      },
      (error: unknown) => {
        this.#busy = false;
        this.#host.trackBusy(-1);
        failed(error);
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
    const target = this.#cellOrThrow(ref, 'watch');
    if (this.#phase !== 'running' || target === this || this.#watching.has(target)) return;
    this.#watching.add(target);
    if (target.terminated) {
      this.notifyTerminated(target);
    } else {
      target.watchers.add(this);
    }
  }

  #unwatch(ref: AnyRef): void {
    const target = this.#cellOrThrow(ref, 'unwatch');
    this.#watching.delete(target);
    target.watchers.delete(this);
  }

  #unwatchAll(): void {
    for (const target of this.#watching) target.watchers.delete(this);
    this.#watching.clear();
  }

  #cellOrThrow(ref: unknown, what: string): CellNode {
    const cell = this.#host.cellOf(ref);
    if (cell === undefined) {
      throw new TypeError(`${what}: the ref is not an actor of this system`);
    }
    return cell;
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
      const item = this.#mailbox.shift() as Envelope<M>;
      // Its timer was cancelled just above, so its message is never received, not even as a
      // dead letter.
      if (!(item instanceof TimerEnvelope)) this.#deadLetter(item, 'stopped');
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
    for (const watcher of this.watchers) watcher.notifyTerminated(this);
    this.watchers.clear();
    this.#host.events.publish(
      this.#failure === undefined
        ? { type: 'stopped', path: this.path }
        : { type: 'stopped', path: this.path, failure: this.#failure.error },
    );
  }
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
