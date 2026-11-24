// The simulated database (milestone 5, T3): a journal, snapshot store, offset store and shard store
// on one endpoint, as Postgres serves them all in a real cluster. Its data lives in the in-memory
// backends. What this adds is time and faults (decision 0033): a call's request travels to the
// database for a drawn latency, is applied there, and its reply travels back for another, each a
// timer of simulation time. The reply reaches the caller through its node's clock, so a paused
// node gets it only when it wakes.
//
// Calls are independent, as on a pool of connections: two from one node can overtake each other.
// A hang holds the calls that arrive, unapplied, and applies them in arrival order when it lets
// go. A node cut off from the database has its calls refused, and replies already on their way
// to it arrive as a lost connection, so an applied call can report failure: the outcome a caller
// can't know, which recovery settles (decision 0013).

import { checkId, checkInt, checkKeys, describe, wallClock } from '../checks.js';
import { inMemoryShardStore } from '../cluster/shard-memory.js';
import {
  checkAcquire,
  checkEntity,
  checkPrefix,
  checkRelease,
  checkRenewAll,
  type ShardStore,
} from '../cluster/shard-store.js';
import {
  checkAppend,
  checkOffsetSave,
  checkRead,
  checkReadByTag,
  serializeSnapshot,
} from '../persistence/backend.js';
import { inMemoryPersistence } from '../persistence/memory.js';
import type {
  Journal,
  NewEvent,
  OffsetStore,
  Persistence,
  SnapshotStore,
  StoredEvent,
} from '../persistence/types.js';
import type { Scheduler } from '../scheduler.js';
import { checkRange, checkRate, draw, type Range } from './ranges.js';

/** Options for {@link simulatedDatabase}. */
export interface SimulatedDatabaseOptions {
  /** The simulation's scheduler, which every request and reply travels on. */
  scheduler: Scheduler;
  /** The database's own random stream, which draws every latency, error and lost reply. */
  random: () => number;
  /**
   * The range each request's and each reply's latency is drawn from, in whole ms, both ends
   * included. Default `[1, 3]`.
   */
  latencyMs?: readonly [number, number];
  /**
   * The database's wall clock, in integer ms, which the shard store judges lease expiry by and
   * the journal stamps events with. {@link SimulatedDatabase.jump} adds to it. Default the
   * scheduler's `now`.
   */
  clock?: () => number;
  /**
   * Told of every call once its caller has its answer, or never will: for a run's history. It
   * mustn't throw.
   */
  observe?: (call: DatabaseCall) => void;
}

/** What became of one call, as {@link SimulatedDatabaseOptions.observe} hears of it. */
export interface DatabaseCall {
  /** The node that made it. */
  readonly node: string;
  /** Such as `journal.append` or `shards.acquire`. */
  readonly op: string;
  /**
   * What it was about: an append's stream, expected sequence number and count, as
   * `show-hamlet@3+1`, a lease, a holder for `shards.renewAll`, or `""`.
   */
  readonly target: string;
  /** Whether it reached the data. An applied call can still report failure. */
  readonly applied: boolean;
  /** Whether its answer was a success. */
  readonly ok: boolean;
  /**
   * `delivered`: its caller has the answer. `lost`: the reply was lost, and its caller never
   * hears. `disconnected`: its node was cut off on the way back, so its caller heard of a lost
   * connection. `closed`: its client had closed, which had failed the call already.
   */
  readonly reply: 'delivered' | 'lost' | 'disconnected' | 'closed';
}

/** The database as one node incarnation reaches it. */
export interface DatabaseClient {
  /** The node the calls come from. */
  readonly node: string;
  /** The journal, snapshot store and offset store. */
  readonly persistence: Required<Persistence>;
  /** The shard store, on the same endpoint. */
  readonly shards: ShardStore;
  /**
   * Ends the client, as its process dying does. Requests already sent are still applied, but
   * every call still waiting fails at once, and so does every later one, so an actor system left
   * running in the same process can still wind down.
   */
  close(): void;
}

