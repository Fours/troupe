import { checkKeys, describe } from '../checks.js';
import { internalsOf, START, type WithStart } from '../internal.js';
import type { ActorContext, ActorDef, ActorRef, Signal } from '../types.js';
import { JournalSequenceError } from './errors.js';
import { jsonProblem } from './json.js';
import type { Journal, NewEvent, Persistence } from './types.js';

// These interfaces grow task by task through milestone 2: each one holds only what's built.

/** A lifecycle signal for a persistent actor: the actor signals, plus the end of recovery. */
export type PersistentSignal =
  | Signal
  /**
   * Recovery has finished at sequence number `seq`, and commands are about to run. The place to
   * start the timers the state implies, since timers don't survive a restart.
   */
  | { readonly type: 'recoveryCompleted'; readonly seq: number };

/** What a persistent actor's cell holds: plain data, so milestone 3's inspector can show it. */
export interface PersistentState<S> {
  /** The sequence number of the last event applied, 0 before any. */
  readonly seq: number;
  /** The state the events have folded to. */
  readonly state: S;
}

/**
 * An immutable value describing what a command does: the events to persist, then the steps to run
 * once they're applied. Make one with `ctx.persist`, `ctx.reply` or `ctx.none`. Each method returns
 * a new effect.
 */
export interface Effect<E, S> {
  /** The events this effect persists, in order. Empty when it persists nothing. */
  readonly events: readonly E[];
  /**
   * After the events are applied, tells `to` the message built from the new state.
   * @throws TypeError unless `to` is a ref and `message` a function.
   */
  thenReply<R>(to: ActorRef<R>, message: (state: S) => NoInfer<R>): Effect<E, S>;
  /**
   * After the events are applied, runs `fn` with the new state. For side effects only.
   * @throws TypeError unless `fn` is a function.
   */
  thenRun(fn: (state: S) => void): Effect<E, S>;
  /**
   * Stops the actor once the events are written. Like `ctx.stop()`, it takes effect after the
   * current command, so steps chained after it still run.
   */
  thenStop(): Effect<E, S>;
}

/**
 * What a persistent actor can see and do while it runs: its `ActorContext`, plus its place in the
 * journal and the builders for effects. The builders are arrow properties, so they destructure
 * safely.
 */
export interface PersistentContext<C, E, S> extends ActorContext<C> {
  /** The event stream's id in the journal. */
  readonly persistenceId: string;
  /** The sequence number of the last event applied, 0 before any. */
  readonly lastSeq: number;
  /** Persists these events, in order, then applies them. With no events, it's `none()`. */
  readonly persist: (...events: E[]) => Effect<E, S>;
  /**
   * Persists nothing, and tells `to` the message at once.
   * @throws TypeError unless `to` is a ref.
   */
  readonly reply: <R>(to: ActorRef<R>, message: NoInfer<R>) => Effect<E, S>;
  /** Persists nothing. */
  readonly none: () => Effect<E, S>;
}

/** A persistent actor: a command handler, an event handler and an initial state. */
export interface PersistentActorDef<C, E, S> {
  /** The event stream's id in the journal: a non-empty string of at most 255 characters. */
  id: string;
  /** Where events are kept. */
  persistence: Persistence;
  /** The state before any event. */
  initial: S;
  /**
   * Decides what a command does. Synchronous, and returns an effect from `ctx`: it can't change the
   * state, only persist events that `onEvent` applies (decision 0012).
   */
  onCommand(state: S, command: C, ctx: PersistentContext<C, E, S>): Effect<E, S>;
  /**
   * Applies one event. Pure: it runs again for every event on every recovery, so it must not throw
   * for any event it has accepted before.
   */
  onEvent(state: S, event: E): S;
  /** Lifecycle signals, for side effects only. Optional. */
  onSignal?(state: S, signal: PersistentSignal, ctx: PersistentContext<C, E, S>): void;
}

const OPTIONS = new Set(['id', 'persistence', 'initial', 'onCommand', 'onEvent', 'onSignal']);
const MAX_ID_LENGTH = 255;
/** Events per read during recovery. */
const PAGE_SIZE = 256;
/** The event version until T4 adds schemas and upcasters. */
const VERSION = 1;

type Step<S> = (state: S, ctx: ActorContext<never>) => void;

