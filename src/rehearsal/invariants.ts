// The invariants (milestone 5, T5): each a pure function of a run's history, never of the live
// system. One live instance and no lost acknowledged write rest on the lease and the journal, so
// they're checked under any network. At-most-once delivery and order per pair rest on the
// Transport contract, so they're checked only in contract mode (decision 0035).

import { checkInt, describe } from '../checks.js';
import { desiredOwner } from '../cluster/placement.js';
import type { JsonValue } from '../json.js';
import {
  entityOf,
  runOf,
  text,
  type CompleteEntry,
  type EventEntry,
  type FaultEntry,
  type History,
  type InvokeEntry,
  type JournalEvent,
  type SendEntry,
} from './history.js';
import type { NetworkMode } from './network.js';

/** Something an invariant found wrong with a run: what, where and when. */
export interface Violation {
  /** The invariant's name. */
  readonly invariant: string;
  /** What went wrong, in a sentence. */
  readonly message: string;
  /** When it went wrong, in ms of simulation time. */
  readonly time: number;
  /** When it stopped, for something that lasted. */
  readonly until?: number;
  /** The node incarnations involved, as `<address>#<uid>`, or nodes, by name. */
  readonly nodes?: readonly string[];
  /** The entity, as `<type>/<id>`. */
  readonly entity?: string;
}

/** Something every run of a scenario must keep to, checked against its history. */
export interface Invariant {
  /** Its name, which each violation it finds carries. */
  readonly name: string;
  /** The network modes it can be checked in. Default every mode. */
  readonly modes?: readonly NetworkMode[];
  /** What it finds wrong with the run, or nothing. It mustn't change the history. */
  check(history: History): readonly Violation[];
}

/** An instance of an entity: from `spawned` to `stopped`, on one node incarnation. */
interface Instance {
  readonly entity: string;
  readonly shard: number;
  /** `<address>#<uid>`. */
  readonly holder: string;
  readonly node: string;
  readonly inc: number;
  readonly from: number;
  to: number;
}

/** Formats ms with thousands separated, as `31,204`, the same in every locale. */
export function ms(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The holder name of every incarnation in a history, by `<node> <inc>`.
function holders(history: History): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of history) {
    if (e.kind === 'start') out.set(`${e.node} ${String(e.inc)}`, `${e.node}#${String(e.uid)}`);
  }
  return out;
}

/**
 * Every entity instance in a history. An instance is live from `spawned` until it stops, its
 * process ends, or its node's lease on its shard runs out by the node's own clock (`leaseLost`),
 * whichever comes first. From a lost lease on, an instance takes no new message: what it's still
 * finishing, such as an append whose reply never came, is for the journal's sequence check to
 * fence (decision 0013), and `acknowledgedWritesKept` and `noStaleReads` catch what gets past.
 * One still live when the run ended has `to` Infinity.
 */
export function instances(history: History): Instance[] {
  const names = holders(history);
  const all: Instance[] = [];
  const open = new Map<string, Instance>();
  const close = (match: (i: Instance) => boolean, time: number): void => {
    for (const [key, instance] of open) {
      if (!match(instance)) continue;
      instance.to = time;
      open.delete(key);
    }
  };
  for (const e of history) {
    if (e.kind === 'stop') {
      // A process that ended ended its entities with it.
      close((i) => i.node === e.node && i.inc === e.inc, e.time);
      continue;
    }
    if (e.kind !== 'event') continue;
    const { type } = e.event;
    if (type === 'shardReleased' && e.event.reason === 'leaseLost') {
      const lost = text(e.event.entityType);
      const shard = e.event.shard;
      close(
        (i) =>
          i.node === e.node &&
          i.inc === e.inc &&
          i.shard === shard &&
          i.entity.startsWith(`${lost}/`),
        e.time,
      );
      continue;
    }
    if (type !== 'spawned' && type !== 'stopped') continue;
    const place = entityOf(text(e.event.path));
    if (place === undefined) continue;
    const entity = `${place.type}/${place.id}`;
    const key = `${e.node} ${String(e.inc)} ${entity}`;
    if (type === 'spawned') {
      const instance: Instance = {
        entity,
        shard: place.shard,
        holder: names.get(`${e.node} ${String(e.inc)}`) ?? e.node,
        node: e.node,
        inc: e.inc,
        from: e.time,
        to: Infinity,
      };
      open.set(key, instance);
      all.push(instance);
    } else {
      const instance = open.get(key);
      if (instance !== undefined) instance.to = e.time;
      open.delete(key);
    }
  }
  return all;
}

