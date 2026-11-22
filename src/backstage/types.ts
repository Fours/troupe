// The Backstage protocol (decision 0021): JSON frames from a source to an inspector, and read-only
// requests back. Refs travel as paths, so milestone 4 can send all of it from another node.

import type { SystemEvent } from '../types.js';
import type { WireValue } from './encode.js';

/** Options for {@link backstage}. */
export interface BackstageOptions {
  /** How many lifecycle events to keep for a new connection's history. Default 500. */
  history?: number;
}

/** An inspector's view of one system: a stream of frames, and requests that only read. */
export interface BackstageSource {
  /**
   * Calls `listener` with a `hello` frame at once, then an `event` frame for every event. Every
   * connection gets the same frame objects, so don't change them. A listener that throws is
   * logged to the system's logger and skipped.
   * @returns A function that ends the connection.
   * @throws TypeError unless `listener` is a function.
   * @throws Error once the source is closed.
   */
  connect(listener: (frame: Frame) => void): () => void;
  /**
   * Answers one request. Read-only: nothing it does changes the system. Never rejects: a request
   * that can't be answered gets an error response.
   */
  request(req: BackstageRequest): Promise<BackstageResponse>;
  /** Unsubscribes from the system, which turns message events off unless something else wants them. Every connection ends. */
  close(): void;
}

/** Where an actor is in its life. `starting` covers a persistent actor's recovery. */
export type ActorStatus = 'starting' | 'running' | 'restarting' | 'stopping';

/** One live actor, as a `hello` lists it. Its state is a `state` request away. */
export interface ActorInfo {
  /** Its path, such as `/user/box-office/hamlet`. */
  readonly path: string;
  /** Where it is in its life. */
  readonly status: ActorStatus;
  /** How many messages wait in its mailbox. */
  readonly depth: number;
  /** Its persistence id, when it's a persistent actor, which `timeline` and `stateAt` need. */
  readonly persistenceId?: string;
}

type Wire<E> = E extends unknown
  ? { readonly [K in keyof E]: unknown extends E[K] ? WireValue : E[K] }
  : never;

/** A {@link SystemEvent} with what it carries (messages, errors) encoded as {@link WireValue}s. */
export type WireEvent = Wire<SystemEvent>;

/** What a source sends a connection. */
export type Frame =
  | {
      readonly type: 'hello';
      /** The protocol's version. */
      readonly protocol: 1;
      /** The system's name. */
      readonly system: string;
      /** The system scheduler's time when the frame was made. */
      readonly now: number;
      /** Every live actor under `/user`, each parent before its children. */
      readonly actors: readonly ActorInfo[];
      /** Lifecycle events since the source attached, oldest first, at most `history`. */
      readonly history: readonly WireEvent[];
    }
  | { readonly type: 'event'; readonly event: WireEvent };

/** A question for a source. None of them changes anything. */
export type BackstageRequest =
  /** An actor's current state. */
  | { readonly type: 'state'; readonly path: string }
  /** A persistent actor's stored events from `fromSeq`, at most `limit`, up to 256. */
  | {
      readonly type: 'timeline';
      readonly path: string;
      readonly fromSeq: number;
      readonly limit: number;
    }
  /** A persistent actor's state after event `seq`, read from its journal. */
  | { readonly type: 'stateAt'; readonly path: string; readonly seq: number };

/** One event of a persistent actor's journal, as a `timeline` response gives it. */
export interface TimelineEvent {
  /** Its place in the stream: 1, 2, 3, ... */
  readonly seq: number;
  /** Its place in the whole journal. */
  readonly offset: number;
  /** The event as stored, before any upcasting, encoded. */
  readonly event: WireValue;
  /** Its schema version as stored. */
  readonly version: number;
  /** Its tags. */
  readonly tags: readonly string[];
  /** The backend's wall-clock ms when it was appended. For people, never for ordering. */
  readonly timestamp: number;
}

/** Why a request got no answer. */
export interface BackstageError {
  /**
   * `TypeError` for a request that isn't one, `RangeError` for a number out of range or a `seq`
   * past the end, `NotFoundError` for a path with no live actor, `NotPersistentError` for a
   * `timeline` or `stateAt` of a plain actor, `ClosedError` once the source is closed. Otherwise
   * the name of what the journal rejected with.
   */
  readonly name: string;
  /** What went wrong, for people. */
  readonly message: string;
}

/** A source's answer to a {@link BackstageRequest}. */
export type BackstageResponse =
  | {
      readonly ok: true;
      readonly type: 'state';
      readonly path: string;
      /** The state, encoded. A persistent actor's is its `{ seq, state }`. */
      readonly state: WireValue;
    }
  | {
      readonly ok: true;
      readonly type: 'timeline';
      readonly path: string;
      readonly persistenceId: string;
      readonly events: readonly TimelineEvent[];
      /** The stream's last sequence number when it was read, 0 for an empty one. */
      readonly lastSeq: number;
    }
  | {
      readonly ok: true;
      readonly type: 'stateAt';
      readonly path: string;
      readonly seq: number;
      /** The state after event `seq`, encoded. */
      readonly state: WireValue;
    }
  | { readonly ok: false; readonly error: BackstageError };
