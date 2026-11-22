// Shared by every backend, never exported from an entry point: the argument checks and the clock
// wrapper, so the in-memory, SQLite and Postgres backends reject exactly the same calls.
import { checkInt, describe } from '../checks.js';
import { jsonProblem } from './json.js';
import type { NewEvent, NewSnapshot } from './types.js';

/** An event checked and ready to store, with the event itself as JSON text. */
export interface SerializedEvent {
  readonly version: number;
  readonly tags: readonly string[];
  readonly json: string;
}

/** A snapshot checked and ready to store, with its state as JSON text. */
export interface SerializedSnapshot {
  readonly seq: number;
  readonly version: number;
  readonly json: string;
}

/**
 * Checks a backend's `clock` option, and returns a reader that rejects anything but integer ms.
 * `where` names the backend in error messages.
 */
export function wallClock(clock: unknown, where: string): () => number {
  if (typeof clock !== 'function') {
    throw new TypeError(`${where}: clock must be a function, got ${describe(clock)}`);
  }
  const read = clock as () => unknown;
  return () => {
    const time = read();
    checkInt(time, `${where}: clock()`, { min: 0 });
    return time as number;
  };
}

/** Throws unless `value` is a non-empty string: a persistence id, tag or projection name. */
export function checkId(value: unknown, what: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${what} must be a non-empty string, got ${describe(value)}`);
  }
}

/** Checks `append`'s arguments and serializes the batch, before anything touches the stream. */
export function checkAppend(
  persistenceId: unknown,
  expectedSeq: unknown,
  events: unknown,
): SerializedEvent[] {
  checkId(persistenceId, 'append: persistenceId');
  checkInt(expectedSeq, 'append: expectedSeq', { min: 0 });
  if (!Array.isArray(events)) throw new TypeError('append: events must be an array');
  return events.map((event: unknown, i) => serializeEvent(event, i));
}

/** Checks `read`'s arguments. */
export function checkRead(persistenceId: unknown, fromSeq: unknown, limit: unknown): void {
  checkId(persistenceId, 'read: persistenceId');
  checkInt(fromSeq, 'read: fromSeq');
  checkInt(limit, 'read: limit');
}

/** Checks `readByTag`'s arguments. */
export function checkReadByTag(tag: unknown, afterOffset: unknown, limit: unknown): void {
  checkId(tag, 'readByTag: tag');
  checkInt(afterOffset, 'readByTag: afterOffset', { min: 0 });
  checkInt(limit, 'readByTag: limit');
}

/** Checks an offset store `save`'s arguments. */
export function checkOffsetSave(name: unknown, offset: unknown): void {
  checkId(name, 'offsets.save: name');
  checkInt(offset, 'offsets.save: offset', { min: 0 });
}

function serializeEvent(value: unknown, index: number): SerializedEvent {
  const where = `append: events[${String(index)}]`;
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${where} must be an object`);
  }
  const { event, version, tags } = value as Partial<NewEvent>;
  checkInt(version, `${where}.version`);
  if (!Array.isArray(tags)) throw new TypeError(`${where}.tags must be an array`);
  const seen = new Set<string>();
  for (const tag of tags as readonly unknown[]) {
    checkId(tag, `${where}.tags[]`);
    if (seen.has(tag as string)) throw new TypeError(`${where}.tags repeats "${tag as string}"`);
    seen.add(tag as string);
  }
  const problem = jsonProblem(event);
  if (problem !== undefined) throw new TypeError(`${where}.event is not JSON: ${problem}`);
  return { version: version as number, tags: [...seen], json: JSON.stringify(event) };
}

/** Checks a snapshot store `save`'s arguments and serializes the state. */
export function serializeSnapshot(persistenceId: unknown, value: unknown): SerializedSnapshot {
  checkId(persistenceId, 'snapshots.save: persistenceId');
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('snapshots.save: snapshot must be an object');
  }
  const { seq, version, state } = value as Partial<NewSnapshot>;
  checkInt(seq, 'snapshots.save: seq');
  checkInt(version, 'snapshots.save: version');
  const problem = jsonProblem(state);
  if (problem !== undefined) throw new TypeError(`snapshots.save: state is not JSON: ${problem}`);
  return { seq: seq as number, version: version as number, json: JSON.stringify(state) };
}
