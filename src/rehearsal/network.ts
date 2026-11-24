// The simulated network (decision 0035): a Transport on simulation time, as the in-memory network
// is, that a run can partition, reset, slow down and reorder, all drawn from its own random stream.
//
// Contract mode does only what TCP can. Frames on one connection arrive in order, at most once,
// and the only frames lost are the ones still on a connection when it closes. A partition holds
// frames, as TCP retransmits across a dropped cable: they arrive in order once it heals, or the
// connection times out and resets with them on it. Chaos mode breaks the contract on purpose: it
// loses frames from the middle of a connection, reorders them within one, and repeats them, and a
// partition loses the frames it cuts. Opens, closes and resets are never lost or repeated in
// either mode, since they stand for TCP's own handshakes, which it retransmits.

import { checkInt, checkKeys, describe } from '../checks.js';
import type { Connection, Transport } from '../cluster/transport.js';
import type { Scheduler } from '../scheduler.js';

/** `contract` keeps the `Transport` contract. `chaos` breaks it: loss, reordering and repeats. */
export type NetworkMode = 'contract' | 'chaos';

/** Options for {@link simulatedNetwork}. */
export interface SimulatedNetworkOptions {
  /** The simulation's scheduler, which every open, frame and close goes through. */
  scheduler: Scheduler;
  /** The network's own random stream, which draws every latency, loss and repeat. */
  random: () => number;
  /** Default `contract`. */
  mode?: NetworkMode;
  /**
   * The range each open, frame and close's latency is drawn from, in whole ms, both ends
   * included. Default `[1, 3]`.
   */
  latencyMs?: readonly [number, number];
  /**
   * How long a connection can hold frames a partition stops before it resets, in ms, as TCP gives
   * up retransmitting. A dial across a partition fails after it too. Default 10,000.
   */
  resetAfterMs?: number;
}

/**
 * The links a fault applies to: every frame to or from `node`, or only those between `node` and
 * `peer`.
 */
export interface LinkSelector {
  readonly node: string;
  readonly peer?: string;
}

/** What a simulated network has done with frames so far. */
export interface NetworkCounts {
  /** Frames sent on a connection that was open at the sender's end. */
  readonly sent: number;
  /** Frames handed to the other end's listeners. */
  readonly delivered: number;
  /** Frames chaos mode lost: dropped at random, or cut by a partition. */
  readonly lost: number;
  /** Extra copies chaos mode sent. */
  readonly duplicated: number;
  /** Frames chaos mode scheduled to arrive before one sent earlier on the same connection. */
  readonly overtaken: number;
  /** Opens, frames and closes a partition held. */
  readonly held: number;
  /** Connections that reset because a partition held their frames for `resetAfterMs`. */
  readonly timedOut: number;
  /** Connections reset by {@link SimulatedNetwork.reset}. */
  readonly resets: number;
}

/** Nodes in one simulation, joined by a network that faults can be injected into. */
export interface SimulatedNetwork {
  readonly mode: NetworkMode;
  /**
   * A transport for the node at `address`. An address is free again once its transport has
   * closed or its node has been killed.
   * @throws Error if a live transport already has `address`.
   * @throws TypeError unless `address` is a non-empty string.
   */
  transport(address: string): Transport;
  /**
   * Kills the node at `address`, as `kill -9` would: frames on their way from it are lost, and
   * the other ends of its connections see an error once its reset reaches them.
   */
  kill(address: string): void;
  /**
   * Cuts `side` off from `other`, both ways, or with `oneWay` only from `side` to `other`, until
   * the returned function heals it. Connections see nothing. In contract mode their frames wait,
   * and in chaos mode they're lost.
   * @throws TypeError unless both sides are non-empty lists of addresses, with none on both.
   */
  partition(
    side: readonly string[],
    other: readonly string[],
    opts?: { readonly oneWay?: boolean },
  ): () => void;
  /**
   * Resets every connection between `a` and `b`, as a TCP reset does: both ends close with an
   * error, and the frames on their way are lost.
   */
  reset(a: string, b: string): void;
  /**
   * Draws the latency of every open, frame and close on the selected links from `latencyMs`
   * instead, if that's longer, until the returned function ends it. Frames stay in order.
   */
  delay(opts: LinkSelector & { readonly latencyMs: readonly [number, number] }): () => void;
  /**
   * Adds up to `windowMs` to the latency of everything on the selected links, drawn each time,
   * until the returned function ends it. Frames on different connections overtake each other.
   * With `within`, in chaos mode only, frames on one connection do too.
   * @throws TypeError for `within` in contract mode.
   */
  reorder(
    opts: LinkSelector & { readonly windowMs: number; readonly within?: boolean },
  ): () => void;
  /**
   * Loses each frame on the selected links with chance `rate`, leaving its connection open, until
   * the returned function ends it. Chaos mode only.
   * @throws TypeError in contract mode.
   */
  lose(opts: LinkSelector & { readonly rate: number }): () => void;
  /**
   * Sends each frame on the selected links twice with chance `rate`, the copy with a latency of
   * its own, until the returned function ends it. Chaos mode only.
   * @throws TypeError in contract mode.
   */
  duplicate(opts: LinkSelector & { readonly rate: number }): () => void;
  /** What the network has done with frames so far. */
  counts(): NetworkCounts;
}