/** What a simulated database has done with calls so far. */
export interface DatabaseCounts {
  /** Calls made with valid arguments. */
  readonly calls: number;
  /** Calls applied to the data. */
  readonly applied: number;
  /** Calls that failed with an error from {@link SimulatedDatabase.fail}, unapplied. */
  readonly failed: number;
  /** Calls refused because their node was cut off. */
  readonly refused: number;
  /** Calls a hang held when they arrived. */
  readonly hung: number;
  /** Replies {@link SimulatedDatabase.loseReplies} lost. */
  readonly lostReplies: number;
  /** Replies that arrived as a lost connection, because their node was cut off meanwhile. */
  readonly disconnected: number;
  /** Replies that came after their client closed, which had failed the call already. */
  readonly dropped: number;
}

/** The calls a fault applies to: every node's, or only `node`'s. */
export interface CallSelector {
  readonly node?: string;
}

/** One endpoint for a whole simulated cluster's persistence and shard leases, with faults. */
export interface SimulatedDatabase {
  /**
   * A client for one node incarnation. Its replies are handed back on `clock`, the node's own,
   * so they wait while it's paused. Default the database's scheduler.
   * @throws TypeError unless `node` is a non-empty string.
   */
  connect(node: string, clock?: Scheduler): DatabaseClient;
  /** The database's wall clock, jumps included. */
  now(): number;
  /**
   * Draws the latency of every request and reply of the selected calls from `latencyMs` instead,
   * if that's longer, until the returned function ends it.
   */
  slow(opts: CallSelector & { readonly latencyMs: readonly [number, number] }): () => void;
  /**
   * Holds the selected calls that arrive, unapplied and unanswered, until the returned function
   * lets go. Then they're applied, in the order they arrived. Never calling it hangs them for good.
   */
  hang(opts?: CallSelector): () => void;
  /**
   * Fails each selected call with chance `rate` (default 1), without applying it, until the
   * returned function ends it.
   */
  fail(opts?: CallSelector & { readonly rate?: number }): () => void;
  /**
   * Applies each selected call and loses its reply, with chance `rate` (default 1), until the
   * returned function ends it. Its caller never hears.
   */
  loseReplies(opts?: CallSelector & { readonly rate?: number }): () => void;
  /**
   * Cuts `node` off, every incarnation of it, until the returned function heals it: its calls
   * are refused, and replies on their way to it arrive as a lost connection.
   * @throws TypeError unless `node` is a non-empty string.
   */
  cutOff(node: string): () => void;
  /**
   * Jumps the database's wall clock `ms` forward, for good.
   * @throws TypeError unless `ms` is a positive integer.
   */
  jump(ms: number): void;
  /** Every stored event, in offset order, or only `persistenceId`'s, read with no time passing. */
  events(persistenceId?: string): readonly StoredEvent[];
  /** What the database has done with calls so far. */
  counts(): DatabaseCounts;
}

const OPTIONS = new Set(['scheduler', 'random', 'latencyMs', 'clock', 'observe']);
const SLOW_OPTIONS = new Set(['node', 'latencyMs']);
const HANG_OPTIONS = new Set(['node']);
const RATE_OPTIONS = new Set(['node', 'rate']);

/**
 * Makes a simulated database on `scheduler`, empty, with no faults until they're injected.
 * @throws TypeError for options that can't be used.
 */