// When each node was paused: [from, to) in simulation time, by node name.
function pauses(history: History): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  const begun = new Map<number, number>();
  for (const e of history) {
    if (e.kind !== 'fault' || !('pause' in e.fault)) continue;
    if (e.phase === 'begin') begun.set(e.index, e.time);
    else {
      const from = begun.get(e.index) ?? e.time;
      const list = out.get(e.fault.pause) ?? [];
      list.push([from, e.time]);
      out.set(e.fault.pause, list);
    }
  }
  for (const [index, from] of begun) {
    const fault = history.find(
      (e): e is FaultEntry => e.kind === 'fault' && e.index === index && e.phase === 'end',
    );
    if (fault === undefined) {
      const start = history.find((e): e is FaultEntry => e.kind === 'fault' && e.index === index);
      if (start !== undefined && 'pause' in start.fault) {
        const list = out.get(start.fault.pause) ?? [];
        list.push([from, Infinity]);
        out.set(start.fault.pause, list);
      }
    }
  }
  return out;
}

// [from, to) less the times its node was paused.
function active(
  instance: Instance,
  paused: ReadonlyMap<string, readonly [number, number][]>,
): [number, number][] {
  let spans: [number, number][] = [[instance.from, instance.to]];
  for (const [pFrom, pTo] of paused.get(instance.node) ?? []) {
    spans = spans.flatMap(([a, b]): [number, number][] => {
      if (pTo <= a || pFrom >= b) return [[a, b]];
      const out: [number, number][] = [];
      if (pFrom > a) out.push([a, pFrom]);
      if (pTo < b) out.push([pTo, b]);
      return out;
    });
  }
  return spans;
}

/**
 * No two instances of one entity are live in overlapping intervals of simulation time. An
 * instance runs from `spawned` to `stopped` on its node, or until its process ends. While its node
 * is paused it processes nothing, so a pause alone isn't a violation: what it does when it wakes
 * may be.
 */
function oneLiveInstance(): Invariant {
  const name = 'oneLiveInstance';
  return {
    name,
    check(history) {
      const paused = pauses(history);
      const byEntity = new Map<string, Instance[]>();
      for (const i of instances(history)) {
        byEntity.set(i.entity, [...(byEntity.get(i.entity) ?? []), i]);
      }
      const out: Violation[] = [];
      for (const [entity, list] of byEntity) {
        const spans = list.map((i) => ({ i, spans: active(i, paused) }));
        for (let a = 0; a < spans.length; a++) {
          for (let b = a + 1; b < spans.length; b++) {
            const x = spans[a];
            const y = spans[b];
            if (x === undefined || y === undefined || x.i.holder === y.i.holder) continue;
            const overlap = firstOverlap(x.spans, y.spans);
            if (overlap === undefined) continue;
            const [from, to] = overlap;
            out.push({
              invariant: name,
              message: `${entity} ran on ${x.i.holder} and ${y.i.holder} from ${ms(from)} to ${to === Infinity ? 'the end' : ms(to)}`,
              time: from,
              until: to,
              nodes: [x.i.holder, y.i.holder],
              entity,
            });
          }
        }
      }
      return out.sort((p, q) => p.time - q.time);
    },
  };
}

function firstOverlap(
  a: readonly [number, number][],
  b: readonly [number, number][],
): [number, number] | undefined {
  let best: [number, number] | undefined;
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const from = Math.max(a0, b0);
      const to = Math.min(a1, b1);
      if (to > from && (best === undefined || from < best[0])) best = [from, to];
    }
  }
  return best;
}

/** One operation, as the history tells it. */
interface Operation {
  readonly invoke: InvokeEntry;
  readonly sends: SendEntry[];
  complete: CompleteEntry | undefined;
}

/** Every operation in a history, in the order they began. */
export function operations(history: History): Operation[] {
  const byId = new Map<number, Operation>();
  for (const e of history) {
    if (e.kind === 'invoke') byId.set(e.op, { invoke: e, sends: [], complete: undefined });
    else if (e.kind === 'send') byId.get(e.op)?.sends.push(e);
    else if (e.kind === 'complete') {
      const op = byId.get(e.op);
      if (op !== undefined) op.complete = e;
    }
  }
  return [...byId.values()];
}

