import { checkInt, checkKeys, describe } from '../checks.js';
import { internalsOf, START, type WithStart } from '../internal.js';
import { isValidName } from '../names.js';
import { withTimeout } from '../timeout.js';
import type { ActorContext, ActorDef } from '../types.js';
import { PersistenceTimeoutError, type PersistenceOperation } from './errors.js';
import type { Journal, OffsetStore, Persistence, StoredEvent } from './types.js';

/** Options for a projection: what it follows, where it keeps its place, and what it does. */
export interface ProjectionOptions {
  /**
   * The projection's key in the offset store: a non-empty string of at most 255 characters. A new
   * projection with the same name starts where the last one stopped.
   */
  name: string;
  /** Where events and offsets are kept. Needs `journal` and `offsets`. */
  persistence: Persistence;
  /** The tag to follow. It matches the actor name pattern, as `tags()` results do. */
  tag: string;
  /**
   * Handles one event, and may return a promise, which is awaited before the next event. At least
   * once: after a failure, the batch runs again from its start, so an event can repeat. It gets
   * the stored event as written, not upcast or checked, since a tag can span entity types. In
   * message events, what it tells before any `await` of its own has the projection as its sender.
   */
  handle(event: StoredEvent): void | Promise<void>;
  /** How long to wait after a batch that wasn't full, in ms. A positive integer. Default 1,000. */
  pollMs?: number;
  /** The most events per read. A positive integer. Default 100. */
  batchSize?: number;
  /**
   * How long each read and each offset load or save may take, in ms: a positive integer. Default
   * 10,000. One that takes longer fails the projection with `PersistenceTimeoutError`, and its
   * supervision decides when it tries again (decision 0036).
   */
  timeoutMs?: number;
}

/** What a projection's cell holds: the offset of the last event it handled, 0 before any. */
export interface ProjectionState {
  /** The offset of the last event handled and saved. */
  readonly offset: number;
}

const OPTIONS = new Set([
  'name',
  'persistence',
  'tag',
  'handle',
  'pollMs',
  'batchSize',
  'timeoutMs',
]);
const MAX_NAME_LENGTH = 255;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_TIMER = 'poll';

/** The projection's only message. Private, so nothing outside can tell it anything. */
const POLL = Object.freeze({ type: 'poll' });
type Poll = typeof POLL;

/**
 * Follows a tag through the journal and hands each event to `handle`, in offset order. It's an
 * actor: spawn and supervise it like any other. On start and on every restart, it loads its stored
 * offset. Then it reads a batch after that offset, handles the events one at a time, and saves the
 * offset of the last one. A full batch reads again at once, and a short one waits `pollMs`.
 *
 * A failure in `handle`, or in loading or saving the offset, goes to supervision. A restart reloads
 * the stored offset, so the failed batch runs again: delivery is at least once.
 *
 * @example
 * system.spawn(
 *   projection({ name: 'balances', persistence, tag: 'account', handle: (e) => totals.add(e) }),
 *   'balances',
 *   { supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }) },
 * );
 * @throws TypeError for options that can't be used, unknown fields included.
 */
export function projection(opts: ProjectionOptions): ActorDef<never, ProjectionState> {
  checkOptions(opts);
  const { name, tag } = opts;
  // Checked above, so both stores are there.
  const journal: Journal = opts.persistence.journal;
  const offsets = opts.persistence.offsets as OffsetStore;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** `call`, timed on the projection's scheduler (decision 0036). */
  const timed = <T>(
    ctx: ActorContext<Poll>,
    operation: PersistenceOperation,
    call: PromiseLike<T>,
  ): Promise<T> =>
    withTimeout(
      call,
      timeoutMs,
      internalsOf(ctx).setTimer,
      () => new PersistenceTimeoutError(name, operation, timeoutMs),
    );

  const def: ActorDef<Poll, ProjectionState> & WithStart<Poll, ProjectionState> = {
    initial: { offset: 0 },
    async receive(current, _poll, ctx) {
      const batch = await timed(
        ctx,
        'readByTag',
        journal.readByTag(tag, current.offset, batchSize),
      );
      // After the read's await, so outside the cell's turn: what handle tells names the projection
      // as its sender only through the hook (decision 0020). Called on opts, so a handle that uses
      // `this` sees the object it was defined on.
      const internals = internalsOf(ctx);
      for (const event of batch) await internals.asSender(() => opts.handle(event));
      const last = batch.at(-1);
      let next = current;
      if (last !== undefined) {
        await timed(ctx, 'saveOffset', offsets.save(name, last.offset));
        next = { offset: last.offset };
      }
      // Exactly one poll is ever pending, in the mailbox or on the timer. A failure above consumes
      // it, and the restart's start sends the next one, so the loop never doubles up.
      if (batch.length === batchSize) ctx.self.tell(POLL);
      else ctx.timers.startSingle(POLL_TIMER, POLL, pollMs);
      return next;
    },
    async [START](_state, ctx: ActorContext<Poll>) {
      const offset = await timed(ctx, 'loadOffset', offsets.load(name));
      ctx.self.tell(POLL);
      return { offset };
    },
  };
  // Poll is private, so the public type takes no messages. The cell only ever passes POLL.
  return def as unknown as ActorDef<never, ProjectionState>;
}

function checkOptions(opts: unknown): void {
  checkKeys(opts, OPTIONS, 'projection');
  const { name, persistence, tag, handle, pollMs, batchSize, timeoutMs } = opts as Record<
    string,
    unknown
  >;
  if (typeof name !== 'string' || name === '' || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(
      `projection: name must be a string of 1 to ${String(MAX_NAME_LENGTH)} characters, ` +
        `got ${typeof name === 'string' ? `one of ${String(name.length)}` : describe(name)}`,
    );
  }
  if (!isValidName(tag)) {
    throw new TypeError(
      `projection: tag must be 1 to 64 letters, digits, ".", "_", "~" or "-", starting with a ` +
        `letter or digit, got ${describe(tag)}`,
    );
  }
  if (!hasStores(persistence)) {
    throw new TypeError(
      'projection: persistence must have a journal with readByTag, and offsets with load and save',
    );
  }
  if (typeof handle !== 'function') {
    throw new TypeError(`projection: handle must be a function, got ${describe(handle)}`);
  }
  if (pollMs !== undefined) checkInt(pollMs, 'projection: pollMs');
  if (batchSize !== undefined) checkInt(batchSize, 'projection: batchSize');
  if (timeoutMs !== undefined) checkInt(timeoutMs, 'projection: timeoutMs');
}

function hasStores(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { journal, offsets } = value as Record<string, unknown>;
  return hasMethods(journal, ['readByTag']) && hasMethods(offsets, ['load', 'save']);
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return names.every((n) => typeof v[n] === 'function');
}