const OPTIONS = new Set(['scheduler', 'random', 'mode', 'latencyMs', 'resetAfterMs']);
const PARTITION_OPTIONS = new Set(['oneWay']);
const DELAY_OPTIONS = new Set(['node', 'peer', 'latencyMs']);
const REORDER_OPTIONS = new Set(['node', 'peer', 'windowMs', 'within']);
const RATE_OPTIONS = new Set(['node', 'peer', 'rate']);

/**
 * Makes a simulated network on `scheduler`, with no faults until they're injected.
 * @throws TypeError for options that can't be used.
 */
export function simulatedNetwork(opts: SimulatedNetworkOptions): SimulatedNetwork {
  checkKeys(opts, OPTIONS, 'simulatedNetwork');
  const { scheduler, random, mode = 'contract', latencyMs = [1, 3], resetAfterMs = 10_000 } = opts;
  const given: unknown = scheduler;
  if (typeof (given as { setTimer?: unknown } | null)?.setTimer !== 'function') {
    throw new TypeError('simulatedNetwork: scheduler must be a Scheduler');
  }
  const givenRandom: unknown = random;
  if (typeof givenRandom !== 'function') {
    throw new TypeError(`simulatedNetwork: random must be a function, got ${describe(random)}`);
  }
  const givenMode: unknown = mode;
  if (givenMode !== 'contract' && givenMode !== 'chaos') {
    throw new TypeError(
      `simulatedNetwork: mode must be "contract" or "chaos", got ${describe(mode)}`,
    );
  }
  const latency = checkRange(latencyMs, 'simulatedNetwork: latencyMs');
  checkInt(resetAfterMs, 'simulatedNetwork: resetAfterMs');
  const net = new Net(scheduler, random, mode, latency, resetAfterMs);

  const chaosOnly = (what: string): void => {
    if (mode !== 'chaos') {
      throw new TypeError(
        `simulatedNetwork: ${what} breaks the Transport contract: chaos mode only`,
      );
    }
  };

  return {
    mode,
    transport: (address) => net.transport(address),
    kill: (address) => {
      net.kill(address);
    },
    partition(side, other, popts = {}) {
      checkKeys(popts, PARTITION_OPTIONS, 'partition');
      const a = checkSide(side, 'partition: side');
      const b = checkSide(other, 'partition: other');
      for (const address of a) {
        if (b.has(address)) throw new TypeError(`partition: ${address} is on both sides`);
      }
      const oneWay = popts.oneWay ?? false;
      if (typeof oneWay !== 'boolean') {
        throw new TypeError(`partition: oneWay must be a boolean, got ${describe(oneWay)}`);
      }
      const cuts: Cut[] = oneWay
        ? [{ from: a, to: b }]
        : [
            { from: a, to: b },
            { from: b, to: a },
          ];
      return net.add(net.cuts, cuts, () => {
        net.flush();
      });
    },
    reset(a, b) {
      checkAddress(a, 'reset: a');
      checkAddress(b, 'reset: b');
      net.reset(a, b);
    },
    delay(dopts) {
      checkKeys(dopts, DELAY_OPTIONS, 'delay');
      const selector = checkSelector(dopts, 'delay');
      const range = checkRange(dopts.latencyMs, 'delay: latencyMs');
      return net.add(net.delays, [{ ...selector, range }]);
    },
    reorder(ropts) {
      checkKeys(ropts, REORDER_OPTIONS, 'reorder');
      const selector = checkSelector(ropts, 'reorder');
      checkInt(ropts.windowMs, 'reorder: windowMs');
      const within = ropts.within ?? false;
      if (typeof within !== 'boolean') {
        throw new TypeError(`reorder: within must be a boolean, got ${describe(within)}`);
      }
      if (within) chaosOnly('reordering within a connection');
      return net.add(net.reorders, [{ ...selector, windowMs: ropts.windowMs, within }]);
    },
    lose(lopts) {
      checkKeys(lopts, RATE_OPTIONS, 'lose');
      const rule = { ...checkSelector(lopts, 'lose'), rate: checkRate(lopts.rate, 'lose') };
      chaosOnly('losing a frame from an open connection');
      return net.add(net.losses, [rule]);
    },
    duplicate(dopts) {
      checkKeys(dopts, RATE_OPTIONS, 'duplicate');
      const rule = {
        ...checkSelector(dopts, 'duplicate'),
        rate: checkRate(dopts.rate, 'duplicate'),
      };
      chaosOnly('repeating a frame');
      return net.add(net.duplicates, [rule]);
    },
    counts: () => ({ ...net.counts }),
  };
}

