// A scenario and its runs (milestone 5, T5). A scenario is a value: nodes, a setup that each node
// incarnation runs, a workload each client runs, which faults to draw, and which invariants to
// check. A run is a seed and a plan (decision 0034): the seed draws a plan unless one is given,
// and every stream the run draws from, so a run is a pure function of the two.
//
// A run builds one simulated world: a simulation clock, a clock per node incarnation, the
// simulated network and database, and the run loop (0033). It carries out the plan, drives the
// workload on simulation time, records the history, and checks the invariants against it.
//
// A node's process ends when a fault kills it, or when it has left the cluster, gracefully or
// because it was downed, as a real process exits then. A process manager starts it again, as a
// new incarnation: after the fault's time for a kill or a leave, and otherwise after
// `restartAfterMs`. What's left of an ended process in this one is paused for good, so none of
// its timers or tasks run again, as none of a dead process's do.

import { checkId, checkInt, checkKeys, describe } from '../checks.js';
import { joinCluster, type Cluster } from '../cluster/membership.js';
import type { ShardStore } from '../cluster/shard-store.js';
import type { Transport } from '../cluster/transport.js';
import { checkLeases, type EntityType, type LeaseOptions } from '../cluster/sharding.js';
import { plant, type Plant } from '../internal.js';
import { silentLogger, type Logger } from '../logger.js';
import type { Persistence } from '../persistence/types.js';
import { createSystem, type SystemHandle } from '../system.js';
import { ManualScheduler } from '../testkit/manual-scheduler.js';
import type { ActorRef, ActorSystem, SystemEvent } from '../types.js';
import { NodeClock, throughClock } from './clock.js';
import { simulatedDatabase, type DatabaseClient, type SimulatedDatabase } from './database.js';
import { entityOf, toJson, type EventEntry, type History, type HistoryEntry } from './history.js';
import { checkInvariants, type Invariant, type Violation } from './invariants.js';
import { RunLoop } from './loop.js';
import { simulatedNetwork, type NetworkMode, type SimulatedNetwork } from './network.js';
import {
  checkFaults,
  checkPlan,
  drawPlan,
  endOf,
  type CheckedFaults,
  type Fault,
  type FaultOptions,
  type FaultPlan,
  type LeaveFault,
  type PlanWorld,
} from './plan.js';
import { grantsHeldLeases } from './plants.js';
import { checkRange, draw, type Range } from './ranges.js';
import { decodeReplay, encodeReplay } from './replay.js';
import { pick, stream } from './streams.js';

/** Chance, drawn from a client's workload stream. */
export interface Chance {
  /** A number in `[0, 1)`. */
  readonly next: () => number;
  /** One of `items`, which must not be empty. */
  readonly pick: <T>(items: readonly T[]) => T;
  /** A whole number from `min` to `max`, both included. */
  readonly int: (min: number, max: number) => number;
}

/** An entity an operation is on: its type and id, wherever it lives. */
export interface EntityHandle<M> {
  readonly type: string;
  readonly id: string;
  /** Never set: it only carries the entity's message type. */
  readonly messages?: M;
}

/** What a scenario's `workload` gets, each time a client runs it. */
export interface WorkloadContext {
  /** The client running it. */
  readonly client: string;
  /** Simulation time, in ms. */
  readonly now: number;
  /** The client's workload stream. Draw only from this, so the workload repeats from the seed. */
  readonly chance: Chance;
  /** The entity of type `type` with this id. */
  readonly entity: <M>(type: string, id: string) => EntityHandle<M>;
  /**
   * Starts an operation called `name` on `entity`, which the history records: when it began,
   * every message `run` sends through the ref it's given, and how it ended. `run`'s promise
   * resolving is `ok`, with its value as the reply. Rejecting with an ask's timeout is `unknown`,
   * since the operation may or may not have happened, and with anything else, `failed`.
   */
  readonly op: <M, R>(
    name: string,
    entity: EntityHandle<M>,
    run: (ref: ActorRef<M>) => Promise<R>,
  ) => void;
}

/** What a scenario's `setup` gets, on every incarnation of every node. */
export interface SetupContext {
  /** The node's name, which is its address. */
  readonly node: string;
  /** Which incarnation of the node this is, from 0. */
  readonly inc: number;
  /** Whether the node is a client: it routes and runs the workload, and hosts nothing. */
  readonly client: boolean;
  readonly system: ActorSystem;
  /** The node's place in the cluster. */
  readonly cluster: Cluster;
  /** The run's database, as this incarnation reaches it. */
  readonly db: { readonly persistence: () => Persistence };
}

