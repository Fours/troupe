// N actor systems on one ManualScheduler and one network (milestone 4, T2), with settle and
// advance across all of them, as the testkit has for one system. Each node records its events and
// logs, and is seeded from the cluster's seed, so a run on the in-memory network repeats exactly.
// The same nodes can run on TCP over loopback instead (T3), so one suite tests both transports.
// With `membership`, each node joins the cluster (T4) rather than starting remoting alone, and
// with `sharding` too, every node shares one in-memory shard store (T6). Killing a node cuts it
// off from the store first, as a dead process can't reach Postgres, so its leases expire rather
// than being released. With `clocks` (milestone 5, T1), each incarnation gets a clock of its own
// on one simulation clock, with drift, and settle and advance go through Rehearsal's run loop.

import {
  startCluster,
  type Cluster,
  type ClusterInternals,
  type ClusterOptions,
} from '../../src/cluster/membership.js';
import { inMemoryNetwork } from '../../src/cluster/memory.js';
import { inMemoryShardStore } from '../../src/cluster/shard-memory.js';
import { fnv1a } from '../../src/hash.js';
import { NodeClock, throughClock } from '../../src/rehearsal/clock.js';
import { RunLoop } from '../../src/rehearsal/loop.js';
import {
  simulatedNetwork,
  type SimulatedNetwork,
  type SimulatedNetworkOptions,
} from '../../src/rehearsal/network.js';
import type { ShardStore } from '../../src/cluster/shard-store.js';
import type { LeaseOptions } from '../../src/cluster/sharding.js';
import { startRemoting, type Remoting, type RemotingOptions } from '../../src/cluster/remoting.js';
import type { Connection, Transport } from '../../src/cluster/transport.js';
import type { Logger } from '../../src/logger.js';
import { createSystem, type SystemHandle } from '../../src/system.js';
import type { LogEntry } from '../../src/testkit/kit.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../src/testkit/random.js';
import type { ActorSystem, ActorSystemOptions, SystemEvent } from '../../src/types.js';
import { tcpTestNetwork } from './tcp-network.js';

/** The network under a test cluster: nodes by name, each with an address on it. */
export interface TestNetwork {
  /** Whether frames take real I/O, so settling has to wait for the network too. */
  readonly real: boolean;
  /** The address the node named `name` has, or would have. */
  address(name: string): string;
  /** A transport for the node named `name`. */
  transport(name: string): Transport;
  /** Kills the node named `name`, as `kill -9` would. */
  kill(name: string): void;
  /** Whether nothing is on its way: no dial, frame or close. */
  quiet(): boolean;
  /** Closes every transport still open. */
  close(): Promise<void>;
}

/** Which network a test cluster runs on: `simulated` is Rehearsal's (milestone 5, T2). */
export type NetworkKind = 'memory' | 'tcp' | 'simulated';

/** One node of a test cluster. */
export interface TestNode {
  /** Its name, such as `node-1`, which is its address on the in-memory network. */
  readonly name: string;
  readonly address: string;
  readonly system: ActorSystem;
  readonly remoting: Remoting;
  /** Its place in the cluster, with `membership`. */
  readonly cluster: Cluster | undefined;
  /** Whether the node can reach the shard store: false once it's killed. */
  readonly reachesStore: () => boolean;
  /** Cuts the node off from the shard store, or reconnects it, as a partition from Postgres. */
  setReachesStore(reaches: boolean): void;
  readonly transport: Transport;
  /** Every event this node's system published, in order, messages included when asked for. */
  readonly events: SystemEvent[];
  /**
   * The simulation time of each event, by index. On a shared clock it's the event's own `at`.
   * With `clocks`, `at` is the node's own reading, which drifts, so compare these across nodes.
   */
  readonly times: number[];
  /** Its clock, with `clocks`: pause and resume it to stop the node's process. */
  readonly clock: NodeClock | undefined;
  readonly logs: LogEntry[];
  readonly handle: SystemHandle;
}

