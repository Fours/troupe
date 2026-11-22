// Answers Backstage's requests. Each reads either the live tree or the journal, never changes
// anything, and turns every failure into an error response (decision 0021). History comes from the
// journal, never from the live actor, so it reads the same for an entity on another node.

import { describe } from '../checks.js';
import type { PersistentHook, SystemInspection } from '../internal.js';
import type { StoredEvent } from '../persistence/types.js';
import { encode } from './encode.js';
import type { BackstageResponse, TimelineEvent } from './types.js';

/** The most events one `timeline` response holds, and the page size for finding the end. */
export const MAX_TIMELINE = 256;

/** A request that can't be answered, with the name its response carries. */
class RequestError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

const KEYS: Readonly<Record<string, readonly string[]>> = {
  state: ['type', 'path'],
  timeline: ['type', 'path', 'fromSeq', 'limit'],
  stateAt: ['type', 'path', 'seq'],
};

/** Answers `req` from `inspection`. Never rejects. */
export async function answer(
  inspection: SystemInspection,
  req: unknown,
): Promise<BackstageResponse> {
  try {
    return await dispatch(inspection, req);
  } catch (error) {
    return failure(error);
  }
}

/** An error response for `error`. */
export function failure(error: unknown): BackstageResponse {
  if (error instanceof Error) {
    // Either can be set to anything at runtime.
    const { name, message } = error as { name: unknown; message: unknown };
    return { ok: false, error: { name: String(name), message: String(message) } };
  }
  return { ok: false, error: { name: 'Error', message: describe(error) } };
}

async function dispatch(inspection: SystemInspection, req: unknown): Promise<BackstageResponse> {
  const { type, path } = checkRequest(req);
  switch (type) {
    case 'state': {
      return { ok: true, type, path, state: encode(cellAt(inspection, path).state) };
    }
    case 'timeline': {
      const { fromSeq, limit } = req as { fromSeq: unknown; limit: unknown };
      checkSeq(fromSeq, 'fromSeq', 1);
      checkSeq(limit, 'limit', 1);
      if (limit > MAX_TIMELINE) {
        throw new RangeError(
          `timeline: limit must be at most ${String(MAX_TIMELINE)}, got ${String(limit)}`,
        );
      }
      return timeline(path, persistentAt(inspection, path), fromSeq, limit);
    }
    case 'stateAt': {
      const { seq } = req as { seq: unknown };
      checkSeq(seq, 'seq', 0);
      const state = await persistentAt(inspection, path).stateAt(seq);
      return { ok: true, type, path, seq, state: encode(state) };
    }
  }
}

async function timeline(
  path: string,
  hook: PersistentHook,
  fromSeq: number,
  limit: number,
): Promise<BackstageResponse> {
  const { journal } = hook.persistence;
  const id = hook.persistenceId;
  const page = await journal.read(id, fromSeq, limit);
  const last = page.at(-1);
  let lastSeq: number;
  if (last === undefined) lastSeq = await lastSeqAfter(hook, 0);
  else lastSeq = page.length < limit ? last.seq : await lastSeqAfter(hook, last.seq);
  // One past the end is an empty page, so an inspector can ask for what comes next.
  if (fromSeq > lastSeq + 1) {
    throw new RangeError(
      `timeline: fromSeq ${String(fromSeq)} is past ${id}'s last event, ${String(lastSeq)}`,
    );
  }
  return { ok: true, type: 'timeline', path, persistenceId: id, events: page.map(toWire), lastSeq };
}

/** The stream's last sequence number, reading on from `after`, which is known to exist (or 0). */
async function lastSeqAfter(hook: PersistentHook, after: number): Promise<number> {
  let last = after;
  for (;;) {
    const page = await hook.persistence.journal.read(hook.persistenceId, last + 1, MAX_TIMELINE);
    const end = page.at(-1);
    if (end === undefined) return last;
    last = end.seq;
    if (page.length < MAX_TIMELINE) return last;
  }
}

function toWire(e: StoredEvent): TimelineEvent {
  return {
    seq: e.seq,
    offset: e.offset,
    event: encode(e.event),
    version: e.version,
    tags: [...e.tags],
    timestamp: e.timestamp,
  };
}

function cellAt(inspection: SystemInspection, path: string) {
  const cell = inspection.walk().find((c) => c.path === path);
  if (cell === undefined) throw new RequestError('NotFoundError', `no live actor at ${path}`);
  return cell;
}

function persistentAt(inspection: SystemInspection, path: string): PersistentHook {
  const hook = cellAt(inspection, path).persistent;
  if (hook === undefined) {
    throw new RequestError('NotPersistentError', `${path} is not a persistent actor`);
  }
  return hook;
}

function checkRequest(req: unknown): { type: 'state' | 'timeline' | 'stateAt'; path: string } {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new TypeError('a request must be an object');
  }
  const { type, path } = req as { type?: unknown; path?: unknown };
  const keys = typeof type === 'string' && Object.hasOwn(KEYS, type) ? KEYS[type] : undefined;
  if (keys === undefined) {
    throw new TypeError(
      `a request's type must be state, timeline or stateAt, got ${describe(type)}`,
    );
  }
  for (const key of Object.keys(req)) {
    if (!keys.includes(key)) throw new TypeError(`${String(type)}: unknown field "${key}"`);
  }
  if (typeof path !== 'string') {
    throw new TypeError(`${String(type)}: path must be a string, got ${describe(path)}`);
  }
  return { type: type as 'state' | 'timeline' | 'stateAt', path };
}

function checkSeq(value: unknown, what: string, min: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${what} must be an integer, got ${describe(value)}`);
  }
  if (value < min)
    throw new RangeError(`${what} must be at least ${String(min)}, got ${String(value)}`);
}
