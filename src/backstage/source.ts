// The in-process source: Backstage attached to a system in the same runtime. It subscribes with
// message events on, encodes each event once as it happens (a message may change afterwards), and
// keeps a ring of lifecycle events so a page opened after a crash still shows it (decision 0021).

import { checkInt, checkKeys } from '../checks.js';
import {
  inspectSystem,
  type CellInspection,
  type ClusterInspection,
  type SystemInspection,
} from '../internal.js';
import type { ActorSystem, SystemEvent } from '../types.js';
import { encode } from './encode.js';
import { answer, failure } from './requests.js';
import {
  PROTOCOL,
  type ActorInfo,
  type BackstageOptions,
  type BackstageRequest,
  type BackstageResponse,
  type BackstageSource,
  type ClusterInfo,
  type Frame,
  type WireEvent,
} from './types.js';

const OPTIONS = new Set(['history']);
const DEFAULT_HISTORY = 500;

/** The events a new connection's history keeps. Message events aren't: the UI keeps its own. */
const LIFECYCLE: ReadonlySet<SystemEvent['type']> = new Set([
  'spawned',
  'stopped',
  'failed',
  'restarted',
  'persisted',
  'recovered',
  'deadLetter',
  'memberUp',
  'memberLeaving',
  'memberDown',
  'memberRemoved',
  'reachability',
  'shardAcquired',
  'shardReleased',
]);

type Listener = (frame: Frame) => void;

/**
 * Attaches an inspector to a system. Runs in any runtime. It subscribes with `{ messages: true }`,
 * so message events are on until {@link BackstageSource.close}. Backstage only watches: nothing it
 * offers changes the system (decision 0021).
 * @throws TypeError unless `system` was made by `createActorSystem`, and `opts.history` is a
 * non-negative integer.
 */
export function backstage(system: ActorSystem, opts?: BackstageOptions): BackstageSource {
  const limit = checkOptions(opts);
  const inspection = inspectSystem(system);
  const history = new Ring<WireEvent>(limit);
  // Copy on write, so a listener that disconnects during delivery doesn't skip its neighbour.
  let listeners: readonly Listener[] = [];
  let closed = false;

  const deliver = (frame: Frame, to: readonly Listener[]): void => {
    for (const listener of to) {
      try {
        listener(frame);
      } catch (error) {
        inspection.log.error('a Backstage connection threw; skipped it', { error });
      }
    }
  };

  // The cluster view, sent as a `cluster` frame once the changes of one turn have settled, and
  // only when it differs from the last one sent: a region relearning the same holders sends none.
  let lastCluster: string | undefined;
  let flushQueued = false;
  const flush = (): void => {
    flushQueued = false;
    if (closed) return;
    const view = inspection.cluster();
    if (view === undefined) return;
    const cluster = clusterInfo(view);
    const text = JSON.stringify(cluster);
    if (text === lastCluster) return;
    lastCluster = text;
    deliver({ type: 'cluster', cluster }, listeners);
  };
  const stopClusterChanges = inspection.onClusterChange(() => {
    if (flushQueued || listeners.length === 0) return;
    flushQueued = true;
    queueMicrotask(flush);
  });

  const unsubscribe = system.events.subscribe(
    (event) => {
      const lifecycle = LIFECYCLE.has(event.type);
      // Nobody connected and nothing to keep: skip the encoding.
      if (!lifecycle && listeners.length === 0) return;
      const wire = encodeEvent(event);
      if (lifecycle) history.push(wire);
      deliver({ type: 'event', event: wire }, listeners);
    },
    { messages: true },
  );

  return Object.freeze({
    connect(listener: Listener): () => void {
      if (typeof listener !== 'function') {
        throw new TypeError('backstage.connect: listener must be a function');
      }
      if (closed) throw new Error('backstage.connect: the source is closed');
      listeners = [...listeners, listener];
      const hello: Frame = {
        type: 'hello',
        protocol: PROTOCOL,
        system: system.name,
        now: inspection.scheduler.now(),
        actors: inspection.walk().map(actorInfo),
        history: history.items(),
        cluster: currentCluster(inspection),
      };
      // With nobody connected, changes weren't followed, so this hello is now the last view sent.
      // With others connected, any change since their last view has a flush queued, which sends
      // everyone the same view, this one included.
      if (hello.cluster !== null && listeners.length === 1) {
        lastCluster = JSON.stringify(hello.cluster);
      }
      deliver(hello, [listener]);
      let connected = true;
      return () => {
        if (!connected) return;
        connected = false;
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    request(req: BackstageRequest): Promise<BackstageResponse> {
      if (closed) {
        const error = new Error('the source is closed');
        error.name = 'ClosedError';
        return Promise.resolve(failure(error));
      }
      return answer(inspection, req);
    },
    close(): void {
      if (closed) return;
      closed = true;
      listeners = [];
      unsubscribe();
      stopClusterChanges();
    },
  });
}

function checkOptions(opts: unknown): number {
  if (opts === undefined) return DEFAULT_HISTORY;
  checkKeys(opts, OPTIONS, 'backstage');
  const { history = DEFAULT_HISTORY } = opts as { history?: unknown };
  checkInt(history, 'backstage: history', { min: 0 });
  return history as number;
}

function currentCluster(inspection: SystemInspection): ClusterInfo | null {
  const view = inspection.cluster();
  return view === undefined ? null : clusterInfo(view);
}

/** The view, copied into plain frames, so a later change can't reach a frame already sent. */
function clusterInfo(view: ClusterInspection): ClusterInfo {
  return {
    address: view.address,
    uid: view.uid,
    members: view.members().map(({ address, uid, status, reachable }) => ({
      address,
      uid,
      status,
      reachable,
    })),
    types: view.entityTypes().map(({ type, shardCount, host, owners }) => ({
      type,
      shardCount,
      host,
      shards: owners.map(([shard, owner]) => ({ shard, owner })),
    })),
  };
}

function actorInfo(cell: CellInspection): ActorInfo {
  const { path, status, depth, persistent } = cell;
  return persistent === undefined
    ? { path, status, depth }
    : { path, status, depth, persistenceId: persistent.persistenceId };
}

/**
 * Encodes each field on its own, so a message gets the full depth limit. `undefined` fields are
 * left out, as JSON would.
 */
function encodeEvent(event: SystemEvent): WireEvent {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value !== undefined) out[key] = encode(value);
  }
  return out as WireEvent;
}

/** The last `capacity` items pushed, oldest first. */
class Ring<T> {
  readonly #items: T[] = [];
  readonly #capacity: number;
  #start = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(item: T): void {
    if (this.#capacity === 0) return;
    if (this.#items.length < this.#capacity) {
      this.#items.push(item);
      return;
    }
    this.#items[this.#start] = item;
    this.#start = (this.#start + 1) % this.#capacity;
  }

  items(): T[] {
    return [...this.#items.slice(this.#start), ...this.#items.slice(0, this.#start)];
  }
}
