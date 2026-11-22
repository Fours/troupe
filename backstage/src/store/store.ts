// The Backstage store: frames in, a view model out, with no React and no clock of its own. Time is
// the `at` of the events it has seen, so a paused system freezes the view too, and the same frames
// always give the same view model. Frames are applied as they arrive, which can be hundreds per
// animation frame during a rush, so `apply` only updates mutable records and marks what changed.
// `view()` builds immutable objects for the changed actors only, so the UI can skip the rest.

import type { ActorStatus, Frame, WireEvent, WireValue } from '@kylewillett/troupe/backstage';

/** How long an actor stays in the tree after it stops, so it fades out rather than vanishing. */
export const FADE_MS = 1_500;

/** How many messages the store keeps per actor. */
export const MESSAGES_PER_ACTOR = 200;

/** How much mailbox-depth history the store keeps per actor, in ms. */
export const DEPTH_WINDOW_MS = 60_000;

/** How many depth samples one actor keeps at most, however close together they come. */
export const DEPTH_SAMPLES = 2_000;

/** How many failures one actor keeps. */
export const FAILURES_PER_ACTOR = 50;

/** How long a message-flow link stays in the view, in ms of system time. */
export const FLOW_MS = 600;

/** How many message-flow links the view holds at most. */
export const FLOWS = 64;

/** How many messages can be waiting for their end before the oldest is given up on. */
export const PENDING = 5_000;

/** Where an actor is in its life, or `stopped` while it fades out. */
export type ActorPhase = ActorStatus | 'stopped';

/** How a message ended, or `waiting` while it's in the mailbox or being handled. */
export type MessageOutcome = 'waiting' | 'processed' | 'failed' | 'skipped' | 'dropped';

/** One message to one actor, from its `delivered` to the event that ended it. */
export interface MessageView {
  readonly id: number;
  /** The sender's path, when the system knew it. */
  readonly from?: string;
  readonly message: WireValue;
  /** When it went into the mailbox. */
  readonly deliveredAt: number;
  /** How the mailbox stood once it was in. */
  readonly depth: number;
  readonly outcome: MessageOutcome;
  /** How long it waited in the mailbox before it was taken, once it has been. */
  readonly waitedMs?: number;
  /** How long its handler took, once it has finished. */
  readonly handledMs?: number;
  /** Why a dropped message was dropped: the `deadLetter`'s reason. */
  readonly reason?: string;
}

/** One failure of one actor, and the restart that followed, once it has. */
export interface FailureView {
  readonly at: number;
  readonly error: WireValue;
  readonly directive: 'stop' | 'resume' | 'restart';
  readonly restart?: { readonly at: number; readonly attempt: number; readonly delayMs: number };
}

/**
 * A mailbox's size at one ms. Under virtual time a message can arrive and be handled in the same
 * ms, so `peak` keeps the most it held during that ms, and `depth` how it was left.
 */
export interface DepthSample {
  readonly at: number;
  readonly depth: number;
  readonly peak: number;
}

/** One actor, as the UI shows it. A new object whenever anything in it changes. */
export interface ActorView {
  readonly path: string;
  /** The last part of its path. */
  readonly name: string;
  /** Its parent's path, or `undefined` for a child of `/user`. */
  readonly parent?: string;
  /** How deep it is under `/user`: 0 for a child of `/user`. */
  readonly level: number;
  readonly phase: ActorPhase;
  /** How many messages wait in its mailbox. */
  readonly depth: number;
  /** The most its mailbox has held in the store's depth window. */
  readonly peakDepth: number;
  /** Present for a persistent actor, once the store knows it is one. */
  readonly persistenceId?: string;
  /** Its journal's last sequence number, as far as the store has seen. */
  readonly lastSeq: number;
  /** When it stopped, while it fades out. */
  readonly stoppedAt?: number;
  /** Goes up whenever its state may have changed, so the UI knows to ask for it again. */
  readonly stateVersion: number;
  /** Its recent messages, oldest first, at most {@link MESSAGES_PER_ACTOR}. */
  readonly messages: readonly MessageView[];
  /** Its mailbox depth over the last {@link DEPTH_WINDOW_MS}, oldest first. */
  readonly depths: readonly DepthSample[];
  /** Its failures, oldest first, at most {@link FAILURES_PER_ACTOR}. */
  readonly failures: readonly FailureView[];
}

/** A message whose sender is known, for the tree's message-flow links. */
export interface FlowView {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly at: number;
}

