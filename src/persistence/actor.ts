import { checkInt, checkKeys, describe } from '../checks.js';
import {
  internalsOf,
  PERSISTENT,
  START,
  type PersistentHook,
  type WithStart,
} from '../internal.js';
import { isValidName } from '../names.js';
import type { ActorContext, ActorDef, ActorRef, Signal } from '../types.js';
import {
  EventValidationError,
  EventVersionError,
  JournalSequenceError,
  PersistenceTimeoutError,
  type PersistenceOperation,
} from './errors.js';
import { jsonProblem } from '../json.js';
import { withTimeout } from '../timeout.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import type { Journal, NewEvent, Persistence, SnapshotStore, StoredEvent } from './types.js';

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

/**
 * Runtime checks and versions for a persistent actor's events (decision 0018). Every event is
 * stored as `persist` got it, with `version`. The schema checks it before the append, and again on
 * recovery after the upcasters, and `onEvent` gets the schema's output both times.
 */
export interface EventOptions<E> {
  /**
   * Checks events on write, before the append, and on recovery, after upcasting. Any Standard
   * Schema library works, sync or async. A failure is `EventValidationError`, with the issues.
   */
  schema?: StandardSchemaV1<unknown, E>;
  /** The current event version, a positive integer, stored with every new event. Default 1. */
  version?: number;
  /**
   * One function per old version, keyed by the version it upgrades from: `upcasters[n]` turns a
   * version-n event into a version-(n + 1) one. They must cover every version from 1 to
   * `version - 1`, and nothing else. A stored event runs through each of them from its own
   * version up, then through the schema.
   */
  upcasters?: Readonly<Record<number, (event: unknown) => unknown>>;
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
  /**
   * The tags to store with an event, for projections to follow it by. Optional. It gets the
   * schema's output, as `onEvent` does. Each tag matches the actor name pattern: 1 to 64 letters,
   * digits, ".", "_", "~" or "-", starting with a letter or digit, and an event's tags don't
   * repeat. A tag that breaks these rules fails the command with a `TypeError`, and nothing is
   * written.
   */
  tags?(event: E): readonly string[];
  /** Runtime checks and versions for events. Optional. */
  events?: EventOptions<E>;
  /**
   * Snapshotting, so recovery doesn't replay the whole stream. Optional, and needs
   * `persistence.snapshots`. A snapshot is only a shortcut: events are never deleted after one, and
   * recovery replays every event when it can't use it.
   */
  snapshots?: {
    /**
     * Saves a snapshot after any persist that takes `lastSeq` across a multiple of `every`, at the
     * new `lastSeq`. A positive integer.
     */
    every: number;
    /**
     * The state's schema version, a positive integer. Default 1. Recovery ignores a snapshot with
     * another version, so bump it whenever the state's shape changes.
     */
    version?: number;
  };
  /**
   * How long each journal and snapshot call may take, in ms: a positive integer. Default 10,000.
   * An append or a recovery read that takes longer fails the actor with
   * `PersistenceTimeoutError`, for its supervision to handle, and no reply is sent. The append
   * may still have been written, so a restart recovers from the journal to find out (decision
   * 0036). A snapshot load that takes longer is skipped, and recovery replays every event. A
   * snapshot save that takes longer is logged.
   */
  timeoutMs?: number;
}