const entityKey = (op: Operation): string => `${op.invoke.entity.type}/${op.invoke.entity.id}`;
const names = (name: string | readonly string[]): readonly string[] =>
  typeof name === 'string' ? [name] : name;

function checkNameOpt(value: unknown, what: string): void {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some((n) => typeof n !== 'string')) {
    throw new TypeError(
      `${what} must be an operation's name or a list of them, got ${describe(value)}`,
    );
  }
}

/** A write that completed ok, as `acknowledgedWritesKept`'s `kept` is given it. */
export interface AcknowledgedWrite {
  /** The entity it wrote to: its type and id. */
  readonly entity: { readonly type: string; readonly id: string };
  /** What it sent its entity, in order. */
  readonly messages: readonly JsonValue[];
  /** Its entity's reply. */
  readonly reply: JsonValue;
}

/** Options for {@link invariants.acknowledgedWritesKept}. */
export interface AcknowledgedWritesOptions {
  /** The operations that write. */
  write?: string | readonly string[];
  /**
   * Whether an acknowledged write is among `journal`'s events, the journal as the run ended: how
   * to find a write from what it sent and its reply. Needed with `write`.
   */
  kept?: (write: AcknowledgedWrite, journal: readonly JournalEvent[]) => boolean;
  /**
   * Whether an ok reply acknowledged the write, rather than refusing it, as a sold-out show's
   * does. Default every ok reply.
   */
  acknowledged?: (reply: JsonValue) => boolean;
}

/**
 * Every write that completed ok, with a reply that acknowledged it, has its events in the journal
 * at the end, and every journal stream is numbered 1 to n with no gaps.
 */
function acknowledgedWritesKept(opts: AcknowledgedWritesOptions = {}): Invariant {
  const name = 'acknowledgedWritesKept';
  if (opts.write !== undefined) checkNameOpt(opts.write, `${name}: write`);
  if ((opts.write === undefined) !== (opts.kept === undefined)) {
    throw new TypeError(`${name}: write and kept go together`);
  }
  const writes = opts.write === undefined ? [] : names(opts.write);
  const { kept, acknowledged = () => true } = opts;
  if (typeof acknowledged !== 'function') {
    throw new TypeError(`${name}: acknowledged must be a function, got ${describe(acknowledged)}`);
  }
  return {
    name,
    check(history) {
      const journal = history.find((e) => e.kind === 'journal');
      const events = journal?.kind === 'journal' ? journal.events : [];
      const out: Violation[] = [];
      const streams = new Map<string, number[]>();
      for (const e of events)
        streams.set(e.persistenceId, [...(streams.get(e.persistenceId) ?? []), e.seq]);
      for (const [stream, seqs] of streams) {
        const sorted = [...seqs].sort((a, b) => a - b);
        const gap = sorted.findIndex((seq, i) => seq !== i + 1);
        if (gap !== -1) {
          out.push({
            invariant: name,
            message: `${stream}'s journal goes ${sorted.slice(Math.max(0, gap - 1), gap + 1).join(', ')}: event ${String(gap + 1)} isn't there`,
            time: journal?.time ?? 0,
            entity: stream,
          });
        }
      }
      if (kept === undefined) return out;
      for (const op of operations(history)) {
        if (!writes.includes(op.invoke.name) || op.complete?.outcome !== 'ok') continue;
        if (!acknowledged(op.complete.reply ?? null)) continue;
        const write = {
          entity: op.invoke.entity,
          messages: op.sends.map((m) => m.message),
          reply: op.complete.reply ?? null,
        };
        if (kept(write, events)) continue;
        out.push({
          invariant: name,
          message: `${entityKey(op)} acknowledged ${op.invoke.name} ${String(op.invoke.op)} from ${op.invoke.client} at ${ms(op.complete.time)}, and the journal doesn't have it`,
          time: op.complete.time,
          nodes: [op.invoke.client],
          entity: entityKey(op),
        });
      }
      return out;
    },
  };
}

/** Options for {@link invariants.noStaleReads}. */
export interface NoStaleReadsOptions {
  /** The operations that read. */
  read: string | readonly string[];
  /** The operations that write. */
  write: string | readonly string[];
  /**
   * The position an ok reply shows, such as a show's count of seats sold, which only ever goes
   * up: for a write, where it got to, and for a read, what it saw. `undefined` skips the reply.
   */
  position: (reply: JsonValue) => number | undefined;
}