type Range = readonly [number, number];
type Side = 'a' | 'b';

/** A partition, one way: frames from `from` to `to` are stopped. */
interface Cut {
  readonly from: ReadonlySet<string>;
  readonly to: ReadonlySet<string>;
}

interface Selected {
  readonly node: string;
  readonly peer: string | undefined;
}

interface DelayRule extends Selected {
  readonly range: Range;
}

interface ReorderRule extends Selected {
  readonly windowMs: number;
  readonly within: boolean;
}

interface RateRule extends Selected {
  readonly rate: number;
}

/** What travels on a connection: TCP's handshakes stand for themselves, among the frames. */
type Packet =
  | { readonly kind: 'open' }
  | { readonly kind: 'frame'; readonly frame: string }
  | { readonly kind: 'close' }
  | { readonly kind: 'reset' };

/** A node on the network: one transport's side of things. */
interface Host {
  readonly address: string;
  onConnection: ((connection: Connection) => void) | undefined;
  readonly ends: Set<End>;
  gone: boolean;
}

/** One direction of a connection. */
class Pipe {
  /** When the latest thing sent this way arrives, so nothing sent after it arrives before it. */
  lastArrival = 0;
  /** What a partition is holding, in the order it was sent. */
  held: Packet[] = [];
  cancelTimeout: (() => void) | undefined;
}

/** One connection: the end that dialed, and the end that accepted once the open arrives. */
class Link {
  readonly a: End;
  b: End | undefined;
  broken = false;
  readonly ab = new Pipe();
  readonly ba = new Pipe();
  readonly dialer: string;

  constructor(
    net: Net,
    host: Host,
    readonly target: string,
  ) {
    this.dialer = host.address;
    this.a = new End(net, host, this, 'a');
  }

  pipe(side: Side): Pipe {
    return side === 'a' ? this.ab : this.ba;
  }

  /** The addresses frames sent from `side` go from and to. */
  route(side: Side): readonly [string, string] {
    return side === 'a' ? [this.dialer, this.target] : [this.target, this.dialer];
  }
}

function matches(rule: Selected, from: string, to: string): boolean {
  return (
    (rule.node === from && (rule.peer === undefined || rule.peer === to)) ||
    (rule.node === to && (rule.peer === undefined || rule.peer === from))
  );
}

