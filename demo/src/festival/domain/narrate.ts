// Festival night's log, in plain words: what the buttons did, what the crowd's node noticed, which
// shows moved where, and what customers lived through. Member news is told once, as the crowd's
// node sees it, since every node sees the same thing. Shard news comes from the node that acted.
import type { SystemEvent } from '@kylewillett/troupe';
import { RUSH_SIZE } from '../../domain/crowd.ts';
import { CROWD, type FestivalEvent } from './festival-night.ts';
import { ENTITY_PATH } from './stage.ts';

const CUSTOMER_PATH = /^\/user\/crowd\/([^/]+)$/;

const seats = (n: number): string => `${String(n)} ${n === 1 ? 'seat' : 'seats'}`;

/** "hamlet", "hamlet and lear", "hamlet, lear and othello". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

const secondsBetween = (from: number, to: number): string => ((to - from) / 1_000).toFixed(1);

/** What a customer hears, as a message event shows it: a piped ask's raw result. */
type Delivery =
  | {
      readonly ok: true;
      readonly value: {
        readonly kind?: string;
        readonly ok?: boolean;
        readonly show?: string;
        readonly seats?: number;
      };
    }
  | { readonly ok: false }
  | { readonly type: string };

/** Tells festival night's story, one event at a time. */
export class Narrator {
  // Every show seen in each shard, from entity spawns on any node.
  readonly #shows = new Map<number, string[]>();
  // How each shard last stopped on a node: who had it, and why.
  readonly #released = new Map<number, { readonly address: string; readonly reason: string }>();
  // Who held each shard last, by its acquire.
  readonly #holder = new Map<number, string>();
  readonly #killedAt = new Map<string, number>();
  readonly #seenUp = new Set<string>();
  readonly #leaving = new Set<string>();
  readonly #opened = new Set<string>();

  /** The log line for `e`, or `undefined` if it isn't worth one. */
  line(e: FestivalEvent): string | undefined {
    if (e.kind === 'press') {
      const a = e.address ?? '';
      switch (e.press) {
        case 'kill':
          this.#killedAt.set(a, e.at);
          return `You pull the plug on ${a}. Its shows stop at once, and nobody tells the others.`;
        case 'restart':
          return `${a} starts again, as a new incarnation with an empty memory.`;
        case 'add':
          return `${a} joins the festival.`;
        case 'leave':
          this.#leaving.add(a);
          return `${a} is leaving. It hands its shows to the others first.`;
        case 'rush':
          return `A rush: ${String(RUSH_SIZE)} customers arrive at once.`;
      }
    }
    return this.#event(e.node.address, e.event);
  }

  #event(address: string, event: SystemEvent): string | undefined {
    const fromCrowd = address === CROWD;
    switch (event.type) {
      case 'memberUp': {
        if (!fromCrowd || event.address === CROWD) return undefined;
        const again = this.#seenUp.has(event.address);
        this.#seenUp.add(event.address);
        this.#killedAt.delete(event.address);
        return again ? `${event.address} is up again.` : `${event.address} is up.`;
      }
      case 'reachability':
        if (!fromCrowd) return undefined;
        return event.reachable
          ? `${event.address} is answering again.`
          : `${event.address} has stopped answering.`;
      case 'memberDown':
        return fromCrowd
          ? `Nobody has heard from ${event.address}: it's declared down.`
          : undefined;
      case 'memberRemoved':
        if (!fromCrowd || !this.#leaving.delete(event.address)) return undefined;
        return `${event.address} has left.`;
      case 'spawned': {
        const match = ENTITY_PATH.exec(event.path);
        if (match === null) return undefined;
        const shard = Number(match[1]);
        const id = match[2] ?? '';
        const shows = this.#shows.get(shard) ?? [];
        if (!shows.includes(id)) this.#shows.set(shard, [...shows, id]);
        return undefined;
      }
      case 'shardReleased':
        this.#released.set(event.shard, { address, reason: event.reason });
        return undefined;
      case 'shardAcquired':
        return this.#acquired(address, event.shard, event.at);
      case 'recovered': {
        const id = ENTITY_PATH.exec(event.path)?.[2];
        if (id === undefined) return undefined;
        const events = event.lastSeq - event.snapshotSeq;
        const first = !this.#opened.has(id);
        this.#opened.add(id);
        if (events > 0) {
          return `${id} is back on ${address}, with all ${String(events)} ${events === 1 ? 'event' : 'events'} from the journal.`;
        }
        return first
          ? `${id} opens on ${address}.`
          : `${id} is back on ${address}, with nothing in its journal yet.`;
      }
      case 'failed': {
        const id = ENTITY_PATH.exec(event.path)?.[2];
        return id === undefined ? undefined : `${id} failed on ${address}, and restarts.`;
      }
      case 'delivered': {
        if (!fromCrowd) return undefined;
        const name = CUSTOMER_PATH.exec(event.path)?.[1];
        return name === undefined ? undefined : customerLine(name, event.message as Delivery);
      }
      default:
        return undefined;
    }
  }

  #acquired(address: string, shard: number, at: number): string | undefined {
    const before = this.#holder.get(shard);
    this.#holder.set(shard, address);
    const released = this.#released.get(shard);
    this.#released.delete(shard);
    const shows = this.#shows.get(shard) ?? [];
    // A shard nobody has used yet: its shows say so themselves as they open.
    if (before === undefined || shows.length === 0) return undefined;
    const what = list(shows);
    const verb = shows.length === 1 ? 'moves' : 'move';
    const killedAt = this.#killedAt.get(before);
    if (released === undefined && killedAt !== undefined && before !== address) {
      return `${what} ${shows.length === 1 ? 'fails' : 'fail'} over to ${address}, ${secondsBetween(killedAt, at)} s after ${before} went.`;
    }
    if (released !== undefined && released.address !== address) {
      return `${what} ${verb} from ${released.address} to ${address}.`;
    }
    return undefined;
  }
}

function customerLine(name: string, msg: Delivery): string | undefined {
  // A decide timer, not an answer.
  if ('type' in msg) return undefined;
  if (!msg.ok) return `${name} gave up waiting for an answer.`;
  const reply = msg.value;
  if (reply.kind === 'confirm' && reply.ok === true) {
    return `${name} bought ${seats(reply.seats ?? 0)} for ${reply.show ?? 'a show'}.`;
  }
  return undefined;
}
