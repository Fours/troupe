// N actor systems on one ManualScheduler and one network (milestone 4, T2), with settle and
// advance across all of them, as the testkit has for one system. Each node records its events and
// logs, and is seeded from the cluster's seed, so a run on the in-memory network repeats exactly.
// The same nodes can run on TCP over loopback instead (T3), so one suite tests both transports.
// With `membership`, each node joins the cluster (T4) rather than starting remoting alone, and
// with `sharding` too, every node shares one in-memory shard store (T6). Killing a node cuts it
// off from the store first, as a dead process can't reach Postgres, so its leases expire rather
// than being released.

import {
  startCluster,
  type Cluster,
  type ClusterInternals,
  type ClusterOptions,
} from '../../src/cluster/membership.js';
import { inMemoryNetwork } from '../../src/cluster/memory.js';
import { inMemoryShardStore } from '../../src/cluster/shard-memory.js';
import type { ShardStore } from '../../src/cluster/shard-store.js';
import type { LeaseOptions } from '../../src/cluster/sharding.js';
import { startRemoting, type Remoting, type RemotingOptions } from '../../src/cluster/remoting.js';
import type { Transport } from '../../src/cluster/transport.js';
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

/** Which network a test cluster runs on. */
export type NetworkKind = 'memory' | 'tcp';

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
  /** Give every node the cluster's shared shard store, with these lease timings. */
  sharding?: { leases?: LeaseOptions };
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
  /** The shard store every node shares, with `sharding`, on the scheduler's clock. */
  readonly store: ShardStore;
  /** The live node at each index. `restart` replaces one. Unstarted ones are missing. */
  readonly nodes: TestNode[];
  /** Every incarnation of every node, in the order they started, killed ones included. */
  readonly incarnations: readonly TestNode[];
  node(i: number): TestNode;
  /** Runs everything that needs no time to pass, on every node, until all are idle. */
  settle(): Promise<void>;
  /** Moves virtual time forward, firing timers in order and settling after each due time. */
  advance(ms: number): Promise<void>;
  /** Kills node `i` as `kill -9` would: the network drops it, and its system goes. */
  kill(i: number): void;
  /** Starts a new incarnation at node `i`'s address, with a new uid. */
  restart(i: number): Promise<TestNode>;
  /** Starts node `i`, which hasn't been started, once its transport is listening. */
  start(i: number): Promise<TestNode>;
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
  const network =
    opts.network === 'tcp'
      ? await tcpTestNetwork()
      : memoryTestNetwork(inMemoryNetwork({ scheduler, latencyMs: opts.latencyMs ?? 1 }));
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
    const random = seededRandom(seed * 7919 + incarnations++);
    const handle = createSystem({ name: 'node', ...opts.system, scheduler, random, logger });
    const events: SystemEvent[] = [];
    handle.system.events.subscribe(
      (event) => events.push(event),
      opts.messages === true ? { messages: true } : undefined,
    );
    const raw = network.transport(name);
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
                shards: cutOff(store, () => reaches),
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
      logs,
      handle,
    };
    all.push(node);
    return node;
  };

  const nodes: TestNode[] = opts.startAll === false ? [] : addresses.map(start);
  await Promise.all(nodes.map((n) => n.remoting.whenListening));

  const settle = async (): Promise<void> => {
    const deadline = performance.now() + MAX_REAL_MS;
    for (let ticks = 0; ; ticks++) {
      scheduler.runReady();
      if (all.every((n) => n.handle.busy() === 0) && network.quiet()) return;
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

  return {
    scheduler,
    network,
    store,
    nodes,
    incarnations: all,
    node: (i) => {
      const node = nodes[i];
      if (node === undefined) throw new RangeError(`no node ${String(i)}`);
      return node;
    },
    settle,
    async advance(ms) {
      const target = scheduler.now() + ms;
      await settle();
      for (;;) {
        const next = scheduler.nextTimerAt();
        if (next === undefined || next > target) break;
        scheduler.advanceTo(next);
        await settle();
      }
      scheduler.advanceTo(target);
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
      const done = all.map((n) => n.system.terminate());
      await settle();
      await Promise.all(done);
      await network.close();
    },
  };
}

function memoryTestNetwork(network: ReturnType<typeof inMemoryNetwork>): TestNetwork {
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