class Net {
  readonly hosts = new Map<string, Host>();
  // Insertion order, so a heal flushes connections in an order a run repeats.
  readonly links = new Set<Link>();
  readonly cuts: Cut[] = [];
  readonly delays: DelayRule[] = [];
  readonly reorders: ReorderRule[] = [];
  readonly losses: RateRule[] = [];
  readonly duplicates: RateRule[] = [];
  readonly counts = {
    sent: 0,
    delivered: 0,
    lost: 0,
    duplicated: 0,
    overtaken: 0,
    held: 0,
    timedOut: 0,
    resets: 0,
  };

  constructor(
    readonly scheduler: Scheduler,
    readonly random: () => number,
    readonly mode: NetworkMode,
    readonly latency: Range,
    readonly resetAfterMs: number,
  ) {}

  /** Adds `items` to `rules` until the returned function takes them out again, and calls `then`. */
  add<T>(rules: T[], items: readonly T[], then?: () => void): () => void {
    rules.push(...items);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      for (const item of items) rules.splice(rules.indexOf(item), 1);
      then?.();
    };
  }

  transport(address: string): Transport {
    checkAddress(address, 'simulatedNetwork: address');
    if (this.hosts.has(address)) {
      throw new Error(`simulatedNetwork: ${address} already has a live transport`);
    }
    const host: Host = { address, onConnection: undefined, ends: new Set(), gone: false };
    this.hosts.set(address, host);
    return {
      address,
      listen: (onConnection) => {
        if (host.gone) return Promise.reject(new Error(`${address} has closed`));
        if (host.onConnection !== undefined) {
          return Promise.reject(new Error(`${address} is already listening`));
        }
        host.onConnection = onConnection;
        return Promise.resolve();
      },
      connect: (to) => {
        if (host.gone) {
          const dead = new Link(this, host, to).a;
          dead.drop(new Error(`${address} has closed`));
          return dead;
        }
        return this.connect(host, to);
      },
      close: () => {
        if (!host.gone) {
          host.gone = true;
          host.onConnection = undefined;
          this.hosts.delete(address);
          for (const end of [...host.ends]) end.close();
        }
        return Promise.resolve();
      },
    };
  }

  connect(from: Host, to: string): End {
    const link = new Link(this, from, to);
    const local = link.a;
    from.ends.add(local);
    this.links.add(link);
    this.send(link, 'a', { kind: 'open' });
    return local;
  }

  kill(address: string): void {
    const host = this.hosts.get(address);
    if (host === undefined) return;
    host.gone = true;
    host.onConnection = undefined;
    this.hosts.delete(address);
    for (const end of [...host.ends]) end.vanish();
  }

  reset(a: string, b: string): void {
    for (const link of [...this.links]) {
      const between =
        (link.dialer === a && link.target === b) || (link.dialer === b && link.target === a);
      if (!between || link.broken) continue;
      this.counts.resets++;
      this.break(link, (peer) => new Error(`the connection to ${peer} was reset`));
    }
  }

  /** Sends `packet` from `side` of `link`: held if a partition stops it, otherwise on its way. */
  send(link: Link, side: Side, packet: Packet): void {
    if (link.broken) return;
    if (packet.kind === 'frame') this.counts.sent++;
    const pipe = link.pipe(side);
    const [from, to] = link.route(side);
    const cut = this.cut(from, to);
    if (cut && packet.kind === 'frame' && this.mode === 'chaos') {
      this.counts.lost++;
      return;
    }
    // Whatever is held goes first, so nothing overtakes it.
    if (cut || pipe.held.length > 0) {
      this.counts.held++;
      pipe.held.push(packet);
      pipe.cancelTimeout ??= this.scheduler.setTimer(() => {
        this.timeOut(link);
      }, this.resetAfterMs);
      return;
    }
    this.transmit(link, side, packet);
  }

  /** Sends what each healed partition held, in the order it was sent. */
  flush(): void {
    for (const link of [...this.links]) {
      for (const side of ['a', 'b'] as const) {
        const pipe = link.pipe(side);
        if (pipe.held.length === 0) continue;
        const [from, to] = link.route(side);
        if (this.cut(from, to)) continue;
        pipe.cancelTimeout?.();
        pipe.cancelTimeout = undefined;
        for (const packet of pipe.held.splice(0)) this.transmit(link, side, packet);
      }
      this.retire(link);
    }
  }

  /** Removes a connection once both ends have closed and nothing is held on it. */
  retire(link: Link): void {
    if (!link.a.closed || link.b?.closed === false) return;
    if (link.ab.held.length > 0 || link.ba.held.length > 0) return;
    this.links.delete(link);
  }

  /** Whether a partition stops frames from `from` to `to`. */
  cut(from: string, to: string): boolean {
    for (const cut of this.cuts) if (cut.from.has(from) && cut.to.has(to)) return true;
    return false;
  }

  // A partition held frames too long: TCP gives up, and both ends see the connection reset.
  timeOut(link: Link): void {
    this.counts.timedOut++;
    this.break(link, (peer) => new Error(`the connection to ${peer} timed out`));
  }

  break(link: Link, error: (peer: string) => Error): void {
    link.broken = true;
    for (const pipe of [link.ab, link.ba]) {
      pipe.held = [];
      pipe.cancelTimeout?.();
      pipe.cancelTimeout = undefined;
    }
    link.a.finish({ error: error(link.target) });
    link.b?.finish({ error: error(link.dialer) });
    this.retire(link);
  }

  // Draws a frame's fate in chaos mode, then puts it, and any copy, on its way.
  transmit(link: Link, side: Side, packet: Packet): void {
    if (packet.kind === 'frame') {
      const [from, to] = link.route(side);
      if (this.#chance(this.losses, from, to)) {
        this.counts.lost++;
        return;
      }
      this.#schedule(link, side, packet);
      if (this.#chance(this.duplicates, from, to)) {
        this.counts.duplicated++;
        this.#schedule(link, side, packet);
      }
      return;
    }
    this.#schedule(link, side, packet);
  }

  #chance(rules: readonly RateRule[], from: string, to: string): boolean {
    let hit = false;
    for (const rule of rules) if (matches(rule, from, to) && this.random() < rule.rate) hit = true;
    return hit;
  }

  #draw([min, max]: Range): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  #schedule(link: Link, side: Side, packet: Packet): void {
    const [from, to] = link.route(side);
    const pipe = link.pipe(side);
    let latency = this.#draw(this.latency);
    for (const rule of this.delays) {
      if (matches(rule, from, to)) latency = Math.max(latency, this.#draw(rule.range));
    }
    let within = false;
    for (const rule of this.reorders) {
      if (!matches(rule, from, to)) continue;
      latency += this.#draw([0, rule.windowMs]);
      if (rule.within) within = true;
    }
    const now = this.scheduler.now();
    let at = now + latency;
    // Only frames overtake: TCP's own handshakes keep their place.
    if (within && packet.kind === 'frame') {
      if (at < pipe.lastArrival) this.counts.overtaken++;
    } else {
      at = Math.max(at, pipe.lastArrival);
    }
    pipe.lastArrival = Math.max(pipe.lastArrival, at);
    this.scheduler.setTimer(() => {
      this.#arrive(link, side, packet);
    }, at - now);
  }

  #arrive(link: Link, side: Side, packet: Packet): void {
    // A reset loses everything on its way: both ends have closed, so nothing below delivers it.
    const source = side === 'a' ? link.a : link.b;
    const dest = side === 'a' ? link.b : link.a;
    switch (packet.kind) {
      case 'open': {
        const local = link.a;
        if (local.closed) return;
        const target = this.hosts.get(link.target);
        if (target?.onConnection === undefined) {
          local.drop(new Error(`nothing listens at ${link.target}`));
          return;
        }
        const remote = new End(this, target, link, 'b');
        target.ends.add(remote);
        link.b = remote;
        link.ba.lastArrival = this.scheduler.now();
        target.onConnection(remote);
        return;
      }
      case 'frame':
        // Lost if its node was killed since, or the other end has closed, or never opened.
        if (source?.vanished !== false || dest === undefined || dest.closed) return;
        this.counts.delivered++;
        dest.emit(packet.frame);
        return;
      case 'close':
        dest?.finish({});
        return;
      case 'reset': {
        const [from] = link.route(side);
        dest?.finish({ error: new Error(`the connection to ${from} was reset`) });
      }
    }
  }
}