/**
 * A read never returns a state older than a write that completed before the read began: its
 * position is at least that write's.
 */
function noStaleReads(opts: NoStaleReadsOptions): Invariant {
  const name = 'noStaleReads';
  checkNameOpt(opts.read, `${name}: read`);
  checkNameOpt(opts.write, `${name}: write`);
  if (typeof opts.position !== 'function') {
    throw new TypeError(`${name}: position must be a function, got ${describe(opts.position)}`);
  }
  const reads = names(opts.read);
  const writes = names(opts.write);
  const { position } = opts;
  return {
    name,
    check(history) {
      // Each entity's ok writes, by when they completed.
      const done = new Map<string, { time: number; at: number; op: Operation }[]>();
      const ops = operations(history);
      for (const op of ops) {
        if (!writes.includes(op.invoke.name) || op.complete?.outcome !== 'ok') continue;
        const at = position(op.complete.reply ?? null);
        if (at === undefined) continue;
        const key = entityKey(op);
        done.set(key, [...(done.get(key) ?? []), { time: op.complete.time, at, op }]);
      }
      const out: Violation[] = [];
      for (const op of ops) {
        if (!reads.includes(op.invoke.name) || op.complete?.outcome !== 'ok') continue;
        const saw = position(op.complete.reply ?? null);
        if (saw === undefined) continue;
        let newest: { time: number; at: number; op: Operation } | undefined;
        for (const w of done.get(entityKey(op)) ?? []) {
          if (w.time < op.invoke.time && (newest === undefined || w.at > newest.at)) newest = w;
        }
        if (newest === undefined || saw >= newest.at) continue;
        out.push({
          invariant: name,
          message: `${entityKey(op)}'s ${op.invoke.name} from ${op.invoke.client} at ${ms(op.invoke.time)} saw ${String(saw)}, but a ${newest.op.invoke.name} that completed at ${ms(newest.time)} had reached ${String(newest.at)}`,
          time: op.invoke.time,
          until: op.complete.time,
          nodes: [op.invoke.client],
          entity: entityKey(op),
        });
      }
      return out;
    },
  };
}

// Each message an operation sent, as its JSON, with the delivered events of entities.
function deliveries(history: History): {
  sends: { entity: string; key: string; entry: SendEntry; op: Operation }[];
  delivered: { entity: string; key: string; entry: EventEntry; holder: string; shard: number }[];
} {
  const sends: { entity: string; key: string; entry: SendEntry; op: Operation }[] = [];
  const byId = new Map(operations(history).map((op) => [op.invoke.op, op]));
  // In the order they were sent, which for an operation that sends twice isn't the order the
  // operations began.
  for (const entry of history) {
    if (entry.kind !== 'send') continue;
    const op = byId.get(entry.op);
    if (op === undefined) continue;
    const entity = entityKey(op);
    sends.push({ entity, key: `${entity} ${JSON.stringify(entry.message)}`, entry, op });
  }
  const names = holders(history);
  const delivered: {
    entity: string;
    key: string;
    entry: EventEntry;
    holder: string;
    shard: number;
  }[] = [];
  for (const e of history) {
    if (e.kind !== 'event' || e.event.type !== 'delivered') continue;
    const place = entityOf(text(e.event.path));
    if (place === undefined) continue;
    const entity = `${place.type}/${place.id}`;
    delivered.push({
      entity,
      key: `${entity} ${JSON.stringify(e.event.message ?? null)}`,
      entry: e,
      holder: names.get(`${e.node} ${String(e.inc)}`) ?? e.node,
      shard: place.shard,
    });
  }
  return { sends, delivered };
}

/**
 * No message an operation sent is delivered to its entity more often than it was sent. Contract
 * mode only: chaos mode repeats frames below remoting, which has no sequence numbers to drop them
 * by. Operations' messages have to differ for it to tell them apart, as a `replyTo` makes them.
 */