/** The one implementation of `Effect`, so `onCommand` can't return something else by accident. */
class EffectImpl<E, S> implements Effect<E, S> {
  readonly events: readonly E[];
  readonly steps: readonly Step<S>[];

  constructor(events: readonly E[], steps: readonly Step<S>[]) {
    this.events = events;
    this.steps = steps;
    Object.freeze(this);
  }

  thenReply<R>(to: ActorRef<R>, message: (state: S) => NoInfer<R>): Effect<E, S> {
    checkRef(to, 'thenReply');
    if (typeof message !== 'function') {
      throw new TypeError(`thenReply: message must be a function, got ${describe(message)}`);
    }
    return this.#then((state) => {
      to.tell(message(state));
    });
  }

  thenRun(fn: (state: S) => void): Effect<E, S> {
    if (typeof fn !== 'function') {
      throw new TypeError(`thenRun: fn must be a function, got ${describe(fn)}`);
    }
    return this.#then((state) => {
      fn(state);
    });
  }

  thenStop(): Effect<E, S> {
    return this.#then((_state, ctx) => {
      ctx.stop();
    });
  }

  #then(step: Step<S>): Effect<E, S> {
    return new EffectImpl(this.events, [...this.steps, step]);
  }
}

const NONE = new EffectImpl<never, never>([], []);

/**
 * Defines an event-sourced actor. Commands go to `onCommand`, which returns an effect. Its events
 * are appended to the journal before they're applied with `onEvent`, and before any reply. On start
 * and on every restart, the actor recovers its state by replaying its events, and commands wait in
 * the mailbox until it's done (decision 0011).
 *
 * The result is an ordinary `ActorDef`: spawn, name and supervise it like any other actor. Every
 * append says which sequence number it follows, so a second writer to the same `id` fails with
 * `JournalConflictError` instead of corrupting the stream (decision 0013).
 *
 * @example
 * const account = (id: string) =>
 *   persistentActor<AccountCmd, AccountEvent, Account>({
 *     id: `account-${id}`,
 *     persistence,
 *     initial: { balance: 0 },
 *     onCommand: (state, cmd, { persist, reply }) =>
 *       cmd.type === 'deposit'
 *         ? persist({ type: 'deposited', amount: cmd.amount }).thenReply(cmd.replyTo, (s) => s.balance)
 *         : reply(cmd.replyTo, state.balance),
 *     onEvent: (state, event) => ({ balance: state.balance + event.amount }),
 *   });
 * @throws TypeError for a definition that can't be used, unknown fields included.
 */