/** Counts across the whole system since the last `hello`, not counting its history. */
export interface Totals {
  readonly delivered: number;
  readonly processed: number;
  readonly failures: number;
  readonly restarts: number;
  /** Dead letters of every kind, drained messages included. */
  readonly deadLetters: number;
}

/** Everything the UI draws. Unchanged parts keep their identity from one view to the next. */
export interface ViewModel {
  /** Whether a `hello` has arrived. */
  readonly connected: boolean;
  /** The system's name. */
  readonly system: string;
  /** How many `hello`s have arrived: each one is a new connection, or a new system. */
  readonly connection: number;
  /** The system's time, as far as the frames have told it. */
  readonly now: number;
  /** Every actor under `/user`, each parent before its children, in spawn order. */
  readonly actors: readonly ActorView[];
  /** Links for messages sent in the last {@link FLOW_MS}, oldest first. */
  readonly flows: readonly FlowView[];
  readonly totals: Totals;
}

/** The store: apply each frame as it comes, and read the view at most once per animation frame. */
export interface BackstageStore {
  apply(frame: Frame): void;
  /** The current view. The same object until another frame changes something. */
  view(): ViewModel;
}

const USER = '/user';

interface ActorRecord {
  readonly path: string;
  readonly name: string;
  readonly parent: string | undefined;
  readonly level: number;
  phase: ActorPhase;
  depth: number;
  persistenceId: string | undefined;
  lastSeq: number;
  stoppedAt: number | undefined;
  stateVersion: number;
  readonly messages: MessageView[];
  readonly depths: DepthSample[];
  readonly failures: FailureView[];
  readonly children: string[];
  view: ActorView | undefined;
}

interface Pending {
  readonly record: ActorRecord;
  entry: MessageView;
}