function atMostOnce(): Invariant {
  const name = 'atMostOnce';
  return {
    name,
    modes: ['contract'],
    check(history) {
      const { sends, delivered } = deliveries(history);
      const sent = new Map<string, number>();
      for (const s of sends) sent.set(s.key, (sent.get(s.key) ?? 0) + 1);
      const seen = new Map<string, number>();
      const out: Violation[] = [];
      for (const d of delivered) {
        const most = sent.get(d.key);
        if (most === undefined) continue;
        const count = (seen.get(d.key) ?? 0) + 1;
        seen.set(d.key, count);
        if (count === most + 1) {
          const op = sends.find((s) => s.key === d.key)?.op;
          out.push({
            invariant: name,
            message: `${d.entity} got ${op === undefined ? 'a message' : `${op.invoke.name} ${String(op.invoke.op)}'s message`} ${String(count)} times, at ${ms(d.entry.time)} on ${d.holder} the last, and it was sent ${String(most)}`,
            time: d.entry.time,
            nodes: [d.holder],
            entity: d.entity,
          });
        }
      }
      return out;
    },
  };
}

/**
 * Messages from one client to one entity are delivered in the order they were sent, while the
 * entity's shard stays put (decision 0030): delivered to one instance, both sent a lease's TTL or
 * more after the shard started where they were delivered and every node that held it before had
 * let it go, with no fault under way from the first send to the last delivery. A move can reorder
 * messages in flight, and a client can only hear of one once the old owner answers, so the check
 * leaves out what it can't tell from a move. Contract mode only.
 */
function orderPerPair(): Invariant {
  const name = 'orderPerPair';
  return {
    name,
    modes: ['contract'],
    check(history) {
      const { sends, delivered } = deliveries(history);
      const names = holders(history);
      // Each incarnation's hold on each shard, as `<type> <shard>`: from acquiring it until it
      // let it go, lost its lease or ended.
      const holds = new Map<string, { holder: string; from: number; to: number }[]>();
      const open = new Map<string, { holder: string; from: number; to: number }>();
      for (const e of history) {
        if (e.kind === 'stop') {
          const holder = names.get(`${e.node} ${String(e.inc)}`);
          for (const [key, hold] of open) {
            if (hold.holder !== holder) continue;
            hold.to = e.time;
            open.delete(key);
          }
          continue;
        }
        if (e.kind !== 'event') continue;
        const { type } = e.event;
        if (type !== 'shardAcquired' && type !== 'shardReleased') continue;
        const holder = names.get(`${e.node} ${String(e.inc)}`) ?? e.node;
        const shard = `${text(e.event.entityType)} ${text(e.event.shard)}`;
        const key = `${holder} ${shard}`;
        if (type === 'shardAcquired') {
          const hold = { holder, from: e.time, to: Infinity };
          open.set(key, hold);
          holds.set(shard, [...(holds.get(shard) ?? []), hold]);
        } else {
          const hold = open.get(key);
          if (hold !== undefined) hold.to = e.time;
          open.delete(key);
        }
      }
      // From when the shard had stayed put where `d` was delivered: a lease's TTL after that
      // incarnation had it and every other that held it before had let go, by which time a client
      // has had its chance to hear of the move. Infinity if one never let go.
      const { ttlMs } = runOf(history).leases;
      const settledSince = (d: (typeof delivered)[number], type: string): number => {
        let since = -Infinity;
        for (const hold of holds.get(`${type} ${String(d.shard)}`) ?? []) {
          if (hold.from > d.entry.time) continue;
          since = Math.max(since, hold.holder === d.holder ? hold.from : hold.to);
        }
        return since + ttlMs;
      };
      // Faults, as [from, to], so pairs a fault may have reordered on the way can be left out.
      const spans: [number, number][] = [];
      const begun = new Map<number, number>();
      for (const e of history) {
        if (e.kind !== 'fault') continue;
        if (e.phase === 'begin') begun.set(e.index, e.time);
        else spans.push([begun.get(e.index) ?? e.time, e.time]);
        if (e.phase === 'end') begun.delete(e.index);
      }
      for (const from of begun.values()) spans.push([from, Infinity]);
      const quiet = (from: number, to: number): boolean =>
        spans.every(([a, b]) => b < from || a > to);
      const firstDelivery = new Map<string, (typeof delivered)[number]>();
      for (const d of delivered) if (!firstDelivery.has(d.key)) firstDelivery.set(d.key, d);
      const all = instances(history);
      const instanceOf = (d: (typeof delivered)[number]): Instance | undefined =>
        all.find(
          (i) =>
            i.holder === d.holder &&
            i.entity === d.entity &&
            i.from <= d.entry.time &&
            d.entry.time <= i.to,
        );
      const out: Violation[] = [];
      const byPair = new Map<string, typeof sends>();
      for (const s of sends) {
        const pair = `${s.op.invoke.client} ${s.entity}`;
        byPair.set(pair, [...(byPair.get(pair) ?? []), s]);
      }
      for (const [pair, list] of byPair) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const first = list[i];
            const second = list[j];
            if (first === undefined || second === undefined) continue;
            const d1 = firstDelivery.get(first.key);
            const d2 = firstDelivery.get(second.key);
            if (d1 === undefined || d2 === undefined || d1.holder !== d2.holder) continue;
            if (d2.entry.time > d1.entry.time) continue;
            if (
              d2.entry.time === d1.entry.time &&
              history.indexOf(d2.entry) > history.indexOf(d1.entry)
            )
              continue;
            const inst = instanceOf(d1);
            if (inst === undefined || inst !== instanceOf(d2)) continue;
            if (first.entry.time < settledSince(d1, first.op.invoke.entity.type)) continue;
            if (!quiet(first.entry.time, d1.entry.time)) continue;
            out.push({
              invariant: name,
              message: `${pair.replace(' ', ' to ')}: ${second.op.invoke.name} ${String(second.op.invoke.op)}, sent at ${ms(second.entry.time)}, was delivered on ${d1.holder} at ${ms(d2.entry.time)}, before ${first.op.invoke.name} ${String(first.op.invoke.op)}, sent earlier at ${ms(first.entry.time)}`,
              time: d2.entry.time,
              until: d1.entry.time,
              nodes: [first.op.invoke.client, d1.holder],
              entity: first.entity,
            });
          }
        }
      }
      return out;
    },
  };
}