export function simulatedDatabase(opts: SimulatedDatabaseOptions): SimulatedDatabase {
  checkKeys(opts, OPTIONS, 'simulatedDatabase');
  const { scheduler, random, latencyMs = [1, 3] } = opts;
  const given: unknown = scheduler;
  if (typeof (given as { setTimer?: unknown } | null)?.setTimer !== 'function') {
    throw new TypeError('simulatedDatabase: scheduler must be a Scheduler');
  }
  const givenRandom: unknown = random;
  if (typeof givenRandom !== 'function') {
    throw new TypeError(`simulatedDatabase: random must be a function, got ${describe(random)}`);
  }
  const latency = checkRange(latencyMs, 'simulatedDatabase: latencyMs');
  const read = wallClock(opts.clock ?? (() => scheduler.now()), 'simulatedDatabase');
  const observe: unknown = opts.observe;
  if (observe !== undefined && typeof observe !== 'function') {
    throw new TypeError(`simulatedDatabase: observe must be a function, got ${describe(observe)}`);
  }
  const db = new Db(scheduler, random, latency, read, opts.observe);

  return {
    connect: (node, clock = scheduler) => db.connect(node, clock),
    now: () => db.now(),
    slow(sopts) {
      checkKeys(sopts, SLOW_OPTIONS, 'slow');
      const node = checkNode(sopts.node, 'slow');
      const range = checkRange(sopts.latencyMs, 'slow: latencyMs');
      return db.add(db.slows, { node, range });
    },
    hang(hopts = {}) {
      checkKeys(hopts, HANG_OPTIONS, 'hang');
      const rule = { node: checkNode(hopts.node, 'hang') };
      return db.add(db.hangs, rule, () => {
        db.letGo();
      });
    },
    fail(fopts = {}) {
      checkKeys(fopts, RATE_OPTIONS, 'fail');
      return db.add(db.failures, checkRateRule(fopts, 'fail'));
    },
    loseReplies(lopts = {}) {
      checkKeys(lopts, RATE_OPTIONS, 'loseReplies');
      return db.add(db.losses, checkRateRule(lopts, 'loseReplies'));
    },
    cutOff(node) {
      checkId(node, 'cutOff: node');
      return db.add(db.cuts, node);
    },
    jump(ms) {
      checkInt(ms, 'jump: ms');
      db.jumped += ms;
    },
    events: (persistenceId) => db.data.events(persistenceId),
    counts: () => ({ ...db.counters }),
  };
}

interface Rule {
  readonly node: string | undefined;
}

interface SlowRule extends Rule {
  readonly range: Range;
}

interface RateRule extends Rule {
  readonly rate: number;
}

/** A call's outcome, once the database has one. */
type Outcome =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

/** One node incarnation's connection. */
interface Client {
  readonly node: string;
  readonly clock: Scheduler;
  closed: boolean;
  // Calls made and not yet answered, in the order they were made.
  readonly pending: Set<Call>;
}

/** A call on its way: who made it, what it does once it reaches the data, and its caller's ends. */
interface Call {
  readonly client: Client;
  readonly op: string;
  readonly target: string;
  applied: boolean;
  // Whether the observer has heard of it, which it does once.
  observed: boolean;
  readonly apply: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const applies = (rule: Rule, node: string): boolean =>
  rule.node === undefined || rule.node === node;

class Db {
  jumped = 0;
  readonly slows: SlowRule[] = [];
  readonly hangs: Rule[] = [];
  readonly failures: RateRule[] = [];
  readonly losses: RateRule[] = [];
  readonly cuts: string[] = [];
  // What hangs hold, in the order it arrived.
  readonly held: Call[] = [];
  readonly counters = {
    calls: 0,
    applied: 0,
    failed: 0,
    refused: 0,
    hung: 0,
    lostReplies: 0,
    disconnected: 0,
    dropped: 0,
  };
  readonly data: ReturnType<typeof inMemoryPersistence>;
  readonly leases: ShardStore;

  constructor(
    readonly scheduler: Scheduler,
    readonly random: () => number,
    readonly latency: Range,
    readonly wall: () => number,
    readonly observe: ((call: DatabaseCall) => void) | undefined,
  ) {
    const clock = (): number => this.now();
    this.data = inMemoryPersistence({ clock });
    this.leases = inMemoryShardStore({ clock });
  }

  now(): number {
    return this.wall() + this.jumped;
  }

  /** Adds `rule` to `rules` until the returned function takes it out again, and calls `then`. */
  add<T>(rules: T[], rule: T, then?: () => void): () => void {
    rules.push(rule);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      rules.splice(rules.indexOf(rule), 1);
      then?.();
    };
  }

  connect(node: string, clock: Scheduler): DatabaseClient {
    checkId(node, 'simulatedDatabase.connect: node');
    const given: unknown = clock;
    if (typeof (given as { runSoon?: unknown } | null)?.runSoon !== 'function') {
      throw new TypeError('simulatedDatabase.connect: clock must be a Scheduler');
    }
    const client: Client = { node, clock, closed: false, pending: new Set() };
    return {
      node,
      persistence: this.#persistence(client),
      shards: this.#shards(client),
      close: () => {
        if (client.closed) return;
        client.closed = true;
        const error = new Error(`${node}'s database client has closed`);
        // Each is observed once its request lands, when it's known whether it was applied.
        for (const call of client.pending) this.#hand(call, { ok: false, error }, 'closed', false);
      },
    };
  }