const OPTIONS = new Set([
  'id',
  'persistence',
  'initial',
  'onCommand',
  'onEvent',
  'onSignal',
  'tags',
  'events',
  'snapshots',
  'timeoutMs',
]);
const SNAPSHOT_OPTIONS = new Set(['every', 'version']);
const EVENT_OPTIONS = new Set(['schema', 'version', 'upcasters']);
const MAX_ID_LENGTH = 255;
/** Events per read during recovery and `stateAt`. */
const PAGE_SIZE = 256;
const DEFAULT_TIMEOUT_MS = 10_000;

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
  const snapshotting = snapshotPlan(def);
  const { schema, version, upcasters } = eventPlan(def.events);
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** `call`, timed on the actor's scheduler (decision 0036). */
  const timed = <T>(
    ctx: ActorContext<C>,
    operation: PersistenceOperation,
    call: PromiseLike<T>,
  ): Promise<T> =>
    withTimeout(
      call,
      timeoutMs,
      internalsOf(ctx).setTimer,
      () => new PersistenceTimeoutError(id, operation, timeoutMs),
    );

  /** The schema's output for `event`. */
  const check = async (
    using: StandardSchemaV1<unknown, E>,
    event: unknown,
    seq: number | undefined,
  ): Promise<E> => {
    const result = await using['~standard'].validate(event);
    if (result.issues) throw new EventValidationError(id, seq, result.issues);
    return result.value;
  };

  /** A stored event raised to the current version, not yet checked. */
  const upcast = (stored: StoredEvent): unknown => {
    if (stored.version > version) {
      throw new EventVersionError(id, stored.seq, stored.version, version);
    }
    let event = stored.event;
    for (let v = stored.version; v < version; v++) {
      const up = upcasters[v];
      // Only a backend that broke its contract stores a version below 1.
      if (up === undefined) {
        throw new TypeError(
          `${id}: event ${String(stored.seq)} has version ${String(stored.version)}, ` +
            'which no upcaster covers',
        );
      }
      event = up(event);
    }
    return event;
  };

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

  /** An event's tags, checked so a bad one fails the command instead of the append. */
  const tagsFor = (event: E, i: number): readonly string[] => {
    if (def.tags === undefined) return [];
    const tags: unknown = def.tags(event);
    if (!Array.isArray(tags)) {
      throw new TypeError(`${id}: tags() must return an array for event ${String(i)}`);
    }
    const seen = new Set<string>();
    for (const tag of tags as readonly unknown[]) {
      if (!isValidName(tag)) {
        throw new TypeError(
          `${id}: tags() returned ${describe(tag)} for event ${String(i)}, but a tag must be 1 ` +
            'to 64 letters, digits, ".", "_", "~" or "-", starting with a letter or digit',
        );
      }
      if (seen.has(tag)) {
        throw new TypeError(`${id}: tags() repeats "${tag}" for event ${String(i)}`);
      }
      seen.add(tag);
    }
    return [...seen];
  };

  /** Appends, then applies and runs the steps. The cell holds the mailbox until it settles. */
  const persistThen = async (
    current: PersistentState<S>,
    effect: EffectImpl<E, S>,
    ctx: ActorContext<C>,
  ): Promise<PersistentState<S>> => {
    // If this rejects, the actor can't know what the journal holds, so it applies nothing. A
    // restart recovers from the journal, which settles it (decision 0013).
    // Checked before the append, so an event that fails its schema is never written. In order,
    // one at a time, so an async schema's failures are deterministic. Without a schema nothing
    // awaits, so the append starts in the same turn as the command.
    let applied = effect.events;
    if (schema !== undefined) {
      const checked: E[] = [];
      for (const event of effect.events) checked.push(await check(schema, event, undefined));
      applied = checked;
    }
    // Stored as persist got it (decision 0018), but tagged from the schema's output, so tags see
    // the value onEvent folds. `applied` has one entry per event, in the same order.
    const batch = effect.events.map((event, i): NewEvent => ({
      event,
      version,
      tags: tagsFor(applied[i] as E, i),
    }));
    // A timeout rejects here too: the outcome is unknown, so nothing is applied and no step runs.
    const appending = timed(ctx, 'append', journal.append(id, current.seq, batch));
    // Planted (T6): the replies go before the append has settled, so one may acknowledge a write
    // the journal never got.
    const early = internalsOf(ctx).plant() === 'early-reply';
    if (early) {
      appending.catch(() => {});
      const folded = applied.reduce((s, event) => def.onEvent(s, event), current.state);
      internalsOf(ctx).asSender(() => {
        runSteps(effect, folded, ctx);
      });
    }
    await appending;
    let state = current.state;
    // The schema's output, as recovery will see it, so a write and its replay fold the same value.
    for (const event of applied) state = def.onEvent(state, event);
    const next: PersistentState<S> = { seq: current.seq + batch.length, state };
    internalsOf(ctx).publish({
      type: 'persisted',
      path: ctx.self.path,
      persistenceId: id,
      fromSeq: current.seq + 1,
      toSeq: next.seq,
    });
    // After the append's await, so outside the cell's turn: the steps' tells name this actor as
    // their sender only through the hook (decision 0020).
    if (!early) {
      internalsOf(ctx).asSender(() => {
        runSteps(effect, state, ctx);
      });
    }
    if (snapshotting !== undefined && snapshotDue(current.seq, next.seq, snapshotting.every)) {
      saveSnapshot(snapshotting, next, ctx);
    }
    return next;
  };

  /** Starts a save without waiting for it: the events are safe, so a snapshot is only a shortcut. */
  const saveSnapshot = (
    plan: SnapshotPlan,
    { seq, state }: PersistentState<S>,
    ctx: ActorContext<C>,
  ): void => {
    // Checked here rather than left to the backend, so a state that breaks decision 0001 is an
    // error under the actor's path, not a failed save.
    const problem = jsonProblem(state);
    if (problem !== undefined) {
      ctx.log.error(`${id}: state is not a JSON value, so no snapshot was saved: ${problem}`, {
        persistenceId: id,
        seq,
      });
      return;
    }
    const saving = timed(
      ctx,
      'saveSnapshot',
      plan.store.save(id, { seq, version: plan.version, state }),
    ).then(
      () => {},
      (error: unknown) => {
        ctx.log.warn(`${id}: saving the snapshot at ${String(seq)} failed`, {
          persistenceId: id,
          seq,
          error,
        });
      },
    );
    internalsOf(ctx).track(saving);
  };

  /** The state to replay from: the latest usable snapshot, or `start` when there isn't one. */
  const startFrom = async (
    start: PersistentState<S>,
    ctx: ActorContext<C>,
  ): Promise<PersistentState<S>> => {
    if (snapshotting === undefined) return start;
    let snapshot;
    try {
      snapshot = await timed(ctx, 'loadSnapshot', snapshotting.store.load(id));
    } catch (error) {
      ctx.log.warn(`${id}: loading the snapshot failed, so recovery replays every event`, {
        persistenceId: id,
        error,
      });
      return start;
    }
    if (snapshot === undefined) return start;
    if (snapshot.version !== snapshotting.version) {
      ctx.log.info(
        `${id}: ignoring the snapshot at ${String(snapshot.seq)}, which has version ` +
          `${String(snapshot.version)}, not ${String(snapshotting.version)}`,
        { persistenceId: id, seq: snapshot.seq },
      );
      return start;
    }
    // The version matches, so the stored state has this definition's shape.
    return { seq: snapshot.seq, state: snapshot.state as S };
  };

  type Read = (fromSeq: number, limit: number) => Promise<readonly StoredEvent[]>;
  const untimedRead: Read = (fromSeq, limit) => journal.read(id, fromSeq, limit);

  /**
   * Folds the journal's events after `start.seq`, up to `until` or the end, whichever comes first:
   * upcast, checked and applied, as recovery and `stateAt` both need.
   */
  const fold = async (
    start: PersistentState<S>,
    until: number,
    read: Read,
  ): Promise<PersistentState<S>> => {
    let { seq, state } = start;
    for (;;) {
      const want = Math.min(PAGE_SIZE, until - seq);
      if (want <= 0) break;
      const page = await read(seq + 1, want);
      for (const stored of page) {
        if (stored.seq !== seq + 1) throw new JournalSequenceError(id, seq + 1, stored.seq);
        const event = upcast(stored);
        // Without a schema, the definition's types are the only claim about the event's shape.
        state = def.onEvent(
          state,
          schema === undefined ? (event as E) : await check(schema, event, stored.seq),
        );
        seq = stored.seq;
      }
      if (page.length < want) break;
    }
    return { seq, state };
  };

  const recover = async (
    initial: PersistentState<S>,
    ctx: ActorContext<C>,
  ): Promise<PersistentState<S>> => {
    const start = await startFrom(initial, ctx);
    const { seq, state } = await fold(start, Infinity, (fromSeq, limit) =>
      timed(ctx, 'read', journal.read(id, fromSeq, limit)),
    );
    internalsOf(ctx).publish({
      type: 'recovered',
      path: ctx.self.path,
      persistenceId: id,
      snapshotSeq: start.seq,
      lastSeq: seq,
    });
    // A throw here is a failure in the start, like one in recovery: this is where the actor
    // restarts its timers, and carrying on without them would hide the bug.
    // After recovery's awaits, so outside the cell's turn, like the effect steps.
    internalsOf(ctx).asSender(() => {
      def.onSignal?.(state, { type: 'recoveryCompleted', seq }, contextFor(ctx, seq));
    });
    return { seq, state };
  };

  /** For inspectors: the state after event `seq`, from the journal alone, with no snapshot. */
  const stateAt = async (seq: number): Promise<S> => {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError(`${id}: stateAt needs a non-negative integer, got ${describe(seq)}`);
    }
    // An inspector's call, with no actor and so no scheduler of its own to time it on.
    const reached = await fold({ seq: 0, state: def.initial }, seq, untimedRead);
    if (reached.seq < seq) {
      throw new RangeError(
        `${id}: the journal ends at event ${String(reached.seq)}, before ${String(seq)}`,
      );
    }
    return reached.state;
  };
  const hook: PersistentHook = Object.freeze({
    persistenceId: id,
    persistence: def.persistence,
    stateAt,
  });

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
      made.events.forEach((event, i) => {
        // Checked here, so the failure lands in the command that made the event (decision 0014).
        const problem = jsonProblem(event);
        if (problem !== undefined) {
          throw new TypeError(`${id}: event ${String(i)} is not a JSON value: ${problem}`);
        }
      });
      return persistThen(current, made, ctx);
    },
    [START]: recover,
  };
  // Not enumerable, so spreading a definition doesn't carry it to a def that isn't this one.
  Object.defineProperty(result, PERSISTENT, { value: hook });
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
  for (const key of ['onSignal', 'tags']) {
    if (d[key] !== undefined && typeof d[key] !== 'function') {
      throw new TypeError(`persistentActor: ${key} must be a function when it is set`);
    }
  }
  if (d.events !== undefined) checkEvents(d.events);
  if (d.snapshots !== undefined) checkSnapshots(d.snapshots, persistence);
  if (d.timeoutMs !== undefined) checkInt(d.timeoutMs, 'persistentActor: timeoutMs');
}