/** Options for {@link invariants.recovers}. */
export interface RecoversOptions {
  /** How long after the last fault ends the cluster has to recover, in ms. */
  withinMs: number;
}

/**
 * Once every fault has ended, within `withinMs`: every running node's member table agrees on who
 * is up, every node that's running is in it, every shard a running node holds is on its desired
 * owner, and every operation that begins from then on answers.
 */
function recovers(opts: RecoversOptions): Invariant {
  const name = 'recovers';
  checkInt(opts.withinMs, `${name}: withinMs`);
  const { withinMs } = opts;
  return {
    name,
    check(history) {
      const run = runOf(history);
      const end = history.at(-1)?.time ?? run.durationMs;
      let healed = 0;
      for (const e of history)
        if (e.kind === 'fault' && e.phase === 'end') healed = Math.max(healed, e.time);
      // A run cut short before the cluster's time was up has nothing to check yet (T6).
      if (run.untilMs !== undefined && healed + withinMs > end) return [];
      const by = Math.min(healed + withinMs, end);
      const out: Violation[] = [];
      // Who's running at `by`, and each one's view of the members, from its member events.
      const running = new Map<string, { node: string; holder: string; client: boolean }>();
      const views = new Map<string, Map<string, string>>();
      for (const e of history) {
        if (e.time > by) break;
        const id = `${'node' in e ? e.node : ''} ${'inc' in e ? String(e.inc) : ''}`;
        if (e.kind === 'start') {
          running.set(id, {
            node: e.node,
            holder: `${e.node}#${String(e.uid)}`,
            client: run.clients.includes(e.node),
          });
          views.set(id, new Map());
        } else if (e.kind === 'stop') {
          running.delete(id);
          views.delete(id);
        } else if (e.kind === 'event') {
          const view = views.get(id);
          const { type } = e.event;
          if (view === undefined || typeof e.event.address !== 'string') continue;
          const member = `${e.event.address}#${text(e.event.uid)}`;
          if (type === 'memberUp') view.set(member, 'up');
          else if (type === 'memberLeaving') view.set(member, 'leaving');
          else if (type === 'memberDown') view.set(member, 'down');
          else if (type === 'memberRemoved') view.delete(member);
        }
      }
      const expectedUp = [...running.values()].map((r) => r.holder).sort();
      for (const [id, view] of views) {
        const up = [...view]
          .filter(([, status]) => status === 'up')
          .map(([m]) => m)
          .sort();
        if (up.join() !== expectedUp.join()) {
          out.push({
            invariant: name,
            message: `at ${ms(by)}, ${String(running.get(id)?.holder)} had ${up.length === 0 ? 'no one' : up.join(', ')} up, where ${expectedUp.join(', ')} were running`,
            time: by,
            nodes: [String(running.get(id)?.holder)],
          });
        }
      }
      // Who holds each shard at `by`: whoever acquired it last, unless it has let it go or ended.
      const held = new Map<string, string>();
      const holderOf = new Map<string, string>();
      for (const [id, r] of running) holderOf.set(id, r.holder);
      for (const e of history) {
        if (e.time > by) break;
        if (e.kind !== 'event') continue;
        const lease = `${text(e.event.entityType)}/${text(e.event.shard)}`;
        if (e.event.type === 'shardAcquired') held.set(lease, text(e.event.node));
        else if (e.event.type === 'shardReleased' && held.get(lease) === e.event.node)
          held.delete(lease);
      }
      // A shard a running node holds must be on its desired owner. One no running node holds
      // has nothing to check: a region takes a shard only when it has entities to run, and
      // whether those answer is the next check.
      const live = new Set(holderOf.values());
      const hosts = [...running.values()].filter((r) => !r.client).map((r) => r.node);
      for (const [lease, holder] of [...held].sort(([a], [b]) => a.localeCompare(b))) {
        if (!live.has(holder)) continue;
        const at = holder.slice(0, holder.lastIndexOf('#'));
        const owner = desiredOwner(lease, hosts);
        if (at === owner) continue;
        out.push({
          invariant: name,
          message: `at ${ms(by)}, shard ${lease} was on ${at}, and belongs on ${String(owner)}`,
          time: by,
          nodes: owner === undefined ? [holder] : [holder, owner],
          entity: lease,
        });
      }
      for (const op of operations(history)) {
        if (op.invoke.time < by || op.complete === undefined || op.complete.outcome === 'ok')
          continue;
        out.push({
          invariant: name,
          message: `${entityKey(op)} didn't answer ${op.invoke.name} ${String(op.invoke.op)} from ${op.invoke.client}, begun at ${ms(op.invoke.time)}, after the faults had healed at ${ms(healed)}: ${op.complete.outcome}${op.complete.error === undefined ? '' : `, ${op.complete.error}`}`,
          time: op.invoke.time,
          until: op.complete.time,
          nodes: [op.invoke.client],
          entity: entityKey(op),
        });
      }
      return out;
    },
  };
}