  /**
   * Makes a call: `check` runs now, and rejects the call at once if its arguments are bad, as a
   * driver does before sending. `apply` runs once the request reaches the database.
   */
  call<T>(client: Client, op: string, target: string, check: () => () => Promise<T>): Promise<T> {
    if (client.closed) {
      return Promise.reject(new Error(`${client.node}'s database client has closed`));
    }
    let apply: () => Promise<T>;
    try {
      apply = check();
    } catch (error) {
      // The argument checks only ever throw TypeError.
      return Promise.reject(error instanceof Error ? error : new TypeError(String(error)));
    }
    this.counters.calls++;
    return new Promise<T>((resolve, reject) => {
      const call: Call = {
        client,
        op,
        target,
        applied: false,
        observed: false,
        apply,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      client.pending.add(call);
      this.scheduler.setTimer(() => {
        this.arrive(call);
      }, this.#latency(client.node));
    });
  }

  /** A request reaches the database: refused, held, failed, or applied. */
  arrive(call: Call): void {
    const { node } = call.client;
    if (this.cuts.includes(node)) {
      this.counters.refused++;
      this.#hand(call, { ok: false, error: new Error(`${node} cannot reach the database`) });
      return;
    }
    if (this.hangs.some((rule) => applies(rule, node))) {
      this.counters.hung++;
      this.held.push(call);
      return;
    }
    if (this.#chance(this.failures, node)) {
      this.counters.failed++;
      this.#reply(call, { ok: false, error: new Error(`the database failed ${call.op}`) });
      return;
    }
    this.counters.applied++;
    call.applied = true;
    call.apply().then(
      (value) => {
        this.#reply(call, { ok: true, value });
      },
      (error: unknown) => {
        this.#reply(call, { ok: false, error });
      },
    );
  }

  /** A hang ended: the calls no hang still holds go on, in the order they arrived. */
  letGo(): void {
    const calls = this.held.splice(0);
    for (const call of calls) {
      if (this.hangs.some((rule) => applies(rule, call.client.node))) this.held.push(call);
      else this.arrive(call);
    }
  }

  // Sends the reply on its way, unless it's lost.
  #reply(call: Call, outcome: Outcome): void {
    const { node } = call.client;
    if (this.#chance(this.losses, node)) {
      this.counters.lostReplies++;
      this.#observe(call, outcome.ok, 'lost');
      return;
    }
    this.scheduler.setTimer(() => {
      if (this.cuts.includes(node)) {
        this.counters.disconnected++;
        this.#hand(
          call,
          { ok: false, error: new Error(`${node}'s connection to the database was lost`) },
          'disconnected',
        );
        return;
      }
      this.#hand(call, outcome);
    }, this.#latency(node));
  }

  // Hands the outcome to the caller, through its node's clock, unless it has had one already.
  #hand(
    call: Call,
    outcome: Outcome,
    reply: DatabaseCall['reply'] = 'delivered',
    observe = true,
  ): void {
    const { client } = call;
    if (!client.pending.delete(call)) {
      this.counters.dropped++;
      this.#observe(call, outcome.ok, 'closed');
      return;
    }
    if (observe) this.#observe(call, outcome.ok, reply);
    client.clock.runSoon(() => {
      if (outcome.ok) call.resolve(outcome.value);
      else call.reject(outcome.error);
    });
  }