/** Options for {@link createTestCluster}. */
export interface TestClusterOptions {
  /** The nodes' names. Default `node-1`, `node-2`, `node-3`. */
  addresses?: readonly string[];
  /** The network they're on. Default `memory`. */
  network?: NetworkKind;
  /** Seeds every node's random. Default 1. */
  seed?: number;
  /** The in-memory network's latency. Default 1. */
  latencyMs?: number;
  /** The simulated network's options. Its random is drawn from the seed. */
  simulated?: Omit<SimulatedNetworkOptions, 'scheduler' | 'random'>;
  /** The cluster's name. Default `test`. */
  cluster?: string;
  /** Record message events too. Default false. */
  messages?: boolean;
  remoting?: Omit<RemotingOptions, 'cluster' | 'transport'>;
  /**
   * Join each node to the cluster with these options. `seeds` defaults to every address, in
   * order.
   */
  membership?: Partial<Omit<ClusterOptions, 'name' | 'transport'>> & ClusterInternals;
  /**
   * Give every node the cluster's shared shard store, with these lease timings. `wrapStore`
   * wraps the store each node sees, to inject a fault.
   */
  sharding?: { leases?: LeaseOptions; wrapStore?: (store: ShardStore) => ShardStore };
  /**
   * Give each incarnation its own clock on the cluster's scheduler, which becomes simulation time,
   * with a drift drawn within ±`driftPpm` (default 200), and settle and advance through
   * Rehearsal's run loop, with its stall check. Not on TCP.
   */
  clocks?: { driftPpm?: number; stallAfterMs?: number };
  /** Start every node at once. Default true. Otherwise `start(i)` starts each. */
  startAll?: boolean;
  /** Wraps each node's transport, to inject a fault. */
  wrap?: (name: string, transport: Transport) => Transport;
  system?: Omit<ActorSystemOptions, 'scheduler' | 'random' | 'logger'>;
}

/** Nodes on one scheduler and one network. */
export interface TestCluster {
  readonly scheduler: ManualScheduler;
  readonly network: TestNetwork;
  /** The simulated network, to inject faults into, on `network: 'simulated'`. */
  readonly simulated: SimulatedNetwork | undefined;
  /** The shard store every node shares, with `sharding`, on the scheduler's clock. */
  readonly store: ShardStore;
  /** The live node at each index. `restart` replaces one. Unstarted ones are missing. */
  readonly nodes: TestNode[];
  /** Every incarnation of every node, in the order they started, killed ones included. */
  readonly incarnations: readonly TestNode[];
  node(i: number): TestNode;
  /** Runs everything that needs no time to pass, on every node, until all are idle. */
  settle(): Promise<void>;
  /**
   * Lets one actor stay busy on a promise the test holds, such as a held journal append, without
   * `settle` giving up on it. Call what it returns once the promise is let go.
   */
  hold(): () => void;
  /** Moves virtual time forward, firing timers in order and settling after each due time. */
  advance(ms: number): Promise<void>;
  /** Kills node `i` as `kill -9` would: the network drops it, and its system goes. */
  kill(i: number): void;
  /** Starts a new incarnation at node `i`'s address, with a new uid. */
  restart(i: number): Promise<TestNode>;
  /** Starts node `i`, which hasn't been started, once its transport is listening. */
  start(i: number): Promise<TestNode>;
  /**
   * Terminates node `i`, advancing virtual time until it has: a node that terminates leaves
   * gracefully, handing its shards off over the network.
   */
  terminate(i: number): Promise<void>;
  /** Terminates every node, and closes the network. */
  shutdown(): Promise<void>;
}

const MAX_TICKS = 1000;
// Real I/O needs many more turns of the event loop than the in-memory network's scheduler does.
const MAX_REAL_MS = 10_000;

