// Fault plans (decision 0034): a run's faults as plain JSON, in order of simulation time, so a plan
// prints, edits and shrinks. A seed draws one from the plan stream before the run starts, and a
// plan given explicitly replaces it. Every fault ends, and the last ends before the run's quiet
// tail, so `recovers` has time with no fault at all.

import { checkInt, checkKeys, describe } from '../checks.js';
import { checkRange, checkRate, draw, type Range } from './ranges.js';
import type { NetworkMode } from './network.js';
import { pick } from './streams.js';

/** A node killed, as `kill -9` does, and started again as a new incarnation after `restartAfterMs`. */
export interface KillFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node killed. */
  readonly kill: string;
  /** How long after the kill it starts again, in ms. */
  readonly restartAfterMs: number;
}

/** A node's process stopped for `ms`, as a long GC or a suspended VM does. Its clock goes on. */
export interface PauseFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node paused. */
  readonly pause: string;
  /** How long it's paused, in ms. */
  readonly ms: number;
}

/**
 * A node leaving gracefully, handing its shards off, and starting again as a new incarnation
 * `rejoinAfterMs` after it began to leave, or once it has left if that takes longer.
 */
export interface LeaveFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node that leaves. */
  readonly leave: string;
  /** How long after it begins to leave it starts again, in ms, at the soonest. */
  readonly rejoinAfterMs: number;
}

/** A spare node starting for the first time, and joining the cluster. It stays. */
export interface JoinFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The spare node that starts. */
  readonly join: string;
}

/** Frames between two sides lost or held, both ways or, with `oneWay`, from the first only. */
export interface PartitionFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The two sides, each a list of nodes. */
  readonly partition: readonly [readonly string[], readonly string[]];
  /** Only frames from the first side to the second are lost. Default both ways. */
  readonly oneWay?: true;
  /** How long the partition lasts, in ms. */
  readonly ms: number;
}

/** Every connection between two nodes reset, as a TCP reset does. */
export interface ResetFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The two nodes whose connections reset. */
  readonly reset: readonly [string, string];
}

/** The latency of everything to or from a node, or between it and `peer`, drawn from a range. */
export interface DelayFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node whose links are slow. */
  readonly delay: string;
  /** Only the links between that node and this one. Default all of its links. */
  readonly peer?: string;
  /** The range each latency is drawn from, as `[min, max]` in ms. */
  readonly latencyMs: readonly [number, number];
  /** How long the delay lasts, in ms. */
  readonly ms: number;
}

/**
 * Up to `windowMs` added to each latency on a node's links, so frames on different connections
 * overtake each other, and with `within`, in chaos mode only, frames on one connection too.
 */
export interface ReorderFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node whose links reorder. */
  readonly reorder: string;
  /** Only the links between that node and this one. Default all of its links. */
  readonly peer?: string;
  /** The most added to each latency, in ms. */
  readonly windowMs: number;
  /** Frames on one connection overtake each other too. Chaos mode only. */
  readonly within?: true;
  /** How long the reordering lasts, in ms. */
  readonly ms: number;
}

/** Single frames on a node's links lost, with chance `rate`. Chaos mode only. */
export interface LoseFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node whose links lose frames. */
  readonly lose: string;
  /** Only the links between that node and this one. Default all of its links. */
  readonly peer?: string;
  /** The chance each frame is lost, from 0 to 1. */
  readonly rate: number;
  /** How long frames are lost, in ms. */
  readonly ms: number;
}

/** Frames on a node's links sent twice, with chance `rate`. Chaos mode only. */
export interface DuplicateFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node whose links repeat frames. */
  readonly duplicate: string;
  /** Only the links between that node and this one. Default all of its links. */
  readonly peer?: string;
  /** The chance each frame is sent twice, from 0 to 1. */
  readonly rate: number;
  /** How long frames are repeated, in ms. */
  readonly ms: number;
}