export function persistentActor<C, E, S>(
  def: PersistentActorDef<C, E, S>,
): ActorDef<C, PersistentState<S>> {
  checkDef(def);
  const { id } = def;
  const journal: Journal = def.persistence.journal;

  const persist = (...events: E[]): Effect<E, S> =>
    events.length === 0 ? NONE : new EffectImpl<E, S>(events, []);
  const reply = <R>(to: ActorRef<R>, message: NoInfer<R>): Effect<E, S> => {
    checkRef(to, 'reply');
    return new EffectImpl<E, S>(
      [],
      [
        () => {
          to.tell(message);
        },
      ],
    );
  };
  const none = (): Effect<E, S> => NONE;

  const contextFor = (ctx: ActorContext<C>, lastSeq: number): PersistentContext<C, E, S> =>
    Object.freeze({ ...ctx, persistenceId: id, lastSeq, persist, reply, none });

  const runSteps = (effect: EffectImpl<E, S>, state: S, ctx: ActorContext<C>): void => {
    for (const step of effect.steps) step(state, ctx);
  };

  /** Appends, then applies and runs the steps. The cell holds the mailbox until it settles. */
  const persistThen = async (
    current: PersistentState<S>,
    effect: EffectImpl<E, S>,
    batch: readonly NewEvent[],
    ctx: ActorContext<C>,
  ): Promise<PersistentState<S>> => {
    // If this rejects, the actor can't know what the journal holds, so it applies nothing. A
    // restart recovers from the journal, which settles it (decision 0013).
    await journal.append(id, current.seq, batch);
    let state = current.state;
    for (const event of effect.events) state = def.onEvent(state, event);
    const next: PersistentState<S> = { seq: current.seq + batch.length, state };
    internalsOf(ctx).publish({
      type: 'persisted',
      path: ctx.self.path,
      persistenceId: id,
      fromSeq: current.seq + 1,
      toSeq: next.seq,
    });
    runSteps(effect, state, ctx);
    return next;
  };

  const recover = async (
    start: PersistentState<S>,
    ctx: ActorContext<C>,
  ): Promise<PersistentState<S>> => {
    let { seq, state } = start;
    for (;;) {
      const page = await journal.read(id, seq + 1, PAGE_SIZE);
      for (const stored of page) {
        if (stored.seq !== seq + 1) throw new JournalSequenceError(id, seq + 1, stored.seq);
        state = def.onEvent(state, stored.event as E);
        seq = stored.seq;
      }
      if (page.length < PAGE_SIZE) break;
    }
    internalsOf(ctx).publish({
      type: 'recovered',
      path: ctx.self.path,
      persistenceId: id,
      snapshotSeq: start.seq,
      lastSeq: seq,
    });
    // A throw here is a failure in the start, like one in recovery: this is where the actor
    // restarts its timers, and carrying on without them would hide the bug.
    def.onSignal?.(state, { type: 'recoveryCompleted', seq }, contextFor(ctx, seq));
    return { seq, state };
  };

  const result: ActorDef<C, PersistentState<S>> & WithStart<C, PersistentState<S>> = {
    initial: { seq: 0, state: def.initial },
    receive(current, command, ctx) {
      const effect: unknown = def.onCommand(current.state, command, contextFor(ctx, current.seq));
      if (!(effect instanceof EffectImpl)) {
        throw new TypeError(
          `${id}: onCommand must return an effect from ctx.persist, ctx.reply or ctx.none, ` +
            `got ${describe(effect)}`,
        );
      }
      const made = effect as EffectImpl<E, S>;
      if (made.events.length === 0) {
        // Nothing to wait for, so the mailbox stays open.
        runSteps(made, current.state, ctx);
        return current;
      }
      const batch = made.events.map((event, i): NewEvent => {
        // Checked here, so the failure lands in the command that made the event (decision 0014).
        const problem = jsonProblem(event);
        if (problem !== undefined) {
          throw new TypeError(`${id}: event ${String(i)} is not a JSON value: ${problem}`);
        }
        return { event, version: VERSION, tags: [] };
      });
      return persistThen(current, made, batch, ctx);
    },
    [START]: recover,
  };
  if (def.onSignal !== undefined) {
    result.onSignal = (current, signal, ctx) => {
      def.onSignal?.(current.state, signal, contextFor(ctx, current.seq));
      return current;
    };
  }
  return result;
}

function checkDef(def: unknown): void {
  checkKeys(def, OPTIONS, 'persistentActor');
  const d = def as Record<string, unknown>;
  const { id, persistence } = d;
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
    throw new TypeError(
      `persistentActor: id must be a string of 1 to ${String(MAX_ID_LENGTH)} characters, ` +
        `got ${typeof id === 'string' ? `one of ${String(id.length)}` : describe(id)}`,
    );
  }
  if (!isPersistence(persistence)) {
    throw new TypeError('persistentActor: persistence must have a journal with append and read');
  }
  if (!('initial' in d)) throw new TypeError('persistentActor: the definition has no initial');
  for (const key of ['onCommand', 'onEvent']) {
    if (typeof d[key] !== 'function') {
      throw new TypeError(`persistentActor: ${key} must be a function, got ${describe(d[key])}`);
    }
  }
  if (d.onSignal !== undefined && typeof d.onSignal !== 'function') {
    throw new TypeError('persistentActor: onSignal must be a function when it is set');
  }
}

function isPersistence(value: unknown): value is Persistence {
  if (typeof value !== 'object' || value === null) return false;
  const journal = (value as { journal?: unknown }).journal;
  if (typeof journal !== 'object' || journal === null) return false;
  const j = journal as Record<string, unknown>;
  return typeof j.append === 'function' && typeof j.read === 'function';
}

function checkRef(to: unknown, what: string): void {
  if (
    typeof to !== 'object' ||
    to === null ||
    typeof (to as { tell?: unknown }).tell !== 'function'
  ) {
    throw new TypeError(`${what}: to must be an actor ref`);
  }
}
