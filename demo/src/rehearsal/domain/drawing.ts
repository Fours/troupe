// One rehearsed run, drawn (milestone 5, T8): its history turned into what the /rehearsal/ page
// draws. Simulation time runs across; each node gets a lane that says when it was up, paused,
// partitioned or down, with each show's instances as bars on the lane of the node they ran on;
// the database gets a lane for its faults; and a violation gets a mark at the moment it broke.
// No React and no clock: the page's worker draws live runs with it, and the site's build draws the
// recorded ones, so the page ships drawings, never the bugs that made them.
import type {
  Fault,
  History,
  HistoryEntry,
  RunEntry,
  Violation,
} from '@kylewillett/troupe/rehearsal';
import { narrate, type LogLine } from './narrate.ts';

/** What a node lane can show at a moment, the worst first. */
export type LaneState = 'down' | 'paused' | 'partitioned' | 'up';

/** A stretch of a lane in one state, from `from` up to `to`, in ms of simulation time. */
export interface Span {
  readonly from: number;
  readonly to: number;
  readonly state: LaneState;
}

/** A node's lane: its name, what it was, and its spans, in order, end to end. */
export interface Lane {
  readonly node: string;
  /** A host from the start, a spare that joins later, or a client that hosts no show. */
  readonly role: 'host' | 'spare' | 'client';
  readonly spans: readonly Span[];
}

/** One instance of a show: on `node`'s incarnation `inc`, live from `from` up to `to`. */
export interface Bar {
  readonly show: string;
  readonly node: string;
  readonly inc: number;
  readonly from: number;
  readonly to: number;
  /** Whether it's one the violation names. */
  readonly marked: boolean;
}

/** Where a fault is drawn: on node lanes, or the database's. */
export type FaultPlace = 'nodes' | 'database';

/** A fault, as the page draws it: when it held, where, and in plain words. */
export interface FaultBand {
  /** Its place in the plan. */
  readonly index: number;
  /** The plan's word for it, such as `kill` or `slow`. */
  readonly kind: string;
  readonly from: number;
  /** When it ended, the same as `from` for one that's over at once, such as a reset. */
  readonly to: number;
  readonly place: FaultPlace;
  /** The nodes it touched, by name; for the database, the one node it picked on, if any. */
  readonly nodes: readonly string[];
  readonly text: string;
}

/** The moment an invariant broke. */
export interface Mark {
  readonly invariant: string;
  /** The invariant's own message. */
  readonly message: string;
  /** What went wrong, in a sentence for anyone. */
  readonly sentence: string;
  readonly time: number;
  readonly until: number | undefined;
  /** The nodes involved, by name. */
  readonly nodes: readonly string[];
  /** The show involved, by id, if it was one show. */
  readonly show: string | undefined;
}

/** How the crowd's operations ended. */
export interface Outcomes {
  readonly ok: number;
  readonly failed: number;
  readonly unknown: number;
}

/** A run, ready to draw. Plain JSON, so a worker can post it and a build can inline it. */
export interface Drawing {
  readonly seed: number;
  readonly mode: string;
  /** Where the run ended: its duration, or where it was cut short. */
  readonly endMs: number;
  /** When the quiet tail, with no faults, began. */
  readonly quietFrom: number;
  /** The shows, in the order their first instance started. */
  readonly shows: readonly string[];
  readonly lanes: readonly Lane[];
  readonly bars: readonly Bar[];
  readonly faults: readonly FaultBand[];
  readonly mark: Mark | undefined;
  readonly log: readonly LogLine[];
  readonly outcomes: Outcomes;
}

const ENTITY_PATH = /^\/system\/sharding\/[^/]+\/\d+\/([^/]+)$/;

/** The show an actor path is an instance of, or `undefined` for any other actor. */
export function showOf(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  return ENTITY_PATH.exec(path)?.[1];
}

/** A value from an event, as text: a string or number as it is, anything else as its JSON. */
export function word(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value === undefined ? '' : JSON.stringify(value);
}

/** The node a violation's `<address>#<uid>` names. */
export const nodeName = (holder: string): string => holder.split('#')[0] ?? holder;

/** The events the drawing and its log read. Everything else in a history can be left out. */
const DRAWN_EVENTS = new Set([
  'spawned',
  'stopped',
  'shardAcquired',
  'shardReleased',
  'memberUp',
  'memberDown',
  'memberRemoved',
  'reachability',
  'recovered',
  'failed',
  'restarted',
]);

/**
 * Whether the drawing reads `entry`. A recorded history keeps only these, which is what lets the
 * page's data stay small: no journal, no database calls, no messages sent or delivered, and of the
 * spawns and stops only the shows'.
 */