/** The entity types a setup registered, so operations can find them by name. */
export type SetupResult = undefined | EntityType<never> | readonly EntityType<never>[];

/** The cluster each node joins: `joinCluster`'s timings and lease options. */
export interface ScenarioCluster {
  /** Default `rehearsal`. */
  name?: string;
  heartbeatMs?: number;
  unreachableAfterMs?: number;
  downAfterMs?: number;
  seedTimeoutMs?: number;
  leases?: LeaseOptions;
}

/** Options for {@link scenario}. */
export interface ScenarioOptions {
  /** The nodes that host shards and start at once. The first is the first seed. */
  nodes: readonly string[];
  /** Nodes that host shards but start only when a plan joins them. Default none. */
  spares?: readonly string[];
  /** Nodes that route and run the workload, and host nothing. Default none. */
  clients?: readonly string[];
  /** How long a run lasts, in ms of simulation time. */
  durationMs: number;
  /**
   * How long the run ends with no fault, in ms, so the cluster can show it recovers. Default a
   * third of `durationMs`, and at most 20,000.
   */
  quietMs?: number;
  cluster?: ScenarioCluster;
  /** Registers the entity types on each node incarnation, and returns them. */
  setup: (ctx: SetupContext) => SetupResult;
  /** Run by each client every `everyMs`, to start its operations. Default none. */
  workload?: (ctx: WorkloadContext) => void;
  /** The range each client's time between workload runs is drawn from, in ms. Default `[50, 250]`. */
  everyMs?: readonly [number, number];
  /** How far each incarnation's clock drifts at most, drawn as it starts, in ppm. Default 200. */
  driftPpm?: number;
  /** How long after a node exits on its own it starts again, in ms. Default 2,000. */
  restartAfterMs?: number;
  /** The simulated network's latency and reset timing. */
  network?: { latencyMs?: readonly [number, number]; resetAfterMs?: number };
  /** The simulated database's latency. */
  database?: { latencyMs?: readonly [number, number] };
  /** Which faults each seed's plan draws. Default none. */
  faults?: FaultOptions;
  /** What each run is checked for. Default none. */
  invariants?: readonly Invariant[];
  /** How long an actor may be busy on one message before the run stalls. Default 30,000. */
  stallAfterMs?: number;
}

/**
 * How to run a scenario once: a seed, with a plan in place of the one it draws and a time to cut
 * the run short at if you like, or a replay line, which holds all three.
 */
export type RunOptions =
  | {
      readonly seed: number;
      readonly plan?: FaultPlan;
      /**
       * Where to end the run, in ms of simulation time, if before `durationMs`. Everything up to
       * then happens as it would in the whole run. Shrinking cuts a failing run short this way.
       */
      readonly untilMs?: number;
    }
  | {
      /** A run's {@link Run.replay} line, which replays it exactly. */
      readonly replay: string;
    };

/** One run of a scenario: its seed and plan, what happened, and what broke. */
export interface Run {
  readonly seed: number;
  readonly plan: FaultPlan;
  /** Where the run ended, in ms of simulation time: `durationMs` unless it was cut short. */
  readonly untilMs: number;
  readonly history: History;
  /** What the invariants found. */
  readonly violations: readonly Violation[];
  /**
   * Overlaps `oneLiveInstance` found in a run whose clocks went past the lease's margin, which
   * decision 0029 says it can't promise against, while the journal held: no acknowledged write
   * lost and no stale read. Counted apart, since they're a stated limit rather than a bug.
   */
  readonly expected: readonly Violation[];
  /**
   * One line that replays this run exactly: its seed, plan and end, and its first violation,
   * which a replay checks it finds again. Pass it to `run({ replay })` or {@link replay}.
   */
  readonly replay: string;
}

/** A scenario, ready to run. */
export interface Scenario {
  /** The network mode its runs use, from `faults.network`. */
  readonly mode: NetworkMode;
  /**
   * Runs it once: from `seed`, with `plan` in place of the one the seed draws, or from a replay
   * line.
   * @throws TypeError for a seed, plan, end or line that can't be run, before anything starts,
   * a line from a scenario in another network mode included.
   * @throws StallError if an actor waits on something outside the simulation.
   */
  run(opts: RunOptions): Promise<Run>;
  /** The plan `seed` draws. */
  plan(seed: number): FaultPlan;
}