/** Options for {@link invariants.failoverWithin}. */
export interface FailoverOptions {
  /**
   * How long after a kill the dead node's entities may take to run again elsewhere, in ms.
   * Default the lease's `ttlMs`, plus one renewal and one rebalance of 2,000.
   */
  withinMs?: number;
}

/**
 * After a kill, every entity that was running on the dead node, and is asked for, runs again on
 * another node incarnation within a bound. Only kills with no other fault under way before the
 * bound is up, or ended within a bound before the kill, are checked, since another fault, or the
 * cluster still settling from one, can stretch failover by design.
 */
function failoverWithin(opts: FailoverOptions = {}): Invariant {
  const name = 'failoverWithin';
  if (opts.withinMs !== undefined) checkInt(opts.withinMs, `${name}: withinMs`);
  return {
    name,
    check(history) {
      const run = runOf(history);
      const bound = opts.withinMs ?? run.leases.ttlMs + run.leases.renewMs + 2_000;
      const end = history.at(-1)?.time ?? run.durationMs;
      const faults: { index: number; from: number; to: number; kill?: string }[] = [];
      for (const e of history) {
        if (e.kind !== 'fault') continue;
        if (e.phase === 'begin') {
          faults.push({
            index: e.index,
            from: e.time,
            to: Infinity,
            ...('kill' in e.fault ? { kill: e.fault.kill } : {}),
          });
        } else {
          const f = faults.find((x) => x.index === e.index);
          if (f !== undefined) f.to = e.time;
        }
      }
      const all = instances(history);
      const ops = operations(history);
      const out: Violation[] = [];
      for (const kill of faults) {
        if (kill.kill === undefined) continue;
        const t = kill.from;
        // A run cut short before the bound was up can't say yet (T6).
        if (run.untilMs !== undefined && t + bound > end) continue;
        // Near it: under way in the bound after it, or ended within a bound before it, when the
        // cluster may still be settling from it, such as nodes a partition made restart (T7).
        const others = faults.filter((f) => f !== kill && f.from <= t + bound && f.to >= t - bound);
        if (others.length > 0) continue;
        const dead = all.filter((i) => i.node === kill.kill && i.from <= t && i.to >= t);
        for (const instance of dead) {
          const asked = ops.some(
            (op) =>
              entityKey(op) === instance.entity &&
              op.invoke.time > t &&
              op.invoke.time <= t + bound - 100,
          );
          if (!asked) continue;
          const again = all.find(
            (i) =>
              i.entity === instance.entity &&
              i.holder !== instance.holder &&
              i.from > t - 1 &&
              i.from <= t + bound,
          );
          if (again !== undefined) {
            // Running again isn't enough: what's asked of it from then on must reach it. Some
            // operation begun once it was back, within the bound, has to answer.
            const after = ops.filter(
              (op) =>
                entityKey(op) === instance.entity &&
                op.invoke.time >= again.from &&
                op.invoke.time <= t + bound - 100 &&
                op.complete !== undefined,
            );
            if (after.length === 0 || after.some((op) => op.complete?.outcome === 'ok')) continue;
            out.push({
              invariant: name,
              message: `${instance.entity}, on ${instance.holder} when it was killed at ${ms(t)}, ran again on ${again.holder} from ${ms(again.from)}, and none of the ${String(after.length)} operations begun on it by ${ms(t + bound - 100)} answered`,
              time: t,
              until: t + bound,
              nodes: [instance.holder, again.holder],
              entity: instance.entity,
            });
            continue;
          }
          out.push({
            invariant: name,
            message: `${instance.entity}, on ${instance.holder} when it was killed at ${ms(t)}, wasn't running anywhere else by ${ms(t + bound)}`,
            time: t,
            until: t + bound,
            nodes: [instance.holder],
            entity: instance.entity,
          });
        }
      }
      return out;
    },
  };
}