function checkEvents(events: unknown): void {
  checkKeys(events, EVENT_OPTIONS, 'persistentActor: events');
  const { schema, version = 1, upcasters } = events as Record<string, unknown>;
  if (schema !== undefined && !isStandardSchema(schema)) {
    throw new TypeError(
      'persistentActor: events.schema must be a Standard Schema, with ~standard.validate',
    );
  }
  checkInt(version, 'persistentActor: events.version');
  const current = version as number;
  if (upcasters === undefined) {
    if (current > 1) {
      throw new TypeError(
        `persistentActor: events.version is ${String(current)}, so events.upcasters must ` +
          `cover versions 1 to ${String(current - 1)}`,
      );
    }
    return;
  }
  if (typeof upcasters !== 'object' || upcasters === null || Array.isArray(upcasters)) {
    throw new TypeError('persistentActor: events.upcasters must be an object');
  }
  const ups = upcasters as Record<string, unknown>;
  // A key outside 1 to version - 1 usually means the version wasn't bumped with the upcaster.
  for (const key of Object.keys(ups)) {
    const from = Number(key);
    if (!Number.isSafeInteger(from) || String(from) !== key || from < 1 || from >= current) {
      throw new TypeError(
        `persistentActor: events.upcasters has a key "${key}", but upcasters run from each ` +
          `version below events.version (${String(current)}), starting at 1`,
      );
    }
  }
  for (let from = 1; from < current; from++) {
    if (typeof ups[String(from)] !== 'function') {
      throw new TypeError(
        `persistentActor: events.upcasters has no function for version ${String(from)}, so ` +
          `events stored at it can't reach version ${String(current)}`,
      );
    }
  }
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const props = (value as { '~standard'?: unknown })['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    typeof (props as { validate?: unknown }).validate === 'function'
  );
}