/** What tests set that users can't: ways to plant a bug in what each node reaches. */
export interface ScenarioInternals {
  /** Wraps the shard store each node incarnation sees. */
  wrapStore?: (store: ShardStore, node: string) => ShardStore;
  /** Wraps the transport each node incarnation sees, under its clock. */
  wrapTransport?: (transport: Transport, node: string) => Transport;
  /** A bug to plant on every node incarnation (T6). */
  plant?: Plant;
  /**
   * Each node incarnation's logger, given its node, incarnation and the simulation's time, for
   * following a run while hunting (T7). Default silent.
   */
  logger?: (node: string, inc: number, now: () => number) => Logger;
}

const OPTIONS = new Set([
  'nodes',
  'spares',
  'clients',
  'durationMs',
  'quietMs',
  'cluster',
  'setup',
  'workload',
  'everyMs',
  'driftPpm',
  'restartAfterMs',
  'network',
  'database',
  'faults',
  'invariants',
  'stallAfterMs',
]);
const CLUSTER_OPTIONS = new Set([
  'name',
  'heartbeatMs',
  'unreachableAfterMs',
  'downAfterMs',
  'seedTimeoutMs',
  'leases',
]);
const RUN_OPTIONS = new Set(['seed', 'plan', 'untilMs']);
const REPLAY_OPTIONS = new Set(['replay']);

interface Checked {
  readonly nodes: readonly string[];
  readonly spares: readonly string[];
  readonly clients: readonly string[];
  readonly durationMs: number;
  readonly quietFrom: number;
  readonly cluster: Omit<ScenarioCluster, 'leases' | 'name'>;
  readonly clusterName: string;
  readonly leases: Required<LeaseOptions>;
  readonly setup: (ctx: SetupContext) => SetupResult;
  readonly workload: ((ctx: WorkloadContext) => void) | undefined;
  readonly every: Range;
  readonly driftPpm: number;
  readonly restartAfterMs: number;
  readonly network: { latencyMs?: readonly [number, number]; resetAfterMs?: number };
  readonly database: { latencyMs?: readonly [number, number] };
  readonly faults: CheckedFaults;
  readonly invariants: readonly Invariant[];
  readonly stallAfterMs: number | undefined;
  readonly world: PlanWorld;
}

/**
 * Makes a scenario: nodes, a setup, a workload, faults and invariants, checked here.
 * @throws TypeError for options that can't be used, unknown ones included, and for an invariant
 * that can't be checked in the scenario's network mode.
 */
export function scenario(opts: ScenarioOptions): Scenario {
  return scenarioWith(opts, {});
}

/** What rehearse needs to know of a scenario that its public face keeps to itself. */
export interface ScenarioInfo {
  readonly durationMs: number;
  /** When the quiet tail begins, which every fault must end by. */
  readonly quietFrom: number;
  readonly plant: Plant | undefined;
}

const infos = new WeakMap<Scenario, ScenarioInfo>();

/**
 * What rehearse needs to know of `s`.
 * @throws TypeError for a scenario `scenario()` didn't make.
 */
export function scenarioInfo(s: Scenario): ScenarioInfo {
  const info = infos.get(s);
  if (info === undefined) throw new TypeError('rehearse: not a scenario made by scenario()');
  return info;
}

/** {@link scenario}, with what only tests set. */
export function scenarioWith(opts: ScenarioOptions, internals: ScenarioInternals): Scenario {
  const checked = checkOptions(opts);
  const made: Scenario = {
    mode: checked.faults.mode,
    plan: (seed) => {
      checkSeed(seed);
      return drawPlan(stream(seed, 'plan'), checked.world, checked.faults);
    },
    run: async (ropts) => {
      const { seed, plan, untilMs } = runOptions(ropts, checked, internals);
      const world = new World(checked, internals, seed, plan, untilMs);
      const history = await world.run();
      const { violations, expected } = checkInvariants(checked.invariants, history);
      const first = violations[0];
      const replay = encodeReplay({
        seed,
        mode: checked.faults.mode,
        plan,
        ...(untilMs < checked.durationMs ? { untilMs } : {}),
        ...(internals.plant === undefined ? {} : { plant: internals.plant }),
        ...(first === undefined
          ? {}
          : { violation: { invariant: first.invariant, message: first.message } }),
      });
      return { seed, plan, untilMs, history, violations, expected, replay };
    },
  };
  infos.set(made, {
    durationMs: checked.durationMs,
    quietFrom: checked.quietFrom,
    plant: internals.plant,
  });
  return made;
}