/** Makes a cluster of test nodes. Every node is listening once it resolves. */
export async function createTestCluster(opts: TestClusterOptions = {}): Promise<TestCluster> {
  const addresses = opts.addresses ?? ['node-1', 'node-2', 'node-3'];
  const seed = opts.seed ?? 1;
  const scheduler = new ManualScheduler();
  if (opts.clocks !== undefined && opts.network === 'tcp') {
    throw new TypeError('createTestCluster: clocks need an in-process network');
  }
  const loop =
    opts.clocks === undefined
      ? undefined
      : new RunLoop(
          scheduler,
          opts.clocks.stallAfterMs === undefined ? {} : { stallAfterMs: opts.clocks.stallAfterMs },
        );
  const simulated =
    opts.network === 'simulated'
      ? simulatedNetwork({
          ...opts.simulated,
          scheduler,
          random: seededRandom(fnv1a(`network ${String(seed)}`)),
        })
      : undefined;
  const network =
    opts.network === 'tcp'
      ? await tcpTestNetwork()
      : memoryTestNetwork(
          simulated ?? inMemoryNetwork({ scheduler, latencyMs: opts.latencyMs ?? 1 }),
        );
  const all: TestNode[] = [];
  let incarnations = 0;
  const store = inMemoryShardStore({ clock: () => scheduler.now() });

  const start = (name: string): TestNode => {
    const logs: LogEntry[] = [];
    const record =
      (level: LogEntry['level']) =>
      (msg: string, fields?: Record<string, unknown>): void => {
        logs.push(fields === undefined ? { level, msg } : { level, msg, fields });
      };
    const logger: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    // Each incarnation gets its own stream, so a restart draws a new uid.
    const incarnation = incarnations++;
    const random = seededRandom(seed * 7919 + incarnation);
    let clock: NodeClock | undefined;
    if (opts.clocks !== undefined) {
      // Its own stream too, so drawing drift changes none of the node's own draws.
      const draw = seededRandom(fnv1a(`clock ${String(seed)} ${String(incarnation)}`));
      const most = opts.clocks.driftPpm ?? 200;
      clock = new NodeClock(scheduler, { driftPpm: Math.round((draw() * 2 - 1) * most) });
    }
    const handle = createSystem({
      name: 'node',
      ...opts.system,
      scheduler: clock ?? scheduler,
      random,
      logger,
    });
    loop?.watch(handle, clock ?? scheduler, name);
    const events: SystemEvent[] = [];
    const times: number[] = [];
    handle.system.events.subscribe(
      (event) => {
        events.push(event);
        times.push(scheduler.now());
      },
      opts.messages === true ? { messages: true } : undefined,
    );
    const direct = network.transport(name);
    const raw = clock === undefined ? direct : throughClock(direct, clock);
    const transport = opts.wrap === undefined ? raw : opts.wrap(name, raw);
    const address = transport.address;
    let remoting: Remoting;
    let cluster: Cluster | undefined;
    let reaches = true;
    if (opts.membership === undefined) {
      remoting = startRemoting(handle.system, {
        cluster: opts.cluster ?? 'test',
        transport,
        ...opts.remoting,
      });
    } else {
      const { pruneAfterMs, ...membership } = opts.membership;
      ({ cluster, remoting } = startCluster(
        handle.system,
        {
          name: opts.cluster ?? 'test',
          transport,
          seeds: addresses.map((a) => network.address(a)),
          ...(opts.sharding === undefined
            ? {}
            : {
                shards: cutOff(opts.sharding.wrapStore?.(store) ?? store, () => reaches),
                ...(opts.sharding.leases === undefined ? {} : { leases: opts.sharding.leases }),
              }),
          ...membership,
        },
        pruneAfterMs === undefined ? {} : { pruneAfterMs },
      ));
    }
    const node = {
      name,
      address,
      system: handle.system,
      remoting,
      cluster,
      reachesStore: () => reaches,
      setReachesStore: (value: boolean) => {
        reaches = value;
      },
      transport,
      events,
      times,
      clock,
      logs,
      handle,
    };
    all.push(node);
    return node;
  };

  const nodes: TestNode[] = opts.startAll === false ? [] : addresses.map(start);
  await Promise.all(nodes.map((n) => n.remoting.whenListening));

  let held = 0;
  const settle = async (): Promise<void> => {
    if (loop !== undefined) {
      await loop.settle();
      return;
    }
    const deadline = performance.now() + MAX_REAL_MS;
    for (let ticks = 0; ; ticks++) {
      scheduler.runReady();
      const busy = all.reduce((sum, n) => sum + n.handle.busy(), 0);
      if (busy <= held && network.quiet()) return;
      if (!network.real && ticks >= MAX_TICKS) {
        throw new Error('settle: actors still busy after 1,000 ticks');
      }
      if (network.real && performance.now() > deadline) {
        throw new Error('settle: actors or the network still busy after 10 s');
      }
      // A macrotask, so promises settle. setImmediate, not setTimeout, which Node holds for at
      // least a millisecond: the in-process invariant test ran 40 times slower on it.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  };

  /** Advances in steps until `promise` settles, for at most `maxMs`. */
  const until = async (promise: Promise<unknown>, maxMs: number, what: string): Promise<void> => {
    const state = { finished: false };
    const watched = promise.then(() => {
      state.finished = true;
    });
    for (let waited = 0; !state.finished && waited < maxMs; waited += 100) await advance(100);
    await settle();
    if (!state.finished) throw new Error(`${what} still hadn’t finished after ${String(maxMs)} ms`);
    await watched;
  };

  async function advance(ms: number): Promise<void> {
    if (loop !== undefined) {
      await loop.advance(ms);
      return;
    }
    const target = scheduler.now() + ms;
    await settle();
    for (;;) {
      const next = scheduler.nextTimerAt();
      if (next === undefined || next > target) break;
      scheduler.advanceTo(next);
      await settle();
    }
    scheduler.advanceTo(target);
  }

  return {
    scheduler,
    network,
    simulated,
    store,
    nodes,
    incarnations: all,
    node: (i) => {
      const node = nodes[i];
      if (node === undefined) throw new RangeError(`no node ${String(i)}`);
      return node;
    },
    settle,
    hold() {
      held++;
      let released = false;
      return () => {
        if (!released) held--;
        released = true;
      };
    },
    advance,
    async terminate(i) {
      const node = nodes[i];
      if (node === undefined) throw new RangeError(`no node ${String(i)}`);
      await until(node.system.terminate(), 60_000, `terminating ${node.name}`);
    },
    kill(i) {
      const node = nodes[i];
      if (node === undefined) throw new RangeError(`no node ${String(i)}`);
      node.setReachesStore(false);
      network.kill(node.name);
      void node.remoting.close();
      void node.system.terminate();
    },
    async restart(i) {
      const old = nodes[i];
      if (old === undefined) throw new RangeError(`no node ${String(i)}`);
      const node = start(old.name);
      nodes[i] = node;
      await node.remoting.whenListening;
      return node;
    },
    async start(i) {
      const name = addresses[i];
      if (name === undefined) throw new RangeError(`no node ${String(i)}`);
      if (nodes[i] !== undefined) throw new Error(`node ${String(i)} has started already`);
      const node = start(name);
      nodes[i] = node;
      await node.remoting.whenListening;
      return node;
    },
    async shutdown() {
      // A node that terminates leaves gracefully, handing its shards off over the network, so
      // virtual time has to pass for it to finish.
      await until(Promise.all(all.map((n) => n.system.terminate())), 60_000, 'shutdown');
      await network.close();
    },
  };
}

function memoryTestNetwork(network: Pick<SimulatedNetwork, 'transport' | 'kill'>): TestNetwork {
  const live = new Set<Transport>();
  return {
    real: false,
    address: (name) => name,
    transport: (name) => {
      const transport = network.transport(name);
      live.add(transport);
      return transport;
    },
    kill: (name) => {
      network.kill(name);
    },
    quiet: () => true,
    close: async () => {
      await Promise.all([...live].map((t) => t.close()));
    },
  };
}

/** `store`, as one node reaches it: every call fails once `reaches` says it can't. */
function cutOff(store: ShardStore, reaches: () => boolean): ShardStore {
  const gate =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      reaches() ? call(...args) : Promise.reject(new Error('the node cannot reach the store'));
  return {
    acquire: gate(store.acquire.bind(store)),
    renewAll: gate(store.renewAll.bind(store)),
    release: gate(store.release.bind(store)),
    holders: gate(store.holders.bind(store)),
    remember: gate(store.remember.bind(store)),
    forget: gate(store.forget.bind(store)),
    remembered: gate(store.remembered.bind(store)),
  };
}

/** Timings scaled down, so failover takes a few virtual seconds. */
export const FAST: Pick<TestClusterOptions, 'membership' | 'sharding'> = {
  membership: {
    heartbeatMs: 200,
    unreachableAfterMs: 1_000,
    downAfterMs: 1_000,
    seedTimeoutMs: 500,
  },
  sharding: { leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 } },
};

/** Wraps a transport so that, while `isolated()`, no frame gets in or out. */
export function isolatable(inner: Transport, isolated: () => boolean): Transport {
  const wrap = (c: Connection): Connection => ({
    send: (frame) => {
      if (!isolated()) c.send(frame);
    },
    onFrame: (listener) => {
      c.onFrame((frame) => {
        if (!isolated()) listener(frame);
      });
    },
    onClose: (listener) => {
      c.onClose(listener);
    },
    close: () => {
      c.close();
    },
  });
  return {
    address: inner.address,
    listen: (onConnection, onRefused) =>
      inner.listen((c) => {
        onConnection(wrap(c));
      }, onRefused),
    connect: (address) => wrap(inner.connect(address)),
    close: () => inner.close(),
  };
}