export function isDrawn(entry: HistoryEntry): boolean {
  switch (entry.kind) {
    case 'run':
    case 'start':
    case 'stop':
    case 'fault':
    case 'invoke':
    case 'complete':
      return true;
    case 'event': {
      const { type } = entry.event;
      if (!DRAWN_EVENTS.has(type)) return false;
      if (type === 'spawned' || type === 'stopped') return showOf(entry.event.path) !== undefined;
      return true;
    }
    default:
      return false;
  }
}

/** `history` with only what the drawing reads, without each event's `seq`, which it never does. */
export function trim(history: History): History {
  return history.filter(isDrawn).map((e) => {
    if (e.kind !== 'event') return e;
    const event = Object.fromEntries(Object.entries(e.event).filter(([key]) => key !== 'seq'));
    return { ...e, event: event as typeof e.event };
  });
}

function runOf(history: History): RunEntry {
  const first = history[0];
  if (first?.kind !== 'run') throw new TypeError('a history starts with its run entry');
  return first;
}

/** The nodes a fault touched, by name. */
export function faultNodes(fault: Fault): string[] {
  if ('kill' in fault) return [fault.kill];
  if ('pause' in fault) return [fault.pause];
  if ('leave' in fault) return [fault.leave];
  if ('join' in fault) return [fault.join];
  if ('partition' in fault) return [...fault.partition[0], ...fault.partition[1]];
  if ('reset' in fault) return [...fault.reset];
  if ('cut' in fault) return [fault.cut];
  if ('drift' in fault) return [fault.drift];
  if ('jump' in fault) return [];
  if ('disk' in fault) return fault.node === undefined ? [] : [fault.node];
  const node =
    'delay' in fault
      ? fault.delay
      : 'reorder' in fault
        ? fault.reorder
        : 'lose' in fault
          ? fault.lose
          : fault.duplicate;
  return fault.peer === undefined ? [node] : [node, fault.peer];
}

/** The plan's word for a fault. */
export function faultKind(fault: Fault): string {
  if ('disk' in fault) return fault.disk;
  for (const kind of [
    'kill',
    'pause',
    'leave',
    'join',
    'partition',
    'reset',
    'delay',
    'reorder',
    'lose',
    'duplicate',
    'cut',
    'jump',
    'drift',
  ]) {
    if (kind in fault) return kind;
  }
  return 'fault';
}

const DATABASE_KINDS = new Set(['slow', 'hang', 'error', 'lostReplies', 'cut', 'jump']);

const seconds = (ms: number): string => {
  const s = ms / 1_000;
  return `${Number.isInteger(s) ? String(s) : s.toFixed(1)} s`;
};

/** "a", "a and b", "a, b and c". */
export function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

const between = (node: string, peer: string | undefined): string =>
  peer === undefined ? `messages to and from ${node}` : `messages between ${node} and ${peer}`;

/** A fault in plain words. */
export function faultText(fault: Fault): string {
  if ('kill' in fault)
    return `${fault.kill} is killed, and starts again ${seconds(fault.restartAfterMs)} later`;
  if ('pause' in fault) return `${fault.pause} freezes for ${seconds(fault.ms)}`;
  if ('leave' in fault) return `${fault.leave} leaves, handing its shows to the others`;
  if ('join' in fault) return `${fault.join} joins the cluster`;
  if ('partition' in fault) {
    const [a, b] = fault.partition;
    const how = fault.oneWay === true ? 'can’t send to' : 'can’t reach';
    return `${list(a)} ${how} ${list(b)} for ${seconds(fault.ms)}`;
  }
  if ('reset' in fault) return `the connections between ${fault.reset.join(' and ')} drop`;
  if ('delay' in fault)
    return `${between(fault.delay, fault.peer)} are slow, ${String(fault.latencyMs[0])} to ${String(fault.latencyMs[1])} ms, for ${seconds(fault.ms)}`;
  if ('reorder' in fault)
    return `${between(fault.reorder, fault.peer)} arrive out of order for ${seconds(fault.ms)}`;
  if ('lose' in fault)
    return `${percent(fault.rate)} of ${between(fault.lose, fault.peer)} go missing for ${seconds(fault.ms)}`;
  if ('duplicate' in fault)
    return `${percent(fault.rate)} of ${between(fault.duplicate, fault.peer)} arrive twice for ${seconds(fault.ms)}`;
  if ('cut' in fault) return `${fault.cut} loses its database for ${seconds(fault.ms)}`;
  if ('jump' in fault) return `the database’s clock jumps ${seconds(fault.jump)} ahead`;
  if ('drift' in fault)
    return `${fault.drift}’s clock runs ${String(Math.abs(fault.ppm))} parts per million ${fault.ppm < 0 ? 'slow' : 'fast'} for ${seconds(fault.ms)}`;
  const whose = fault.node === undefined ? 'the database' : `the database, for ${fault.node},`;
  switch (fault.disk) {
    case 'slow':
      return `${whose} is slow, ${String(fault.latencyMs[0])} to ${String(fault.latencyMs[1])} ms a call, for ${seconds(fault.ms)}`;
    case 'hang':
      return `${whose} stops answering for ${seconds(fault.ms)}`;
    case 'error':
      return `${whose} fails ${percent(fault.rate)} of calls for ${seconds(fault.ms)}`;
    case 'lostReplies':
      return `${whose} loses ${percent(fault.rate)} of its answers, after doing the work, for ${seconds(fault.ms)}`;
  }
}