/** A run's seed, checked plan and end, from its options or its replay line. */
function runOptions(
  ropts: RunOptions,
  checked: Checked,
  internals: ScenarioInternals,
): { seed: number; plan: FaultPlan; untilMs: number } {
  const raw: unknown = ropts;
  if (typeof raw === 'object' && raw !== null && 'replay' in raw) {
    checkKeys(raw, REPLAY_OPTIONS, 'run');
    const line = decodeReplay(raw.replay);
    if (line.mode !== checked.faults.mode) {
      throw new TypeError(
        `run: this line was recorded with the network in ${line.mode} mode, and this scenario's is in ${checked.faults.mode} mode`,
      );
    }
    if (line.plant !== internals.plant) {
      throw new TypeError(
        line.plant === undefined
          ? `run: this line was recorded with no bug planted, and this scenario has ${String(internals.plant)} planted`
          : `run: this line was recorded with the bug ${line.plant} planted, and this scenario doesn't plant it`,
      );
    }
    return runOptions(
      {
        seed: line.seed,
        plan: line.plan,
        ...(line.untilMs === undefined ? {} : { untilMs: line.untilMs }),
      },
      checked,
      internals,
    );
  }
  checkKeys(ropts, RUN_OPTIONS, 'run');
  // Not a replay line, which was handled above.
  const opts = ropts as Extract<RunOptions, { readonly seed: number }>;
  const { seed } = opts;
  checkSeed(seed);
  const untilMs = opts.untilMs ?? checked.durationMs;
  checkInt(untilMs, 'run: untilMs');
  if (untilMs > checked.durationMs) {
    throw new TypeError(
      `run: untilMs must be at most durationMs, ${String(checked.durationMs)}, got ${String(untilMs)}`,
    );
  }
  const plan =
    opts.plan === undefined
      ? drawPlan(stream(seed, 'plan'), checked.world, checked.faults)
      : checkPlan(opts.plan, checked.world);
  return { seed, plan, untilMs };
}

function checkSeed(seed: unknown): void {
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) {
    throw new TypeError(`run: seed must be a safe integer, got ${describe(seed)}`);
  }
}

function checkNames(value: unknown, what: string, min: number): readonly string[] {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.length < min) {
    throw new TypeError(
      `scenario: ${what} must be a list of node names${min > 0 ? ', not empty' : ''}, got ${describe(value)}`,
    );
  }
  for (const name of value as unknown[]) checkId(name, `scenario: ${what}`);
  return [...(value as string[])];
}