/** Creates an empty store, which shows nothing until a `hello`. */
export function createStore(): BackstageStore {
  let connected = false;
  let system = '';
  let connection = 0;
  let now = 0;
  let actors = new Map<string, ActorRecord>();
  let roots: string[] = [];
  let pending = new Map<number, Pending>();
  let flows: FlowView[] = [];
  let totals = zeroTotals();
  // What the next view must rebuild. Any change at all invalidates the cached view.
  const dirty = new Set<ActorRecord>();
  let treeChanged = true;
  let cached: ViewModel | undefined;

  const touch = (record: ActorRecord): void => {
    dirty.add(record);
    cached = undefined;
  };

  const parentOf = (path: string): string | undefined => {
    const cut = path.lastIndexOf('/');
    const parent = path.slice(0, cut);
    return parent === USER ? undefined : parent;
  };

  const add = (path: string, phase: ActorPhase, depth: number): ActorRecord => {
    const parent = parentOf(path);
    const record: ActorRecord = {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      parent,
      level: path.split('/').length - 3,
      phase,
      depth,
      persistenceId: undefined,
      lastSeq: 0,
      stoppedAt: undefined,
      stateVersion: 0,
      messages: [],
      depths: [],
      failures: [],
      children: [],
      view: undefined,
    };
    actors.set(path, record);
    const siblings = parent === undefined ? roots : actors.get(parent)?.children;
    // A child whose parent the store never saw is shown at the top, rather than lost.
    (siblings ?? roots).push(path);
    treeChanged = true;
    touch(record);
    return record;
  };

  const remove = (record: ActorRecord): void => {
    for (const child of [...record.children]) {
      const childRecord = actors.get(child);
      if (childRecord !== undefined) remove(childRecord);
    }
    actors.delete(record.path);
    const parent = record.parent === undefined ? undefined : actors.get(record.parent);
    const siblings = parent?.children ?? roots;
    const index = siblings.indexOf(record.path);
    if (index >= 0) siblings.splice(index, 1);
    for (const [id, waiting] of pending) if (waiting.record === record) pending.delete(id);
    dirty.delete(record);
    treeChanged = true;
    cached = undefined;
  };

  const sample = (record: ActorRecord, at: number, depth: number): void => {
    record.depth = depth;
    const { depths } = record;
    const last = depths[depths.length - 1];
    // One sample per ms is all a 30 s chart can show, but it keeps that ms's peak.
    if (last?.at === at)
      depths[depths.length - 1] = { at, depth, peak: Math.max(last.peak, depth) };
    else depths.push({ at, depth, peak: depth });
    if (depths.length > DEPTH_SAMPLES) depths.splice(0, depths.length - DEPTH_SAMPLES);
    touch(record);
  };

  const end = (id: number, update: (entry: MessageView) => MessageView): void => {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    const { record, entry } = waiting;
    const next = update(entry);
    // Usually the newest few, so searching from the end is quick. Gone if the ring dropped it.
    const index = record.messages.lastIndexOf(entry);
    if (index >= 0) record.messages[index] = next;
    touch(record);
  };

  const hello = (frame: Extract<Frame, { type: 'hello' }>): void => {
    connected = true;
    system = frame.system;
    connection++;
    now = frame.now;
    actors = new Map();
    roots = [];
    pending = new Map();
    flows = [];
    totals = zeroTotals();
    dirty.clear();
    treeChanged = true;
    cached = undefined;
    for (const info of frame.actors) {
      if (!info.path.startsWith(`${USER}/`)) continue;
      const record = add(info.path, info.status, info.depth);
      record.persistenceId = info.persistenceId;
      record.depths.push({ at: frame.now, depth: info.depth, peak: info.depth });
    }
    // The history tells of failures, restarts and writes before this connection, but the actors
    // above already say where each one is now, so it changes nothing else.
    for (const event of frame.history) remember(event);
  };

  /** What a history event tells about a live actor's past. */
  const remember = (event: WireEvent): void => {
    switch (event.type) {
      case 'failed':
      case 'restarted':
        noteFailure(event, false);
        return;
      case 'persisted':
      case 'recovered': {
        const actor = actors.get(event.path);
        if (actor === undefined) return;
        actor.persistenceId = event.persistenceId;
        actor.lastSeq = Math.max(
          actor.lastSeq,
          event.type === 'persisted' ? event.toSeq : event.lastSeq,
        );
        touch(actor);
        return;
      }
      default:
        return;
    }
  };

  /** Records a failure or a restart, and, when `live`, what it does to the actor's phase. */
  const noteFailure = (
    event: Extract<WireEvent, { type: 'failed' | 'restarted' }>,
    live: boolean,
  ) => {
    const actor = actors.get(event.path);
    if (actor === undefined) return;
    if (event.type === 'failed') {
      actor.failures.push({ at: event.at, error: event.error, directive: event.directive });
      if (actor.failures.length > FAILURES_PER_ACTOR) actor.failures.shift();
      // The message whose handler threw: its `processed` came just before this.
      const last = actor.messages[actor.messages.length - 1];
      if (live && last?.outcome === 'processed') {
        actor.messages[actor.messages.length - 1] = { ...last, outcome: 'failed' };
      }
      if (live && event.directive !== 'resume') {
        actor.phase = event.directive === 'restart' ? 'restarting' : 'stopping';
      }
      if (live) totals = { ...totals, failures: totals.failures + 1 };
    } else {
      const index = actor.failures.findLastIndex((f) => f.restart === undefined);
      const failure = actor.failures[index];
      if (failure !== undefined) {
        const restart = { at: event.at, attempt: event.attempt, delayMs: event.delayMs };
        actor.failures[index] = { ...failure, restart };
      }
      if (live) actor.phase = actor.persistenceId === undefined ? 'running' : 'starting';
      actor.stateVersion++;
      if (live) totals = { ...totals, restarts: totals.restarts + 1 };
    }
    touch(actor);
  };

  /**
   * A plain actor the hello listed as starting has no event to say it's running, so the first
   * thing it does says so. A persistent actor is running once it has recovered.
   */
  const started = (actor: ActorRecord): void => {
    if (actor.phase !== 'starting' || actor.persistenceId !== undefined) return;
    actor.phase = 'running';
    touch(actor);
  };

  const event = (e: WireEvent): void => {
    // Nothing to place an event in before the hello lists the actors.
    if (!connected) return;
    now = Math.max(now, e.at);
    cached = undefined;
    switch (e.type) {
      case 'spawned': {
        if (!e.path.startsWith(`${USER}/`)) return;
        const existing = actors.get(e.path);
        // A name used again while the last one with it fades out.
        if (existing !== undefined) remove(existing);
        add(e.path, 'running', 0).depths.push({ at: e.at, depth: 0, peak: 0 });
        // Children are spawned from a running handler, so the parent has started.
        const parent = actors.get(parentOf(e.path) ?? '');
        if (parent !== undefined) started(parent);
        return;
      }
      case 'stopped': {
        const actor = actors.get(e.path);
        if (actor === undefined) return;
        actor.phase = 'stopped';
        actor.stoppedAt = e.at;
        actor.depth = 0;
        touch(actor);
        return;
      }
      case 'failed':
      case 'restarted':
        noteFailure(e, true);
        return;
      case 'persisted':
      case 'recovered': {
        const actor = actors.get(e.path);
        if (actor === undefined) return;
        actor.persistenceId = e.persistenceId;
        actor.lastSeq = e.type === 'persisted' ? e.toSeq : e.lastSeq;
        if (e.type === 'recovered') actor.phase = 'running';
        actor.stateVersion++;
        touch(actor);
        return;
      }
      case 'delivered': {
        totals = { ...totals, delivered: totals.delivered + 1 };
        if (e.from !== undefined && actors.has(e.from) && actors.has(e.path)) {
          flows.push({ id: e.id, from: e.from, to: e.path, at: e.at });
          if (flows.length > FLOWS) flows.shift();
        }
        const actor = actors.get(e.path);
        if (actor === undefined) return;
        const entry: MessageView = {
          id: e.id,
          ...(e.from === undefined ? {} : { from: e.from }),
          message: e.message,
          deliveredAt: e.at,
          depth: e.depth,
          outcome: 'waiting',
        };
        actor.messages.push(entry);
        if (actor.messages.length > MESSAGES_PER_ACTOR) actor.messages.shift();
        pending.set(e.id, { record: actor, entry });
        if (pending.size > PENDING) {
          // A message whose end never came, such as one the source lost. Given up on.
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) pending.delete(oldest);
        }
        sample(actor, e.at, e.depth);
        return;
      }
      case 'processed': {
        totals = { ...totals, processed: totals.processed + 1 };
        const actor = actors.get(e.path);
        if (actor !== undefined) {
          sample(actor, e.at, e.depth);
          if (e.stateChanged) actor.stateVersion++;
          // It has handled a message, so it has started.
          started(actor);
        }
        end(e.id, (entry) => {
          const handledMs = e.durationMs;
          const waitedMs = Math.max(0, e.at - handledMs - entry.deliveredAt);
          return {
            ...entry,
            outcome: e.skipped === true ? 'skipped' : 'processed',
            waitedMs,
            handledMs,
          };
        });
        return;
      }
      case 'deadLetter': {
        totals = { ...totals, deadLetters: totals.deadLetters + 1 };
        if (e.id !== undefined)
          end(e.id, (entry) => ({ ...entry, outcome: 'dropped', reason: e.reason }));
        return;
      }
    }
  };

  const prune = (): void => {
    for (const actor of [...actors.values()]) {
      if (actor.stoppedAt !== undefined && now - actor.stoppedAt >= FADE_MS) remove(actor);
    }
    const flowCut = now - FLOW_MS;
    if (flows.length > 0 && (flows[0]?.at ?? now) < flowCut) {
      flows = flows.filter((f) => f.at >= flowCut);
    }
  };

  const build = (actor: ActorRecord): ActorView => {
    const cut = now - DEPTH_WINDOW_MS;
    const { depths } = actor;
    let first = 0;
    while (first < depths.length - 1 && (depths[first + 1]?.at ?? now) <= cut) first++;
    if (first > 0) depths.splice(0, first);
    let peakDepth = 0;
    for (const s of depths) if (s.peak > peakDepth) peakDepth = s.peak;
    return {
      path: actor.path,
      name: actor.name,
      ...(actor.parent === undefined ? {} : { parent: actor.parent }),
      level: actor.level,
      phase: actor.phase,
      depth: actor.depth,
      peakDepth,
      ...(actor.persistenceId === undefined ? {} : { persistenceId: actor.persistenceId }),
      lastSeq: actor.lastSeq,
      ...(actor.stoppedAt === undefined ? {} : { stoppedAt: actor.stoppedAt }),
      stateVersion: actor.stateVersion,
      messages: [...actor.messages],
      depths: [...depths],
      failures: [...actor.failures],
    };
  };

  let lastActors: readonly ActorView[] = [];

  return {
    apply(frame) {
      if (frame.type === 'hello') hello(frame);
      else event(frame.event);
    },
    view() {
      if (cached !== undefined) return cached;
      prune();
      const changed = treeChanged || dirty.size > 0;
      for (const actor of dirty) actor.view = build(actor);
      dirty.clear();
      if (changed) {
        const ordered: ActorView[] = [];
        const visit = (path: string): void => {
          const actor = actors.get(path);
          if (actor === undefined) return;
          actor.view ??= build(actor);
          ordered.push(actor.view);
          for (const child of actor.children) visit(child);
        };
        for (const root of roots) visit(root);
        lastActors = ordered;
        treeChanged = false;
      }
      cached = {
        connected,
        system,
        connection,
        now,
        actors: lastActors,
        flows: [...flows],
        totals,
      };
      return cached;
    },
  };
}

function zeroTotals(): Totals {
  return { delivered: 0, processed: 0, failures: 0, restarts: 0, deadLetters: 0 };
}