const INVARIANT_WORDS: Readonly<Record<string, string>> = {
  oneLiveInstance: 'Two copies of one show ran at once, each free to sell the same seats.',
  acknowledgedWritesKept: 'A customer was told their ticket was sold, and the sale was lost.',
  noStaleReads: 'A customer was shown fewer sales than an earlier customer had already seen.',
  recovers: 'Long after the faults had healed, the cluster still hadn’t settled down.',
  failoverWithin: 'A show came back after a crash, and still nobody could reach it.',
  atMostOnce: 'One message was handled twice.',
  orderPerPair: 'Two messages from one sender arrived in the wrong order.',
  stalled: 'The run got stuck waiting on something that would never come.',
};

/** What an invariant's violation means, in a sentence for anyone. */
export function sentenceFor(invariant: string): string {
  return INVARIANT_WORDS[invariant] ?? `The invariant ${invariant} broke.`;
}

function markOf(violation: Violation | undefined): Mark | undefined {
  if (violation === undefined) return undefined;
  const entity = violation.entity;
  const show = entity?.startsWith('show/') === true ? entity.slice('show/'.length) : undefined;
  return {
    invariant: violation.invariant,
    message: violation.message,
    sentence: sentenceFor(violation.invariant),
    time: violation.time,
    until: violation.until,
    nodes: [...new Set((violation.nodes ?? []).map(nodeName))],
    show: show !== undefined && /^\d+$/.test(show) ? undefined : show,
  };
}

/** A bar while it's drawn: still open to change, and with its shard, for a lost lease. */
type Open = { -readonly [K in keyof Bar]: Bar[K] } & { readonly shard: string };

interface Interval {
  readonly from: number;
  readonly to: number;
}