function checkOptions(opts: ScenarioOptions): Checked {
  checkKeys(opts, OPTIONS, 'scenario');
  const nodes = checkNames(opts.nodes, 'nodes', 1);
  const spares = checkNames(opts.spares, 'spares', 0);
  const clients = checkNames(opts.clients, 'clients', 0);
  const all = [...nodes, ...spares, ...clients];
  const twice = all.find((name, i) => all.indexOf(name) !== i);
  if (twice !== undefined) throw new TypeError(`scenario: ${twice} is named more than once`);
  checkInt(opts.durationMs, 'scenario: durationMs');
  const { durationMs } = opts;
  const quietMs = opts.quietMs ?? Math.min(20_000, Math.floor(durationMs / 3));
  checkInt(quietMs, 'scenario: quietMs', { min: 0 });
  if (quietMs > durationMs) {
    throw new TypeError(`scenario: quietMs must be at most durationMs, got ${String(quietMs)}`);
  }
  const cluster = opts.cluster ?? {};
  checkKeys(cluster, CLUSTER_OPTIONS, 'scenario: cluster');
  const { name: clusterName = 'rehearsal', leases: leaseOpts, ...timings } = cluster;
  const leases = checkLeases(leaseOpts);
  if (typeof opts.setup !== 'function') {
    throw new TypeError(`scenario: setup must be a function, got ${describe(opts.setup)}`);
  }
  const workload: unknown = opts.workload;
  if (workload !== undefined && typeof workload !== 'function') {
    throw new TypeError(`scenario: workload must be a function, got ${describe(workload)}`);
  }
  const every = checkRange(opts.everyMs ?? [50, 250], 'scenario: everyMs');
  if (every[0] < 1) throw new TypeError('scenario: everyMs must start at 1 ms or more');
  const driftPpm = opts.driftPpm ?? 200;
  checkInt(driftPpm, 'scenario: driftPpm', { min: 0 });
  if (driftPpm > 100_000) {
    throw new TypeError(`scenario: driftPpm must be at most 100,000, got ${String(driftPpm)}`);
  }
  const restartAfterMs = opts.restartAfterMs ?? 2_000;
  checkInt(restartAfterMs, 'scenario: restartAfterMs');
  const network = opts.network ?? {};
  checkKeys(network, new Set(['latencyMs', 'resetAfterMs']), 'scenario: network');
  const database = opts.database ?? {};
  checkKeys(database, new Set(['latencyMs']), 'scenario: database');
  const faults = checkFaults(opts.faults, spares.length);
  const invariants = opts.invariants ?? [];
  if (!Array.isArray(invariants)) {
    throw new TypeError(`scenario: invariants must be a list, got ${describe(invariants)}`);
  }
  for (const inv of invariants as unknown[]) {
    const i = inv as Partial<Invariant> | null;
    if (typeof i?.name !== 'string' || typeof i.check !== 'function') {
      throw new TypeError('scenario: each invariant must have a name and a check function');
    }
    if (i.modes !== undefined && !i.modes.includes(faults.mode)) {
      throw new TypeError(
        `scenario: ${i.name} can't be checked with the network in ${faults.mode} mode, which ` +
          'breaks the Transport contract it rests on (decision 0035)',
      );
    }
  }
  if (opts.stallAfterMs !== undefined) checkInt(opts.stallAfterMs, 'scenario: stallAfterMs');
  const quietFrom = durationMs - quietMs;
  return {
    nodes,
    spares,
    clients,
    durationMs,
    quietFrom,
    cluster: timings,
    clusterName,
    leases,
    setup: opts.setup,
    workload: opts.workload,
    every,
    driftPpm,
    restartAfterMs,
    network,
    database,
    faults,
    invariants,
    stallAfterMs: opts.stallAfterMs,
    world: {
      hosts: [...nodes, ...spares],
      spares,
      clients,
      mode: faults.mode,
      quietFrom,
      maxJumpMs: Math.max(1, leases.marginMs),
    },
  };
}

/** One incarnation of a node. */
interface Incarnation {
  readonly node: string;
  readonly inc: number;
  /** `<address>#<uid>`, how refs from it read in the history. */
  readonly self: string;
  readonly driftPpm: number;
  readonly clock: NodeClock;
  readonly handle: SystemHandle;
  readonly cluster: Cluster;
  readonly client: DatabaseClient;
  readonly types: Map<string, EntityType<never>>;
  ended: boolean;
}

/** A node's name, and whichever incarnation of it is running. */
interface Slot {
  readonly name: string;
  readonly client: boolean;
  current: Incarnation | undefined;
  incarnations: number;
  // When a process manager starts it next, and how to call that off.
  cancelRestart: (() => void) | undefined;
}

/** One run's world: everything it simulates, and the history it records. */
class World {
  readonly #o: Checked;
  readonly #internals: ScenarioInternals;
  readonly #seed: number;
  readonly #plan: FaultPlan;
  readonly #untilMs: number;
  readonly #sim = new ManualScheduler({ maxSteps: 10_000_000 });
  readonly #loop: RunLoop;
  readonly #network: SimulatedNetwork;
  readonly #db: SimulatedDatabase;
  readonly #slots = new Map<string, Slot>();
  readonly #history: HistoryEntry[] = [];
  #ops = 0;