/** One end of a connection. */
class End implements Connection {
  closed = false;
  // Its node was killed, so even frames it sent before are lost.
  vanished = false;
  readonly #net: Net;
  readonly #host: Host;
  readonly #link: Link;
  readonly #side: Side;
  readonly #frameListeners: ((frame: string) => void)[] = [];
  readonly #closeListeners: ((error?: unknown) => void)[] = [];
  #closeError: { readonly error?: unknown } | undefined;

  constructor(net: Net, host: Host, link: Link, side: Side) {
    this.#net = net;
    this.#host = host;
    this.#link = link;
    this.#side = side;
  }

  send(frame: string): void {
    if (this.closed) return;
    this.#net.send(this.#link, this.#side, { kind: 'frame', frame });
  }

  onFrame(listener: (frame: string) => void): void {
    this.#frameListeners.push(listener);
  }

  onClose(listener: (error?: unknown) => void): void {
    const closed = this.#closeError;
    if (closed === undefined) {
      this.#closeListeners.push(listener);
      return;
    }
    this.#net.scheduler.runSoon(() => {
      listener(...closeArgs(closed));
    });
  }

  close(): void {
    if (this.closed) return;
    // Sent before this end closes, so it's held behind the frames already sent if it must be.
    this.#net.send(this.#link, this.#side, { kind: 'close' });
    this.finish({});
  }

  /** Closes this end because it never opened, telling its listeners why. */
  drop(error: Error): void {
    this.finish({ error });
  }

  /** This end's node was killed: nothing is told here, and the other end hears of it as an error. */
  vanish(): void {
    this.vanished = true;
    if (this.closed) return;
    this.#net.send(this.#link, this.#side, { kind: 'reset' });
    this.closed = true;
    this.#closeError = {};
    this.#host.ends.delete(this);
    this.#frameListeners.length = 0;
    this.#closeListeners.length = 0;
    this.#net.retire(this.#link);
  }

  emit(frame: string): void {
    for (const listener of this.#frameListeners) listener(frame);
  }

  /** Closes this end, telling its listeners on the scheduler. */
  finish(how: { readonly error?: unknown }): void {
    if (this.closed) return;
    this.closed = true;
    this.#closeError = how;
    this.#host.ends.delete(this);
    const listeners = this.#closeListeners.splice(0);
    // Told on the scheduler, never inside the call that closed it, so a listener can't re-enter.
    this.#net.scheduler.runSoon(() => {
      for (const listener of listeners) listener(...closeArgs(how));
    });
    this.#net.retire(this.#link);
  }
}