/** The states of one lane, from intervals of each, as spans end to end from 0 to `end`. */
function spansOf(
  running: readonly Interval[],
  paused: readonly Interval[],
  partitioned: readonly Interval[],
  end: number,
): Span[] {
  const cuts = new Set([0, end]);
  for (const list of [running, paused, partitioned]) {
    for (const i of list) {
      cuts.add(Math.min(Math.max(i.from, 0), end));
      cuts.add(Math.min(Math.max(i.to, 0), end));
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const inside = (list: readonly Interval[], t: number) =>
    list.some((i) => i.from <= t && t < i.to);
  const spans: Span[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const from = points[k] as number;
    const to = points[k + 1] as number;
    const state: LaneState = !inside(running, from)
      ? 'down'
      : inside(paused, from)
        ? 'paused'
        : inside(partitioned, from)
          ? 'partitioned'
          : 'up';
    const last = spans[spans.length - 1];
    if (last !== undefined && last.state === state) spans[spans.length - 1] = { ...last, to };
    else spans.push({ from, to, state });
  }
  return spans;
}

/**
 * Draws a run from its history and the first of its violations, if it had one. The history may
 * be whole or {@link trim}med: the drawing is the same.
 */
export function draw(history: History, violation?: Violation): Drawing {
  const run = runOf(history);
  const end = run.untilMs ?? run.durationMs;
  const nodes = [...run.nodes, ...run.spares, ...run.clients];
  const running = new Map<string, Interval[]>(nodes.map((n) => [n, []]));
  const paused = new Map<string, Interval[]>(nodes.map((n) => [n, []]));
  const partitioned = new Map<string, Interval[]>(nodes.map((n) => [n, []]));
  const started = new Map<string, number>();
  const begun = new Map<number, { readonly time: number; readonly fault: Fault }>();
  const faults: FaultBand[] = [];
  const bars: Open[] = [];
  const open = new Map<string, Open>();
  const shows: string[] = [];
  const outcomes = { ok: 0, failed: 0, unknown: 0 };
  const mark = markOf(violation);

  const band = (index: number, fault: Fault, from: number, to: number): void => {
    const kind = faultKind(fault);
    faults.push({
      index,
      kind,
      from,
      to,
      place: DATABASE_KINDS.has(kind) ? 'database' : 'nodes',
      nodes: faultNodes(fault),
      text: faultText(fault),
    });
    const into = kind === 'pause' ? paused : kind === 'partition' ? partitioned : undefined;
    if (into === undefined) return;
    for (const node of faultNodes(fault)) into.get(node)?.push({ from, to });
  };
  const closeBars = (match: (b: Open) => boolean, time: number): void => {
    for (const [key, bar] of open) {
      if (!match(bar)) continue;
      bar.to = time;
      open.delete(key);
    }
  };

  for (const e of history) {
    switch (e.kind) {
      case 'start':
        started.set(`${e.node} ${String(e.inc)}`, e.time);
        break;
      case 'stop': {
        const key = `${e.node} ${String(e.inc)}`;
        running.get(e.node)?.push({ from: started.get(key) ?? 0, to: e.time });
        started.delete(key);
        closeBars((b) => b.node === e.node && b.inc === e.inc, e.time);
        break;
      }
      case 'fault':
        if (e.phase === 'begin') {
          begun.set(e.index, { time: e.time, fault: e.fault });
        } else {
          const b = begun.get(e.index);
          begun.delete(e.index);
          band(e.index, e.fault, b?.time ?? e.time, e.time);
        }
        break;
      case 'complete':
        outcomes[e.outcome]++;
        break;
      case 'event': {
        const { type } = e.event;
        if (type === 'shardReleased' && e.event.reason === 'leaseLost') {
          // As the invariants count it: an instance whose node lost its lease takes no more work.
          const shard = word(e.event.shard);
          closeBars((b) => b.node === e.node && b.inc === e.inc && b.shard === shard, e.time);
          break;
        }
        if (type !== 'spawned' && type !== 'stopped') break;
        const show = showOf(e.event.path);
        if (show === undefined) break;
        const key = `${e.node} ${String(e.inc)} ${show}`;
        if (type === 'spawned') {
          if (!shows.includes(show)) shows.push(show);
          const bar: Open = {
            show,
            shard: shardOf(e.event.path),
            node: e.node,
            inc: e.inc,
            from: e.time,
            to: end,
            marked: false,
          };
          open.set(key, bar);
          bars.push(bar);
        } else {
          const bar = open.get(key);
          if (bar !== undefined) bar.to = e.time;
          open.delete(key);
        }
        break;
      }
      default:
        break;
    }
  }
  // Whatever was still running, or still under way, ran to the end.
  for (const [key, from] of started) {
    const node = key.slice(0, key.lastIndexOf(' '));
    running.get(node)?.push({ from, to: end });
  }
  for (const [index, b] of begun) band(index, b.fault, b.time, end);
  faults.sort((a, b) => a.from - b.from || a.index - b.index);

  const lanes: Lane[] = nodes.map((node) => ({
    node,
    role: run.clients.includes(node) ? 'client' : run.spares.includes(node) ? 'spare' : 'host',
    spans: spansOf(
      running.get(node) ?? [],
      paused.get(node) ?? [],
      partitioned.get(node) ?? [],
      end,
    ),
  }));

  const hosts = [...run.nodes, ...run.spares];
  return {
    seed: run.seed,
    mode: run.mode,
    endMs: end,
    quietFrom: run.quietFrom,
    shows,
    lanes,
    bars: bars.map((b) => ({
      show: b.show,
      node: b.node,
      inc: b.inc,
      from: b.from,
      to: b.to,
      marked: isMarked(b, mark, hosts),
    })),
    faults,
    mark,
    log: narrate(history, mark),
    outcomes,
  };
}

function shardOf(path: unknown): string {
  return typeof path === 'string' ? (path.split('/')[4] ?? '') : '';
}

/**
 * Whether a bar is one the mark names: an instance of its show, live at the moment it broke, on a
 * node it names, or on any node if it names none that ran the show (such as the crowd's, for a
 * write it was told was kept).
 */
function isMarked(bar: Bar, mark: Mark | undefined, hosts: readonly string[]): boolean {
  if (mark === undefined || mark.show !== bar.show) return false;
  if (bar.to < mark.time || bar.from > (mark.until ?? mark.time)) return false;
  const named = mark.nodes.filter((n) => hosts.includes(n));
  return named.length === 0 || named.includes(bar.node);
}

/** A lane's state at `time`. */
export function stateAt(lane: Lane, time: number): LaneState {
  for (const s of lane.spans) if (s.from <= time && time < s.to) return s.state;
  return lane.spans[lane.spans.length - 1]?.state ?? 'down';
}