/**
 * The database misbehaving for every node, or only `node`: `slow` draws latencies from
 * `latencyMs`, `hang` holds calls unanswered, `error` fails calls unapplied and `lostReplies`
 * applies them and loses the answer, each with chance `rate`.
 */
export type DiskFault =
  | {
      readonly at: number;
      readonly disk: 'slow';
      readonly node?: string;
      readonly latencyMs: readonly [number, number];
      readonly ms: number;
    }
  | { readonly at: number; readonly disk: 'hang'; readonly node?: string; readonly ms: number }
  | {
      readonly at: number;
      readonly disk: 'error' | 'lostReplies';
      readonly node?: string;
      readonly rate: number;
      readonly ms: number;
    };

/** A node cut off from the database, every incarnation of it. */
export interface CutFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node cut off. */
  readonly cut: string;
  /** How long it's cut off, in ms. */
  readonly ms: number;
}

/** The database's wall clock jumped `jump` ms forward, for good. */
export interface JumpFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** How far the clock jumps forward, in ms. */
  readonly jump: number;
}

/** A node's clock running `ppm` parts per million fast, or slow if negative, for `ms`. */
export interface DriftFault {
  /** When it begins, in ms of simulation time. */
  readonly at: number;
  /** The node whose clock drifts. */
  readonly drift: string;
  /** How fast its clock runs, in parts per million: positive is fast, negative slow. */
  readonly ppm: number;
  /** How long the drift lasts, in ms. */
  readonly ms: number;
}

/**
 * One fault in a plan, starting at simulation time `at`. A minor version can add kinds of fault
 * (decision 0039), so code that reads a plan should skip one it doesn't know.
 */
export type Fault =
  | KillFault
  | PauseFault
  | LeaveFault
  | JoinFault
  | PartitionFault
  | ResetFault
  | DelayFault
  | ReorderFault
  | LoseFault
  | DuplicateFault
  | DiskFault
  | CutFault
  | JumpFault
  | DriftFault;

/** Faults, in order of simulation time. Plain JSON, so it prints, edits and shrinks. */
export type FaultPlan = readonly Fault[];

/**
 * Every kind of fault, by the name a plan's `only` option uses. A minor version can add kinds
 * (decision 0039).
 */
export type FaultKind =
  | 'kill'
  | 'pause'
  | 'leave'
  | 'join'
  | 'partition'
  | 'reset'
  | 'delay'
  | 'reorder'
  | 'lose'
  | 'duplicate'
  | 'slow'
  | 'hang'
  | 'error'
  | 'lostReplies'
  | 'cut'
  | 'jump'
  | 'drift';

/** Which faults a scenario's seeds draw, and how often. */
export interface FaultOptions {
  /** Kills, pauses, leaves, and joins of spare nodes. Default false. */
  nodes?: boolean;
  /** Clocks that drift, and the database's clock jumping. Default false. */
  clocks?: boolean;
  /**
   * Partitions, resets, delay and reordering. `chaos` puts the network in chaos mode, which adds
   * lost and repeated frames and reordering within a connection (decision 0035). `true` is
   * `contract`. Default false, which is contract mode with no network faults.
   */
  network?: boolean | NetworkMode;
  /** Slow spells, hangs, errors and lost replies at the database, and nodes cut off from it. */
  disks?: boolean;
  /** Draws only these kinds, in place of the groups above. */
  only?: readonly FaultKind[];
  /** How many faults start a minute, on average. Default 6. */
  perMinute?: number;
  /** How many faults can be under way at once. Default 2. */
  concurrent?: number;
  /** The range each fault's length is drawn from, in ms. Default `[1_000, 8_000]`. */
  lastingMs?: readonly [number, number];
}

/** A scenario's fault options, checked. */
export interface CheckedFaults {
  readonly mode: NetworkMode;
  readonly kinds: readonly FaultKind[];
  readonly perMinute: number;
  readonly concurrent: number;
  readonly lasting: Range;
}

