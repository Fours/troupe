// A run's history (milestone 5, T5): everything the run did, as JSON, in simulation time. It's the
// only input to the invariants, which never look at the live system, and it's what a failure
// prints and a replay reproduces byte for byte. Every entry's `time` is simulation time, so entries
// from different nodes compare. An event keeps its own `at` too, its node's reading, which drifts.

import type { JsonValue } from '../json.js';
import type { NetworkMode } from './network.js';
import type { Fault, FaultPlan } from './plan.js';

/** The run as it began: what it was, and its plan. Always the history's first entry. */
export interface RunEntry {
  readonly kind: 'run';
  readonly time: number;
  readonly seed: number;
  readonly mode: NetworkMode;
  /** Hosts started at once, then spares, then clients. */
  readonly nodes: readonly string[];
  readonly spares: readonly string[];
  readonly clients: readonly string[];
  readonly durationMs: number;
  /** When the quiet tail began. */
  readonly quietFrom: number;
  /** The cluster's lease timings. */
  readonly leases: { readonly ttlMs: number; readonly renewMs: number; readonly marginMs: number };
  readonly plan: FaultPlan;
  /** Where the run was cut short, if it was: it ended here, not at `durationMs`. */
  readonly untilMs?: number;
}

/** A node incarnation started: `inc` counts its node's incarnations from 0, `uid` is its own. */
export interface StartEntry {
  readonly kind: 'start';
  readonly time: number;
  readonly node: string;
  readonly inc: number;
  readonly uid: number;
  /** Its clock's drift as it started, drawn from its own stream. */
  readonly driftPpm: number;
}

/**
 * A node incarnation's process ended: `killed` by a fault, or `exited` once it had left the
 * cluster, gracefully or because it was downed. A restart is a new incarnation.
 */
export interface StopEntry {
  readonly kind: 'stop';
  readonly time: number;
  readonly node: string;
  readonly inc: number;
  readonly why: 'killed' | 'exited';
}

/**
 * A system event from one node incarnation, as JSON: refs as `ref <address>#<uid><path>`, or
 * `ref /sharding/...` for an entity, and errors as `{ error, message }`. Message events are kept
 * only for entities.
 */
export interface EventEntry {
  readonly kind: 'event';
  readonly time: number;
  readonly node: string;
  readonly inc: number;
  readonly event: { readonly type: string; readonly at: number } & Readonly<
    Record<string, JsonValue>
  >;
}

/** A fault began or ended. `index` is its place in the plan. */
export interface FaultEntry {
  readonly kind: 'fault';
  readonly time: number;
  readonly index: number;
  readonly phase: 'begin' | 'end';
  readonly fault: Fault;
}

/** A client began an operation on an entity. */
export interface InvokeEntry {
  readonly kind: 'invoke';
  readonly time: number;
  /** The operation's number in the run, from 0. */
  readonly op: number;
  readonly client: string;
  /** Its name, such as `buy`. */
  readonly name: string;
  readonly entity: { readonly type: string; readonly id: string };
}

/** A message an operation sent to its entity, in the order it sent them. */
export interface SendEntry {
  readonly kind: 'send';
  readonly time: number;
  readonly op: number;
  readonly client: string;
  readonly message: JsonValue;
}

/**
 * An operation ended: `ok` with its reply, `failed` with an error, or `unknown`, when it timed
 * out and its effect may or may not have happened.
 */
export interface CompleteEntry {
  readonly kind: 'complete';
  readonly time: number;
  readonly op: number;
  readonly outcome: 'ok' | 'failed' | 'unknown';
  readonly reply?: JsonValue;
  readonly error?: string;
}

/** A journal append or lease call, once its caller had its answer or never would. */
export interface DatabaseEntry {
  readonly kind: 'db';
  readonly time: number;
  readonly node: string;
  readonly op: string;
  readonly target: string;
  readonly applied: boolean;
  readonly ok: boolean;
  readonly reply: 'delivered' | 'lost' | 'disconnected' | 'closed';
}

/** One stored event, as the journal held it when the run ended. */
export interface JournalEvent {
  readonly persistenceId: string;
  readonly seq: number;
  readonly event: JsonValue;
}

/** The journal as the run ended: every stored event, in offset order. */
export interface JournalEntry {
  readonly kind: 'journal';
  readonly time: number;
  readonly events: readonly JournalEvent[];
}

/** One entry in a run's history. */
export type HistoryEntry =
  | RunEntry
  | StartEntry
  | StopEntry
  | EventEntry
  | FaultEntry
  | InvokeEntry
  | SendEntry
  | CompleteEntry
  | DatabaseEntry
  | JournalEntry;

/** A run's history: its entries, in the order they happened. Plain JSON. */
export type History = readonly HistoryEntry[];

const ENTITY = /^\/system\/sharding\/([^/]+)\/(\d+)\/([^/]+)$/;

/** An entity's place, read from its actor's path: its type, shard and id. */
export interface EntityPath {
  readonly type: string;
  readonly shard: number;
  readonly id: string;
}

/** The entity an actor path is, or `undefined` for any other actor. */
export function entityOf(path: string): EntityPath | undefined {
  const m = ENTITY.exec(path);
  if (m === null) return undefined;
  return { type: m[1] as string, shard: Number(m[2]), id: m[3] as string };
}

/** A JSON value from an event, as text: a string as it is, anything else as its JSON. */
export function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** The history's `run` entry. */
export function runOf(history: History): RunEntry {
  const first = history[0];
  if (first?.kind !== 'run') throw new TypeError('a history starts with its run entry');
  return first;
}

const MAX_DEPTH = 32;

/**
 * `value` as JSON, for a history. A ref becomes `ref <where>`: an entity's as its location-free
 * path, a remote actor's as its address, uid and path, and a local one's with `self`, this node's
 * `<address>#<uid>`, before its path, so a ref reads the same on every node. An error becomes
 * `{ error, message }`. Anything else JSON can't hold becomes a string saying what it was.
 */
export function toJson(value: unknown, self: string, depth = 0): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return `<${typeof value}>`;
  if (depth >= MAX_DEPTH) return '<deep>';
  if (isRef(value)) return `ref ${refPlace(value.path, self)}`;
  if (value instanceof Error) return { error: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v: unknown) => toJson(v, self, depth + 1));
  const out: Record<string, JsonValue> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || typeof v === 'function') continue;
    out[key] = toJson(v, self, depth + 1);
  }
  return out;
}

function isRef(value: object): value is { readonly path: string } {
  return (
    'tell' in value &&
    typeof value.tell === 'function' &&
    typeof (value as { readonly path?: unknown }).path === 'string'
  );
}

/** Where a ref points, the same from every node. */
export function refPlace(path: string, self: string): string {
  if (path.startsWith('/sharding/')) return path;
  if (path.startsWith('troupe://')) {
    const at = path.indexOf('@');
    return at === -1 ? path : path.slice(at + 1);
  }
  return `${self}${path}`;
}