function closeArgs(how: { readonly error?: unknown }): [] | [unknown] {
  return 'error' in how ? [how.error] : [];
}

function checkAddress(address: unknown, what: string): asserts address is string {
  if (typeof address !== 'string' || address === '') {
    throw new TypeError(`${what} must be a non-empty string, got ${describe(address)}`);
  }
}

function checkSide(side: unknown, what: string): ReadonlySet<string> {
  if (!Array.isArray(side) || side.length === 0) {
    throw new TypeError(`${what} must be a non-empty list of addresses`);
  }
  for (const address of side as unknown[]) checkAddress(address, `${what}'s address`);
  return new Set(side as string[]);
}

function checkSelector(opts: { node?: unknown; peer?: unknown }, where: string): Selected {
  checkAddress(opts.node, `${where}: node`);
  if (opts.peer !== undefined) checkAddress(opts.peer, `${where}: peer`);
  return { node: opts.node, peer: opts.peer };
}

function checkRange(range: unknown, what: string): Range {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new TypeError(`${what} must be [min, max], got ${describe(range)}`);
  }
  const [min, max] = range as unknown[];
  checkInt(min, `${what}[0]`, { min: 0 });
  checkInt(max, `${what}[1]`, { min: 0 });
  if ((max as number) < (min as number)) {
    throw new TypeError(`${what} must have min at most max, got [${String(min)}, ${String(max)}]`);
  }
  return [min as number, max as number];
}

function checkRate(rate: unknown, what: string): number {
  if (typeof rate !== 'number' || !(rate > 0 && rate <= 1)) {
    throw new TypeError(
      `${what}: rate must be a number above 0 and at most 1, got ${describe(rate)}`,
    );
  }
  return rate;
}