  #observe(call: Call, ok: boolean, reply: DatabaseCall['reply']): void {
    if (call.observed) return;
    call.observed = true;
    const { client, op, target, applied } = call;
    this.observe?.({ node: client.node, op, target, applied, ok, reply });
  }

  #latency(node: string): number {
    let ms = draw(this.random, this.latency);
    for (const rule of this.slows) {
      if (applies(rule, node)) ms = Math.max(ms, draw(this.random, rule.range));
    }
    return ms;
  }

  #chance(rules: readonly RateRule[], node: string): boolean {
    let hit = false;
    for (const rule of rules) if (applies(rule, node) && this.random() < rule.rate) hit = true;
    return hit;
  }

  #persistence(client: Client): Required<Persistence> {
    const { journal, snapshots, offsets } = this.data;
    const call = <T>(op: string, check: () => () => Promise<T>, target = ''): Promise<T> =>
      this.call(client, op, target, check);
    const j: Journal = {
      append: (persistenceId, expectedSeq, events) =>
        call(
          'journal.append',
          () => {
            // Copied now, as a driver serializes before sending, so the caller can't change them.
            const batch: NewEvent[] = checkAppend(persistenceId, expectedSeq, events).map(
              ({ version, tags, json }) => ({ event: JSON.parse(json) as unknown, version, tags }),
            );
            return () => journal.append(persistenceId, expectedSeq, batch);
          },
          `${persistenceId}@${String(expectedSeq)}+${String(Array.isArray(events) ? events.length : 0)}`,
        ),
      read: (persistenceId, fromSeq, limit) =>
        call('journal.read', () => {
          checkRead(persistenceId, fromSeq, limit);
          return () => journal.read(persistenceId, fromSeq, limit);
        }),
      readByTag: (tag, afterOffset, limit) =>
        call('journal.readByTag', () => {
          checkReadByTag(tag, afterOffset, limit);
          return () => journal.readByTag(tag, afterOffset, limit);
        }),
    };
    const s: SnapshotStore = {
      save: (persistenceId, snapshot) =>
        call('snapshots.save', () => {
          const { seq, version, json } = serializeSnapshot(persistenceId, snapshot);
          const copy = { seq, version, state: JSON.parse(json) as unknown };
          return () => snapshots.save(persistenceId, copy);
        }),
      load: (persistenceId) =>
        call('snapshots.load', () => {
          checkId(persistenceId, 'snapshots.load: persistenceId');
          return () => snapshots.load(persistenceId);
        }),
    };
    const o: OffsetStore = {
      load: (name) =>
        call('offsets.load', () => {
          checkId(name, 'offsets.load: name');
          return () => offsets.load(name);
        }),
      save: (name, offset) =>
        call('offsets.save', () => {
          checkOffsetSave(name, offset);
          return () => offsets.save(name, offset);
        }),
    };
    return { journal: j, snapshots: s, offsets: o };
  }

  #shards(client: Client): ShardStore {
    const store = this.leases;
    const call = <T>(op: string, check: () => () => Promise<T>, target = ''): Promise<T> =>
      this.call(client, op, target, check);
    return {
      acquire: (lease, holder, ttlMs) =>
        call(
          'shards.acquire',
          () => {
            checkAcquire(lease, holder, ttlMs);
            return () => store.acquire(lease, holder, ttlMs);
          },
          lease,
        ),
      renewAll: (holder, ttlMs) =>
        call(
          'shards.renewAll',
          () => {
            checkRenewAll(holder, ttlMs);
            return () => store.renewAll(holder, ttlMs);
          },
          holder,
        ),
      release: (lease, holder, token) =>
        call(
          'shards.release',
          () => {
            checkRelease(lease, holder, token);
            return () => store.release(lease, holder, token);
          },
          lease,
        ),
      holders: (prefix) =>
        call('shards.holders', () => {
          checkPrefix(prefix);
          return () => store.holders(prefix);
        }),
      remember: (shard, id) =>
        call('shards.remember', () => {
          checkEntity(shard, id, 'remember');
          return () => store.remember(shard, id);
        }),
      forget: (shard, id) =>
        call('shards.forget', () => {
          checkEntity(shard, id, 'forget');
          return () => store.forget(shard, id);
        }),
      remembered: (shard) =>
        call('shards.remembered', () => {
          checkId(shard, 'remembered: shard');
          return () => store.remembered(shard);
        }),
    };
  }
}

function checkNode(node: unknown, where: string): string | undefined {
  if (node === undefined) return undefined;
  checkId(node, `${where}: node`);
  return node as string;
}

function checkRateRule(opts: { node?: unknown; rate?: unknown }, where: string): RateRule {
  return {
    node: checkNode(opts.node, where),
    rate: opts.rate === undefined ? 1 : checkRate(opts.rate, where),
  };
}