/** What a plan is checked against: the scenario's names, mode and time. */
export interface PlanWorld {
  /** Nodes that host shards, spares included. */
  readonly hosts: readonly string[];
  /** Hosts that start only when a plan joins them. */
  readonly spares: readonly string[];
  /** Nodes that route and run the workload, and host nothing. */
  readonly clients: readonly string[];
  readonly mode: NetworkMode;
  /** When the quiet tail begins: every fault must end by then. */
  readonly quietFrom: number;
  /** The largest jump of the database's clock a drawn plan makes. */
  readonly maxJumpMs: number;
}

const KINDS: readonly FaultKind[] = [
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
  'slow',
  'hang',
  'error',
  'lostReplies',
  'cut',
  'jump',
  'drift',
];
const CHAOS_ONLY = new Set<FaultKind>(['lose', 'duplicate']);
const GROUPS = {
  nodes: ['kill', 'pause', 'leave', 'join'],
  clocks: ['drift', 'jump'],
  network: ['partition', 'reset', 'delay', 'reorder', 'lose', 'duplicate'],
  disks: ['slow', 'hang', 'error', 'lostReplies', 'cut'],
} as const satisfies Record<string, readonly FaultKind[]>;
const FAULT_OPTIONS = new Set([
  'nodes',
  'clocks',
  'network',
  'disks',
  'only',
  'perMinute',
  'concurrent',
  'lastingMs',
]);
const DISKS = new Set(['slow', 'hang', 'error', 'lostReplies']);
const MAX_DRIFT_PPM = 100_000;

// The key that names each kind, and the keys each may have.
const SHAPES: Readonly<Record<string, readonly string[]>> = {
  kill: ['restartAfterMs'],
  pause: ['ms'],
  leave: ['rejoinAfterMs'],
  join: [],
  partition: ['oneWay', 'ms'],
  reset: [],
  delay: ['peer', 'latencyMs', 'ms'],
  reorder: ['peer', 'windowMs', 'within', 'ms'],
  lose: ['peer', 'rate', 'ms'],
  duplicate: ['peer', 'rate', 'ms'],
  disk: ['node', 'latencyMs', 'rate', 'ms'],
  cut: ['ms'],
  jump: [],
  drift: ['ppm', 'ms'],
};

/**
 * Checks a scenario's `faults` option.
 * @throws TypeError for options that can't be used.
 */
export function checkFaults(opts: FaultOptions = {}, spares: number): CheckedFaults {
  checkKeys(opts, FAULT_OPTIONS, 'scenario: faults');
  const { nodes, clocks, disks, only, perMinute = 6, concurrent = 2 } = opts;
  const network: unknown = opts.network;
  for (const [name, value] of [
    ['nodes', nodes],
    ['clocks', clocks],
    ['disks', disks],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`scenario: faults.${name} must be a boolean, got ${describe(value)}`);
    }
  }
  if (
    network !== undefined &&
    typeof network !== 'boolean' &&
    network !== 'contract' &&
    network !== 'chaos'
  ) {
    throw new TypeError(
      `scenario: faults.network must be a boolean, "contract" or "chaos", got ${describe(network)}`,
    );
  }
  const mode: NetworkMode = network === 'chaos' ? 'chaos' : 'contract';
  let kinds: FaultKind[];
  if (only === undefined) {
    kinds = [];
    if (nodes === true) kinds.push(...GROUPS.nodes);
    if (clocks === true) kinds.push(...GROUPS.clocks);
    if (network !== undefined && network !== false) kinds.push(...GROUPS.network);
    if (disks === true) kinds.push(...GROUPS.disks);
    kinds = kinds.filter(
      (k) => (mode === 'chaos' || !CHAOS_ONLY.has(k)) && (k !== 'join' || spares > 0),
    );
  } else {
    if (!Array.isArray(only)) {
      throw new TypeError(
        `scenario: faults.only must be a list of fault kinds, got ${describe(only)}`,
      );
    }
    for (const kind of only as unknown[]) {
      if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
        throw new TypeError(`scenario: faults.only: no fault kind ${describe(kind)}`);
      }
      if (mode === 'contract' && CHAOS_ONLY.has(kind as FaultKind)) {
        throw new TypeError(`scenario: faults.only: ${kind} needs faults.network "chaos"`);
      }
      if (kind === 'join' && spares === 0) {
        throw new TypeError('scenario: faults.only: join needs spares');
      }
    }
    kinds = KINDS.filter((k) => only.includes(k));
  }
  if (typeof perMinute !== 'number' || !(perMinute > 0 && perMinute <= 600)) {
    throw new TypeError(
      `scenario: faults.perMinute must be a number above 0 and at most 600, got ${describe(perMinute)}`,
    );
  }
  checkInt(concurrent, 'scenario: faults.concurrent');
  const lasting = checkRange(opts.lastingMs ?? [1_000, 8_000], 'scenario: faults.lastingMs');
  if (lasting[0] < 1) throw new TypeError('scenario: faults.lastingMs must start at 1 ms or more');
  return { mode, kinds, perMinute, concurrent, lasting };
}