  constructor(
    o: Checked,
    internals: ScenarioInternals,
    seed: number,
    plan: FaultPlan,
    untilMs: number,
  ) {
    this.#o = o;
    this.#internals = internals;
    this.#seed = seed;
    this.#plan = plan;
    this.#untilMs = untilMs;
    this.#loop = new RunLoop(
      this.#sim,
      o.stallAfterMs === undefined ? {} : { stallAfterMs: o.stallAfterMs },
    );
    this.#network = simulatedNetwork({
      ...o.network,
      scheduler: this.#sim,
      random: stream(seed, 'network'),
      mode: o.faults.mode,
    });
    this.#db = simulatedDatabase({
      ...o.database,
      scheduler: this.#sim,
      random: stream(seed, 'database'),
      observe: (call) => {
        if (!RECORDED_CALLS.has(call.op)) return;
        this.#history.push({ kind: 'db', time: this.#sim.now(), ...call });
      },
    });
    for (const name of [...o.nodes, ...o.spares]) this.#slot(name, false);
    for (const name of o.clients) this.#slot(name, true);
  }

  async run(): Promise<History> {
    const o = this.#o;
    this.#history.push({
      kind: 'run',
      time: 0,
      seed: this.#seed,
      mode: o.faults.mode,
      nodes: o.nodes,
      spares: o.spares,
      clients: o.clients,
      durationMs: o.durationMs,
      quietFrom: o.quietFrom,
      leases: { ttlMs: o.leases.ttlMs, renewMs: o.leases.renewMs, marginMs: o.leases.marginMs },
      plan: this.#plan,
      ...(this.#untilMs < o.durationMs ? { untilMs: this.#untilMs } : {}),
    });
    for (const name of [...o.nodes, ...o.clients]) this.#start(name);
    for (const [index, fault] of this.#plan.entries()) {
      this.#sim.setTimer(() => {
        this.#begin(index, fault);
      }, fault.at);
    }
    if (o.workload !== undefined) {
      for (const client of o.clients) this.#drive(client, o.workload);
    }
    await this.#loop.runUntil(this.#untilMs);
    this.#history.push({
      kind: 'journal',
      time: this.#sim.now(),
      events: this.#db.events().map((e) => ({
        persistenceId: e.persistenceId,
        seq: e.seq,
        event: toJson(e.event, ''),
      })),
    });
    return this.#history;
  }

  #slot(name: string, client: boolean): void {
    this.#slots.set(name, {
      name,
      client,
      current: undefined,
      incarnations: 0,
      cancelRestart: undefined,
    });
  }

  #get(name: string): Slot {
    const slot = this.#slots.get(name);
    // Plans are checked against the scenario's names, so every name has a slot.
    if (slot === undefined) throw new Error(`no node ${name}`);
    return slot;
  }

  // Starts a new incarnation of a node that isn't running.
  #start(name: string): void {
    const slot = this.#get(name);
    if (slot.current !== undefined) return;
    slot.cancelRestart?.();
    slot.cancelRestart = undefined;
    const inc = slot.incarnations++;
    const o = this.#o;
    const driftPpm = Math.round(
      (stream(this.#seed, `clock ${name} ${String(inc)}`)() * 2 - 1) * o.driftPpm,
    );
    const clock = new NodeClock(this.#sim, { driftPpm });
    const handle = createSystem({
      name: 'node',
      scheduler: clock,
      random: stream(this.#seed, `node ${name} ${String(inc)}`),
      logger: this.#internals.logger?.(name, inc, () => this.#sim.now()) ?? silentLogger,
    });
    const bug = this.#internals.plant;
    if (bug !== undefined) plant(handle.system, bug);
    const raw = this.#network.transport(name);
    const wrapped =
      this.#internals.wrapTransport === undefined ? raw : this.#internals.wrapTransport(raw, name);
    const transport = throughClock(wrapped, clock);
    const client = this.#db.connect(name, clock);
    const own =
      this.#internals.wrapStore === undefined
        ? client.shards
        : this.#internals.wrapStore(client.shards, name);
    const shards = bug === 'grants-held' ? grantsHeldLeases(own) : own;
    const cluster = joinCluster(handle.system, {
      ...o.cluster,
      name: o.clusterName,
      transport,
      seeds: o.nodes,
      shards,
      leases: o.leases,
    });
    const self = `${name}#${String(cluster.self.uid)}`;
    const incarnation: Incarnation = {
      node: name,
      inc,
      self,
      driftPpm,
      clock,
      handle,
      cluster,
      client,
      types: new Map(),
      ended: false,
    };
    slot.current = incarnation;
    this.#loop.watch(handle, clock, name);
    this.#history.push({
      kind: 'start',
      time: this.#sim.now(),
      node: name,
      inc,
      uid: cluster.self.uid,
      driftPpm,
    });
    handle.system.events.subscribe(
      (event) => {
        this.#record(incarnation, event);
      },
      { messages: true },
    );
    // A node that never got in, or was downed, exits, and its process manager starts it again.
    cluster.whenUp.catch(() => {
      this.#exit(incarnation);
    });
    const result = o.setup({
      node: name,
      inc,
      client: slot.client,
      system: handle.system,
      cluster,
      db: { persistence: () => client.persistence },
    });
    const types: readonly EntityType<never>[] =
      result === undefined ? [] : Array.isArray(result) ? result : [result as EntityType<never>];
    for (const type of types) incarnation.types.set(type.type, type);
  }

  #record(incarnation: Incarnation, event: SystemEvent): void {
    if (incarnation.ended) return;
    if (event.type === 'processed') return;
    if (event.type === 'delivered' && entityOf(event.path) === undefined) return;
    const entry: EventEntry = {
      kind: 'event',
      time: this.#sim.now(),
      node: incarnation.node,
      inc: incarnation.inc,
      event: toJson(event, incarnation.self) as EventEntry['event'],
    };
    this.#history.push(entry);
    if (
      event.type === 'memberDown' &&
      event.address === incarnation.node &&
      `${event.address}#${String(event.uid)}` === incarnation.self
    ) {
      // Downed, it has left the cluster: it can only come back as a new incarnation.
      this.#exit(incarnation);
    }
  }

  // Ends an incarnation's process. Paused for good, nothing of it runs again.
  #end(incarnation: Incarnation, why: 'killed' | 'exited'): void {
    if (incarnation.ended) return;
    incarnation.ended = true;
    const slot = this.#get(incarnation.node);
    if (slot.current === incarnation) slot.current = undefined;
    incarnation.clock.pause();
    this.#loop.unwatch(incarnation.handle);
    this.#network.kill(incarnation.node);
    incarnation.client.close();
    this.#history.push({
      kind: 'stop',
      time: this.#sim.now(),
      node: incarnation.node,
      inc: incarnation.inc,
      why,
    });
  }

  // A process that exits on its own is started again after restartAfterMs.
  #exit(incarnation: Incarnation): void {
    if (incarnation.ended) return;
    this.#end(incarnation, 'exited');
    this.#restartIn(incarnation.node, this.#o.restartAfterMs);
  }

  #restartIn(name: string, ms: number): void {
    const slot = this.#get(name);
    slot.cancelRestart?.();
    slot.cancelRestart = this.#sim.setTimer(() => {
      slot.cancelRestart = undefined;
      this.#start(name);
    }, ms);
  }

  #begin(index: number, fault: Fault): void {
    this.#history.push({ kind: 'fault', time: this.#sim.now(), index, phase: 'begin', fault });
    if ('leave' in fault) {
      this.#leave(fault, index);
      return;
    }
    const end = this.#apply(fault);
    this.#sim.setTimer(
      () => {
        end?.();
        this.#history.push({ kind: 'fault', time: this.#sim.now(), index, phase: 'end', fault });
      },
      endOf(fault) - fault.at,
    );
  }

  // Carries a fault out, and returns what ends it. Leaves have their own path.
  #apply(fault: Exclude<Fault, LeaveFault>): (() => void) | undefined {
    const net = this.#network;
    const db = this.#db;
    const link = (node: string, peer: string | undefined): { node: string; peer?: string } =>
      peer === undefined ? { node } : { node, peer };
    if ('kill' in fault) {
      const current = this.#get(fault.kill).current;
      if (current !== undefined) this.#end(current, 'killed');
      return () => {
        this.#start(fault.kill);
      };
    }
    if ('pause' in fault) {
      const current = this.#get(fault.pause).current;
      if (current === undefined || current.clock.paused) return undefined;
      current.clock.pause();
      return () => {
        if (!current.ended) current.clock.resume();
      };
    }
    if ('join' in fault) {
      this.#start(fault.join);
      return undefined;
    }
    if ('drift' in fault) {
      const current = this.#get(fault.drift).current;
      if (current === undefined) return undefined;
      current.clock.setDrift(fault.ppm);
      return () => {
        if (!current.ended) current.clock.setDrift(current.driftPpm);
      };
    }
    if ('partition' in fault) {
      const [a, b] = fault.partition;
      return net.partition(a, b, fault.oneWay === true ? { oneWay: true } : {});
    }
    if ('reset' in fault) {
      net.reset(fault.reset[0], fault.reset[1]);
      return undefined;
    }
    if ('delay' in fault)
      return net.delay({ ...link(fault.delay, fault.peer), latencyMs: fault.latencyMs });
    if ('reorder' in fault) {
      return net.reorder({
        ...link(fault.reorder, fault.peer),
        windowMs: fault.windowMs,
        ...(fault.within === true ? { within: true } : {}),
      });
    }
    if ('lose' in fault) return net.lose({ ...link(fault.lose, fault.peer), rate: fault.rate });
    if ('duplicate' in fault) {
      return net.duplicate({ ...link(fault.duplicate, fault.peer), rate: fault.rate });
    }
    if ('cut' in fault) return db.cutOff(fault.cut);
    if ('jump' in fault) {
      db.jump(fault.jump);
      return undefined;
    }
    const node = fault.node === undefined ? {} : { node: fault.node };
    switch (fault.disk) {
      case 'slow':
        return db.slow({ ...node, latencyMs: fault.latencyMs });
      case 'hang':
        return db.hang(node);
      case 'error':
        return db.fail({ ...node, rate: fault.rate });
      default:
        return db.loseReplies({ ...node, rate: fault.rate });
    }
  }

  // A graceful leave: the node hands its shards off and exits, then starts again once
  // rejoinAfterMs has passed since it began to leave, or as soon as it has left if that's later.
  #leave(fault: LeaveFault, index: number): void {
    const slot = this.#get(fault.leave);
    const current = slot.current;
    const rejoinAt = fault.at + fault.rejoinAfterMs;
    const rejoin = (): void => {
      this.#start(fault.leave);
      this.#history.push({ kind: 'fault', time: this.#sim.now(), index, phase: 'end', fault });
    };
    if (current === undefined) {
      this.#sim.setTimer(rejoin, rejoinAt - this.#sim.now());
      return;
    }
    const left = (): void => {
      if (current.ended) return;
      this.#end(current, 'exited');
      slot.cancelRestart?.();
      slot.cancelRestart = this.#sim.setTimer(
        () => {
          slot.cancelRestart = undefined;
          rejoin();
        },
        Math.max(0, rejoinAt - this.#sim.now()),
      );
    };
    current.cluster.leave().then(left, left);
  }

  // Runs a client's workload every so often, on simulation time, from the client's own stream.
  #drive(client: string, workload: (ctx: WorkloadContext) => void): void {
    const random = stream(this.#seed, `workload ${client}`);
    const chance: Chance = {
      next: random,
      pick: (items) => pick(random, items),
      int: (min, max) => draw(random, [min, max]),
    };
    const tick = (): void => {
      workload({
        client,
        now: this.#sim.now(),
        chance,
        entity: (type, id) => ({ type, id }),
        op: (name, entity, run) => {
          this.#op(client, name, entity, run);
        },
      });
      this.#sim.setTimer(tick, draw(random, this.#o.every));
    };
    this.#sim.setTimer(tick, draw(random, this.#o.every));
  }

  #op<M, R>(
    client: string,
    name: string,
    entity: EntityHandle<M>,
    run: (ref: ActorRef<M>) => Promise<R>,
  ): void {
    const op = this.#ops++;
    const time = (): number => this.#sim.now();
    this.#history.push({
      kind: 'invoke',
      time: time(),
      op,
      client,
      name,
      entity: { type: entity.type, id: entity.id },
    });
    const fail = (error: unknown): void => {
      this.#history.push({
        kind: 'complete',
        time: time(),
        op,
        outcome: isTimeout(error) ? 'unknown' : 'failed',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    };
    const current = this.#get(client).current;
    const type = current?.types.get(entity.type);
    if (current === undefined || type === undefined) {
      fail(
        new Error(current === undefined ? `${client} is down` : `no entity type ${entity.type}`),
      );
      return;
    }
    const inner = type.ref(entity.id) as unknown as ActorRef<M>;
    const sent = (message: M): void => {
      this.#history.push({
        kind: 'send',
        time: time(),
        op,
        client,
        message: toJson(message, current.self),
      });
    };
    const ref: ActorRef<M> = {
      path: inner.path,
      tell: (message) => {
        sent(message);
        inner.tell(message);
      },
      ask: (build, aopts) =>
        inner.ask((replyTo) => {
          const message = build(replyTo);
          sent(message);
          return message;
        }, aopts),
    };
    let promise: Promise<R>;
    try {
      promise = run(ref);
    } catch (error) {
      fail(error);
      return;
    }
    Promise.resolve(promise).then((reply) => {
      this.#history.push({
        kind: 'complete',
        time: time(),
        op,
        outcome: 'ok',
        reply: toJson(reply, current.self),
      });
    }, fail);
  }
}

/** The database calls a history records: appends and lease changes, not reads. */
const RECORDED_CALLS = new Set(['journal.append', 'shards.acquire', 'shards.release']);

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'AskTimeoutError';
}