interface EventPlan<E> {
  readonly schema: StandardSchemaV1<unknown, E> | undefined;
  readonly version: number;
  readonly upcasters: Readonly<Record<number, (event: unknown) => unknown>>;
}

/** The checked event options, with their defaults. */
function eventPlan<E>(events: EventOptions<E> | undefined): EventPlan<E> {
  return {
    schema: events?.schema,
    version: events?.version ?? 1,
    upcasters: events?.upcasters ?? {},
  };
}

function checkSnapshots(snapshots: unknown, persistence: Persistence): void {
  checkKeys(snapshots, SNAPSHOT_OPTIONS, 'persistentActor: snapshots');
  const { every, version } = snapshots as Record<string, unknown>;
  checkInt(every, 'persistentActor: snapshots.every');
  if (version !== undefined) checkInt(version, 'persistentActor: snapshots.version');
  if (!isSnapshotStore(persistence.snapshots)) {
    throw new TypeError(
      'persistentActor: snapshots needs persistence.snapshots, with save and load',
    );
  }
}

interface SnapshotPlan {
  readonly store: SnapshotStore;
  readonly every: number;
  readonly version: number;
}

/** The checked snapshot options, with their defaults, or undefined when there are none. */
function snapshotPlan(def: {
  readonly snapshots?: { readonly every: number; readonly version?: number };
  readonly persistence: Persistence;
}): SnapshotPlan | undefined {
  const { snapshots } = def;
  const store = def.persistence.snapshots;
  if (snapshots === undefined || store === undefined) return undefined;
  return { store, every: snapshots.every, version: snapshots.version ?? 1 };
}

/** Whether a persist from `fromSeq` to `toSeq` crossed a multiple of `every`. */
function snapshotDue(fromSeq: number, toSeq: number, every: number): boolean {
  return Math.floor(fromSeq / every) < Math.floor(toSeq / every);
}

function isSnapshotStore(value: unknown): value is SnapshotStore {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.save === 'function' && typeof s.load === 'function';
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
