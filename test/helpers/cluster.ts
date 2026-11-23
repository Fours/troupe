// N actor systems on one ManualScheduler and one in-memory network (milestone 4, T2), with
// settle and advance across all of them, as the testkit has for one system. Each node records its
// events and logs, and is seeded from the cluster's seed, so a run repeats exactly.

import { inMemoryNetwork, type InMemoryNetwork } from '../../src/cluster/memory.js';
import { startRemoting, type Remoting, type RemotingOptions } from '../../src/cluster/remoting.js';
import type { Transport } from '../../src/cluster/transport.js';
import type { Logger } from '../../src/logger.js';
import { createSystem, type SystemHandle } from '../../src/system.js';
import type { LogEntry } from '../../src/testkit/kit.js';
import { ManualScheduler } from '../../src/testkit/manual-scheduler.js';
import { seededRandom } from '../../src/testkit/random.js';
import type { ActorSystem, ActorSystemOptions, SystemEvent } from '../../src/types.js';

/** One node of a test cluster. */
export interface TestNode {
  readonly address: string;
  readonly system: ActorSystem;
  readonly remoting: Remoting;
  readonly transport: Transport;
  /** Every event this node's system published, in order, messages included when asked for. */
  readonly events: SystemEvent[];
  readonly logs: LogEntry[];
  readonly handle: SystemHandle;
}

/** Options for {@link createTestCluster}. */
export interface TestClusterOptions {
  /** The nodes' addresses. Default `node-1`, `node-2`, `node-3`. */
  addresses?: readonly string[];
  /** Seeds every node's random. Default 1. */
  seed?: number;
  /** The network's latency. Default 1. */
  latencyMs?: number;
  /** The cluster's name. Default `test`. */
  cluster?: string;
  /** Record message events too. Default false. */
  messages?: boolean;
  remoting?: Omit<RemotingOptions, 'cluster' | 'transport'>;
  system?: Omit<ActorSystemOptions, 'scheduler' | 'random' | 'logger'>;
}

/** Nodes on one scheduler and one network. */
export interface TestCluster {
  readonly scheduler: ManualScheduler;
  readonly network: InMemoryNetwork;
  /** The live node at each index. `restart` replaces one. */
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
  /** Terminates every node. */
  shutdown(): Promise<void>;
}

const MAX_TICKS = 1000;

/** Makes a cluster of test nodes. Every node is listening once it resolves. */
export async function createTestCluster(opts: TestClusterOptions = {}): Promise<TestCluster> {
  const addresses = opts.addresses ?? ['node-1', 'node-2', 'node-3'];
  const seed = opts.seed ?? 1;
  const scheduler = new ManualScheduler();
  const network = inMemoryNetwork({ scheduler, latencyMs: opts.latencyMs ?? 1 });
  const all: TestNode[] = [];
  let incarnations = 0;

  const start = (address: string): TestNode => {
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
    const transport = network.transport(address);
    const remoting = startRemoting(handle.system, {
      cluster: opts.cluster ?? 'test',
      transport,
      ...opts.remoting,
    });
    const node = { address, system: handle.system, remoting, transport, events, logs, handle };
    all.push(node);
    return node;
  };

  const nodes = addresses.map(start);
  await Promise.all(nodes.map((n) => n.remoting.whenListening));

  const settle = async (): Promise<void> => {
    for (let ticks = 0; ; ticks++) {
      scheduler.runReady();
      if (all.every((n) => n.handle.busy() === 0)) return;
      if (ticks >= MAX_TICKS) throw new Error('settle: actors still busy after 1,000 ticks');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    scheduler,
    network,
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
      network.kill(node.address);
      void node.remoting.close();
      void node.system.terminate();
    },
    async restart(i) {
      const old = nodes[i];
      if (old === undefined) throw new RangeError(`no node ${String(i)}`);
      const node = start(old.address);
      nodes[i] = node;
      await node.remoting.whenListening;
      return node;
    },
    async shutdown() {
      const done = all.map((n) => n.system.terminate());
      await settle();
      await Promise.all(done);
    },
  };
}