/** The kind of a fault, by the key that names it. */
export function kindOf(fault: Fault): FaultKind {
  if ('disk' in fault) return fault.disk;
  for (const key of Object.keys(fault)) {
    if (key !== 'at' && key in SHAPES) return key as FaultKind;
  }
  // checkPlan has already made sure every fault has a kind.
  throw new TypeError('no kind');
}

/** When a fault has ended: its node back, its link healed, its spell over. */
export function endOf(fault: Fault): number {
  if ('ms' in fault) return fault.at + fault.ms;
  if ('restartAfterMs' in fault) return fault.at + fault.restartAfterMs;
  if ('rejoinAfterMs' in fault) return fault.at + fault.rejoinAfterMs;
  return fault.at;
}

/**
 * Checks a plan given to a run, and returns a copy with its keys in one order, so it prints the
 * same way however it was written.
 * @throws TypeError for a plan that can't be run: unknown kinds, nodes or keys, faults out of
 * order, a fault that runs into the quiet tail, or one that needs chaos mode in contract mode.
 */
export function checkPlan(plan: unknown, world: PlanWorld): FaultPlan {
  if (!Array.isArray(plan))
    throw new TypeError(`plan must be a list of faults, got ${describe(plan)}`);
  const everyone = [...world.hosts, ...world.clients];
  let last = 0;
  return (plan as unknown[]).map((raw, i) => {
    const where = `plan[${String(i)}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError(`${where} must be a fault, got ${describe(raw)}`);
    }
    const f = raw as Record<string, unknown>;
    const names = Object.keys(f).filter((k) => k in SHAPES);
    if (names.length !== 1) {
      throw new TypeError(
        `${where} must name one kind of fault, such as kill or partition, got ${names.length === 0 ? 'none' : names.join(' and ')}`,
      );
    }
    const name = names[0] as string;
    checkKeys(f, new Set(['at', name, ...(SHAPES[name] ?? [])]), where);
    checkInt(f.at, `${where}.at`, { min: 0 });
    const at = f.at as number;
    if (at < last) {
      throw new TypeError(
        `${where}.at must be no earlier than the fault before it, ${String(last)}`,
      );
    }
    last = at;
    const fault = checkFault(f, name, at, where, world, everyone);
    const end = endOf(fault);
    if (end > world.quietFrom) {
      throw new TypeError(
        `${where} must end by ${String(world.quietFrom)}, when the quiet tail begins, but ends at ${String(end)}`,
      );
    }
    return fault;
  });
}

function checkFault(
  f: Record<string, unknown>,
  name: string,
  at: number,
  where: string,
  world: PlanWorld,
  everyone: readonly string[],
): Fault {
  const host = (value: unknown, what: string): string =>
    oneOf(value, world.hosts, `${where}.${what}`, 'a host');
  const anyone = (value: unknown, what: string): string =>
    oneOf(value, everyone, `${where}.${what}`, 'a node');
  const ms = (key: string): number => {
    checkInt(f[key], `${where}.${key}`);
    return f[key] as number;
  };
  const peer = (node: string): { peer?: string } => {
    if (f.peer === undefined) return {};
    const p = anyone(f.peer, 'peer');
    if (p === node) throw new TypeError(`${where}.peer must be another node than ${node}`);
    return { peer: p };
  };
  const chaos = (what: string): void => {
    if (world.mode !== 'chaos')
      throw new TypeError(`${where}: ${what} needs the network in chaos mode`);
  };
  switch (name) {
    case 'kill':
      return { at, kill: host(f.kill, 'kill'), restartAfterMs: ms('restartAfterMs') };
    case 'pause':
      return { at, pause: host(f.pause, 'pause'), ms: ms('ms') };
    case 'leave':
      return { at, leave: host(f.leave, 'leave'), rejoinAfterMs: ms('rejoinAfterMs') };
    case 'join':
      return { at, join: oneOf(f.join, world.spares, `${where}.join`, 'a spare') };
    case 'partition': {
      const sides = f.partition;
      if (!Array.isArray(sides) || sides.length !== 2) {
        throw new TypeError(
          `${where}.partition must be two lists of nodes, got ${describe(sides)}`,
        );
      }
      const [a, b] = (sides as unknown[]).map((side, s) => {
        if (!Array.isArray(side) || side.length === 0) {
          throw new TypeError(`${where}.partition[${String(s)}] must be a non-empty list of nodes`);
        }
        return (side as unknown[]).map((n, j) =>
          anyone(n, `partition[${String(s)}][${String(j)}]`),
        );
      }) as [string[], string[]];
      const shared = a.find((n) => b.includes(n));
      if (shared !== undefined || new Set(a).size < a.length || new Set(b).size < b.length) {
        throw new TypeError(`${where}.partition names ${shared ?? 'a node'} more than once`);
      }
      if (f.oneWay !== undefined && f.oneWay !== true) {
        throw new TypeError(`${where}.oneWay must be true or absent, got ${describe(f.oneWay)}`);
      }
      return {
        at,
        partition: [a, b],
        ...(f.oneWay === true ? { oneWay: true as const } : {}),
        ms: ms('ms'),
      };
    }
    case 'reset': {
      const pair = f.reset;
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError(`${where}.reset must be two nodes, got ${describe(pair)}`);
      }
      const a = anyone(pair[0], 'reset[0]');
      const b = anyone(pair[1], 'reset[1]');
      if (a === b) throw new TypeError(`${where}.reset must name two different nodes`);
      return { at, reset: [a, b] };
    }
    case 'delay': {
      const node = anyone(f.delay, 'delay');
      const latencyMs = checkRange(f.latencyMs, `${where}.latencyMs`);
      return { at, delay: node, ...peer(node), latencyMs, ms: ms('ms') };
    }
    case 'reorder': {
      const node = anyone(f.reorder, 'reorder');
      const windowMs = ms('windowMs');
      if (f.within !== undefined && f.within !== true) {
        throw new TypeError(`${where}.within must be true or absent, got ${describe(f.within)}`);
      }
      if (f.within === true) chaos('reordering within a connection');
      return {
        at,
        reorder: node,
        ...peer(node),
        windowMs,
        ...(f.within === true ? { within: true as const } : {}),
        ms: ms('ms'),
      };
    }
    case 'lose':
    case 'duplicate': {
      chaos(name);
      const node = anyone(f[name], name);
      const rate = checkRate(f.rate, `${where}.rate`);
      const p = peer(node);
      return name === 'lose'
        ? { at, lose: node, ...p, rate, ms: ms('ms') }
        : { at, duplicate: node, ...p, rate, ms: ms('ms') };
    }
    case 'disk': {
      const disk = f.disk;
      if (typeof disk !== 'string' || !DISKS.has(disk)) {
        throw new TypeError(
          `${where}.disk must be "slow", "hang", "error" or "lostReplies", got ${describe(disk)}`,
        );
      }
      const node = f.node === undefined ? {} : { node: anyone(f.node, 'node') };
      const allowed = new Set(['at', 'disk', 'node', 'ms']);
      if (disk === 'slow') allowed.add('latencyMs');
      if (disk === 'error' || disk === 'lostReplies') allowed.add('rate');
      checkKeys(f, allowed, where);
      if (disk === 'slow') {
        return {
          at,
          disk,
          ...node,
          latencyMs: checkRange(f.latencyMs, `${where}.latencyMs`),
          ms: ms('ms'),
        };
      }
      if (disk === 'hang') return { at, disk, ...node, ms: ms('ms') };
      return {
        at,
        disk: disk as 'error' | 'lostReplies',
        ...node,
        rate: checkRate(f.rate, `${where}.rate`),
        ms: ms('ms'),
      };
    }
    case 'cut':
      return { at, cut: anyone(f.cut, 'cut'), ms: ms('ms') };
    case 'jump':
      checkInt(f.jump, `${where}.jump`);
      return { at, jump: f.jump as number };
    default: {
      // drift, the last of SHAPES' keys.
      const ppm = f.ppm;
      checkInt(ppm, `${where}.ppm`, { min: -MAX_DRIFT_PPM });
      if ((ppm as number) > MAX_DRIFT_PPM) {
        throw new TypeError(
          `${where}.ppm must be at most ${String(MAX_DRIFT_PPM)}, got ${String(ppm)}`,
        );
      }
      return { at, drift: host(f.drift, 'drift'), ppm: ppm as number, ms: ms('ms') };
    }
  }
}

function oneOf(value: unknown, names: readonly string[], what: string, kind: string): string {
  if (typeof value !== 'string' || !names.includes(value)) {
    throw new TypeError(
      `${what} must be ${kind} of the scenario, one of ${names.join(', ')}; got ${describe(value)}`,
    );
  }
  return value;
}

// What drawing knows of each host as it goes: when its node fault ends, and whether it's joined.
interface HostState {
  busyUntil: number;
  joined: boolean;
}

/**
 * Draws a plan from the plan stream: faults of the scenario's kinds, about `perMinute` a minute,
 * at most `concurrent` at once, and every one ended by the quiet tail. A node fault never lands
 * on a host that's already under one, and never leaves no host free of one, so the cluster
 * always has somewhere to run.
 */
export function drawPlan(random: () => number, world: PlanWorld, faults: CheckedFaults): FaultPlan {
  const plan: Fault[] = [];
  if (faults.kinds.length === 0) return plan;
  const hosts = new Map<string, HostState>(
    world.hosts.map((h) => [h, { busyUntil: 0, joined: !world.spares.includes(h) }]),
  );
  const meanGap = 60_000 / faults.perMinute;
  const ends: number[] = [];
  let t = 0;
  for (;;) {
    t += draw(random, [1, Math.max(1, Math.round(2 * meanGap))]);
    for (;;) {
      const still = ends.filter((end) => end > t);
      ends.length = 0;
      ends.push(...still);
      if (ends.length < faults.concurrent) break;
      t = Math.min(...ends);
    }
    if (t >= world.quietFrom) return plan;
    const room = world.quietFrom - t;
    const lasting = (): number => Math.min(room, draw(random, faults.lasting));
    const kind = pick(random, faults.kinds);
    const joined = [...hosts].filter(([, s]) => s.joined).map(([h]) => h);
    const free = joined.filter((h) => (hosts.get(h)?.busyUntil ?? 0) <= t);
    // A node fault needs a free host, and must leave another one free.
    const target = (): string | undefined => (free.length < 2 ? undefined : pick(random, free));
    const reach = (): string[] => [...joined, ...world.clients];
    let fault: Fault | undefined;
    switch (kind) {
      case 'kill':
      case 'pause':
      case 'leave':
      case 'drift':
      case 'cut': {
        const node = target();
        if (node === undefined) break;
        const ms = lasting();
        if (kind === 'kill') fault = { at: t, kill: node, restartAfterMs: ms };
        else if (kind === 'pause') fault = { at: t, pause: node, ms };
        else if (kind === 'leave') fault = { at: t, leave: node, rejoinAfterMs: ms };
        else if (kind === 'cut') fault = { at: t, cut: node, ms };
        else {
          const size = draw(random, [1_000, 20_000]);
          fault = { at: t, drift: node, ppm: random() < 0.5 ? -size : size, ms };
        }
        const state = hosts.get(node);
        if (state !== undefined) state.busyUntil = t + ms;
        break;
      }
      case 'join': {
        const spare = [...hosts].find(([, s]) => !s.joined)?.[0];
        if (spare === undefined) break;
        fault = { at: t, join: spare };
        const state = hosts.get(spare);
        if (state !== undefined) state.joined = true;
        break;
      }
      case 'partition': {
        const nodes = reach();
        let a: string[];
        if (random() < 0.5) a = [pick(random, nodes)];
        else a = nodes.filter(() => random() < 0.5);
        const b = nodes.filter((n) => !a.includes(n));
        if (a.length === 0 || b.length === 0) break;
        const oneWay = random() < 0.25;
        fault = {
          at: t,
          partition: [a, b],
          ...(oneWay ? { oneWay: true as const } : {}),
          ms: lasting(),
        };
        break;
      }
      case 'reset': {
        const nodes = reach();
        const a = pick(random, nodes);
        const others = nodes.filter((n) => n !== a);
        if (others.length === 0) break;
        fault = { at: t, reset: [a, pick(random, others)] };
        break;
      }
      case 'delay':
      case 'reorder':
      case 'lose':
      case 'duplicate': {
        const nodes = reach();
        const node = pick(random, nodes);
        const others = nodes.filter((n) => n !== node);
        const peer = others.length > 0 && random() < 0.5 ? { peer: pick(random, others) } : {};
        if (kind === 'delay') {
          const lo = draw(random, [10, 100]);
          fault = {
            at: t,
            delay: node,
            ...peer,
            latencyMs: [lo, lo + draw(random, [0, 400])],
            ms: lasting(),
          };
        } else if (kind === 'reorder') {
          const windowMs = draw(random, [5, 100]);
          const within = world.mode === 'chaos' && random() < 0.5;
          fault = {
            at: t,
            reorder: node,
            ...peer,
            windowMs,
            ...(within ? { within: true as const } : {}),
            ms: lasting(),
          };
        } else {
          const rate = rateIn(random, 0.05, 0.5);
          fault =
            kind === 'lose'
              ? { at: t, lose: node, ...peer, rate, ms: lasting() }
              : { at: t, duplicate: node, ...peer, rate, ms: lasting() };
        }
        break;
      }
      case 'slow':
      case 'hang':
      case 'error':
      case 'lostReplies': {
        const nodes = reach();
        const node = random() < 0.5 ? { node: pick(random, nodes) } : {};
        if (kind === 'slow') {
          const lo = draw(random, [50, 500]);
          fault = {
            at: t,
            disk: 'slow',
            ...node,
            latencyMs: [lo, lo + draw(random, [0, 2_000])],
            ms: lasting(),
          };
        } else if (kind === 'hang') {
          fault = { at: t, disk: 'hang', ...node, ms: lasting() };
        } else {
          const rate = kind === 'error' ? rateIn(random, 0.1, 1) : rateIn(random, 0.05, 0.5);
          fault = { at: t, disk: kind, ...node, rate, ms: lasting() };
        }
        break;
      }
      case 'jump':
        fault = { at: t, jump: draw(random, [Math.min(100, world.maxJumpMs), world.maxJumpMs]) };
        break;
    }
    if (fault === undefined) continue;
    plan.push(fault);
    const end = endOf(fault);
    if (end > t) ends.push(end);
  }
}

// A chance in [lo, hi], to two decimal places, so plans print short.
function rateIn(random: () => number, lo: number, hi: number): number {
  return Math.max(0.01, Math.round((lo + random() * (hi - lo)) * 100) / 100);
}
