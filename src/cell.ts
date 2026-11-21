import type { Dispatcher, Runnable } from './dispatcher.js';
import type { EventBus } from './events.js';
import { ActorStoppedError, NotAChildError } from './errors.js';
import { safeLogger, type Logger } from './logger.js';
import type { Names } from './names.js';
import { Queue } from './queue.js';
import type { ActorContext, ActorDef, ActorRef, AnyRef, Signal, SpawnOptions } from './types.js';

/** A failure, kept with a flag because `throw undefined` is legal. */
type Failure = { readonly error: unknown } | undefined;

/** What other cells, the guardian and the system see of a cell, whatever its types. */
export interface CellNode {
  readonly ref: AnyRef;
  readonly name: string;
  readonly parent: ParentNode;
  readonly terminated: boolean;
  readonly failure: Failure;
  /** Asks the cell to stop after its current message, ahead of its queued messages. */
  requestStop(): void;
  /** Tells a watcher that `target` has terminated. */
  notifyTerminated(target: CellNode): void;
  /** Watchers of this cell, kept so it can notify them when it terminates. */
  readonly watchers: Set<CellNode>;
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
  /** Called with +1 when a cell starts waiting on a promise, and -1 when it stops. */
  trackBusy(delta: 1 | -1): void;
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

type SystemMessage =
  | { readonly type: 'stop' }
  | { readonly type: 'terminated'; readonly target: CellNode }
  | { readonly type: 'childrenDone' };

type Phase = 'running' | 'stopping' | 'terminated';

/**
 * One actor: its state, mailbox and lifecycle. The dispatcher gives it turns, and it runs one
 * message at a time, holding its mailbox while an async `receive` or `onSignal` is pending
 * (decision 0002).
 *
 * It has two queues. The system queue holds stop requests and `terminated` notices, and is always
 * read before the user queue, so a stop jumps ahead of queued messages.
 *
 * Stopping goes: dead-letter the user queue, stop every child and wait for them, run `postStop`,
 * then terminate, which frees the name, notifies watchers and publishes `stopped`. Until T4 adds
 * supervision, every failure stops the actor this way, with `failure` set.
 */
export class Cell<M, S> implements Runnable, CellNode, ParentNode {
  readonly ref: ActorRef<M>;
  readonly ctx: ActorContext<M>;
  readonly name: string;
  readonly path: string;
  readonly parent: ParentNode;
  readonly names: Names;
  readonly childCells = new Map<string, CellNode>();
  readonly watchers = new Set<CellNode>();
  readonly #watching = new Set<CellNode>();
  readonly #def: ActorDef<M, S>;
  readonly #host: CellHost;
  readonly #capacity: number;
  readonly #mailbox = new Queue<M>();
  readonly #system = new Queue<SystemMessage>();
  readonly #log: Logger;
  #state: S | undefined;
  #started = false;
  // True once initial has returned, so there's a state to pass to postStop.
  #hasState = false;
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
    capacity: number,
    parent: ParentNode,
    names: Names,
  ) {
    this.name = name;
    this.path = path;
    this.#def = def;
    this.#host = host;
    this.#capacity = capacity;
    this.parent = parent;
    this.names = names;
    this.#log = safeLogger(host.log, { path });
    this.ref = Object.freeze({
      path,
      tell: (msg: M) => {
        this.#tell(msg);
      },
    });
    this.ctx = Object.freeze({
      self: this.ref,
      log: this.#log,
      now: () => host.now(),
      spawn: <C, CS>(def: ActorDef<C, CS>, childName?: string, opts?: SpawnOptions) => {
        if (this.#phase !== 'running') {
          throw new ActorStoppedError(`${path} is stopping or has stopped, so it can't spawn`);
        }
        return host.spawn(this, def, childName, opts);
      },
      stop: (ref?: AnyRef) => {
        this.#stop(ref);
      },
      watch: (ref: AnyRef) => {
        this.#watch(ref);
      },
      unwatch: (ref: AnyRef) => {
        this.#unwatch(ref);
      },
      child: (childName: string) => this.childCells.get(childName)?.ref,
      children: () => [...this.childCells.values()].map((c) => c.ref),
    });
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
    if (this.#phase !== 'running') return;
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
    if (this.#phase === 'stopping' && this.childCells.size === 0) {
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
        // Size checked above, so shift() returns a message. M itself may include undefined.
        const msg = this.#mailbox.shift() as M;
        steps++;
        this.#invoke(() => this.#def.receive(this.#state as S, msg, this.ctx), { message: msg });
      }
    } finally {
      this.#running = false;
    }
    this.#scheduleIfReady();
    return steps;
  }