/** The built-in invariants, each a function of a run's history. */
export const invariants = {
  oneLiveInstance,
  acknowledgedWritesKept,
  noStaleReads,
  atMostOnce,
  orderPerPair,
  recovers,
  failoverWithin,
};

/**
 * Whether a run's clocks went past what a lease's margin covers (decision 0029): how far a node's
 * clock can drift over one TTL, plus how far the database's clock jumped within any one TTL,
 * more than the margin. Jumps add up: two that are each inside the margin can outrun it
 * together, as the hunt found (T7).
 */
export function pastTheMargin(history: History): boolean {
  const { leases, plan } = runOf(history);
  let ppm = 0;
  for (const e of history) if (e.kind === 'start') ppm = Math.max(ppm, Math.abs(e.driftPpm));
  for (const fault of plan) if ('drift' in fault) ppm = Math.max(ppm, Math.abs(fault.ppm));
  const drift = (ppm * leases.ttlMs) / 1_000_000;
  const jumps = plan.flatMap((f) => ('jump' in f ? [f] : [])).sort((a, b) => a.at - b.at);
  let worst = 0;
  for (const [i, first] of jumps.entries()) {
    let sum = 0;
    for (const next of jumps.slice(i)) {
      if (next.at - first.at >= leases.ttlMs) break;
      sum += next.jump;
    }
    worst = Math.max(worst, sum);
  }
  return drift + worst > leases.marginMs;
}

/**
 * Checks every invariant against a history. An overlap `oneLiveInstance` finds in a run past the
 * margin is `expected`, as long as `acknowledgedWritesKept` and `noStaleReads` are checked and
 * pass: the journal held, as 0013 promises it will.
 */
export function checkInvariants(
  list: readonly Invariant[],
  history: History,
): { violations: Violation[]; expected: Violation[] } {
  const violations = list.flatMap((inv) => [...inv.check(history)]);
  const names = new Set(list.map((inv) => inv.name));
  const journalHeld =
    names.has('acknowledgedWritesKept') &&
    names.has('noStaleReads') &&
    !violations.some(
      (v) => v.invariant === 'acknowledgedWritesKept' || v.invariant === 'noStaleReads',
    );
  if (!journalHeld || !pastTheMargin(history)) return { violations, expected: [] };
  return {
    violations: violations.filter((v) => v.invariant !== 'oneLiveInstance'),
    expected: violations.filter((v) => v.invariant === 'oneLiveInstance'),
  };
}