  #tell(msg: M): void {
    const reason = this.#host.terminating()
      ? 'terminated'
      : this.#phase !== 'running'
        ? 'stopped'
        : this.#mailbox.size >= this.#capacity
          ? 'mailboxFull'
          : undefined;
    if (reason !== undefined) {
      this.#deadLetter(msg, reason);
      return;
    }
    this.#mailbox.push(msg);
    this.#scheduleIfReady();
  }

  #deadLetter(message: unknown, reason: 'mailboxFull' | 'stopped' | 'terminated'): void {
    this.#host.events.publish({ type: 'deadLetter', recipient: this.path, message, reason });
  }

  #scheduleIfReady(): void {
    if (this.#scheduled || this.#running || this.#busy || this.#phase === 'terminated') return;
    if (this.#started && this.#system.size === 0 && this.#mailbox.size === 0) return;
    this.#schedule();
  }

  #schedule(): void {
    this.#scheduled = true;
    this.#host.dispatcher.schedule(this);
  }

  #init(): void {
    this.#started = true;
    const { initial } = this.#def;
    try {
      this.#state =
        typeof initial === 'function'
          ? (initial as (ctx: ActorContext<M>) => S)(this.ctx)
          : initial;
      this.#hasState = true;
    } catch (error) {
      this.#fail(error, {});
    }
  }

  #handleSystem(sys: SystemMessage): void {
    switch (sys.type) {
      case 'stop':
        this.#beginStop(undefined);
        return;
      case 'childrenDone':
        this.#postStop();
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
        this.#invoke(() => onSignal(this.#state as S, signal, this.ctx), {
          signal: 'terminated',
          target: sys.target.ref.path,
        });
        return;
      }
    }
  }

  /**
   * Runs a handler that returns the next state, directly or as a promise. A promise makes the
   * cell busy until it settles. A throw or rejection fails the actor.
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

  #fail(error: unknown, context: Record<string, unknown>): void {
    this.#log.error('actor failed; stopping it', { ...context, error });
    this.#beginStop({ error });
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

  #cellOrThrow(ref: unknown, what: string): CellNode {
    const cell = this.#host.cellOf(ref);
    if (cell === undefined) {
      throw new TypeError(`${what}: the ref is not an actor of this system`);
    }
    return cell;
  }

  #beginStop(failure: Failure): void {
    if (this.#phase !== 'running') return;
    this.#phase = 'stopping';
    this.#failure = failure;
    while (this.#mailbox.size > 0) this.#deadLetter(this.#mailbox.shift(), 'stopped');
    if (this.childCells.size === 0) {
      this.#postStop();
      return;
    }
    for (const child of [...this.childCells.values()]) child.requestStop();
  }

  #postStop(): void {
    const onSignal = this.#def.onSignal?.bind(this.#def);
    if (onSignal === undefined || !this.#hasState) {
      this.#terminate();
      return;
    }
    let result: S | Promise<S>;
    try {
      result = onSignal(this.#state as S, { type: 'postStop' }, this.ctx);
    } catch (error) {
      this.#log.error('postStop threw; stopping anyway', { error });
      this.#terminate();
      return;
    }
    if (!isThenable(result)) {
      this.#terminate();
      return;
    }
    this.#awaitBusy(
      result,
      () => {
        this.#terminate();
      },
      (error) => {
        this.#log.error('postStop rejected; stopping anyway', { error });
        this.#terminate();
      },
    );
  }

  #terminate(): void {
    this.#phase = 'terminated';
    for (const target of this.#watching) target.watchers.delete(this);
    this.#watching.clear();
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
