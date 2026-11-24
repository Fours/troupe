// The benchmark's cluster rows (milestone 4, T8; decision 0019's method). The bench's own process
// is one node, and the others are real processes on TCP loopback: bench/peer.ts for the remote
// rows, and festival-night nodes from examples/cluster/ for failover, handoff and appends. Shard
// leases live in Postgres for every multi-process row, since a cluster's nodes must share a store.
// Only the local entity rows need no database, so only they are in `--quick`.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  actor,
  createActorSystem,
  realScheduler,
  silentLogger,
  type ActorRef,
  type ActorSystem,
} from '@kylewillett/troupe';
import {
  inMemoryNetwork,
  inMemoryShardStore,
  joinCluster,
  type EntityType,
  type ShardStore,
  type Transport,
} from '@kylewillett/troupe/cluster';
import { postgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import { tcpTransport } from '@kylewillett/troupe/cluster/tcp';
import { postgresPersistence } from '@kylewillett/troupe/persistence/postgres';
import { showEntity, SHOWS, type BuyReply, type ShowCmd } from '../examples/cluster/show.ts';
import { CLUSTER, SECRET, type Pong, type PongerMsg } from './remote.ts';
import type { BenchEnv, Sample } from './scenarios.ts';
import { postgresUrl, ROOT } from './setup.ts';

const FESTIVAL = 'festival-night';
const FESTIVAL_SECRET = 'bench-festival-secret';
/** How long no shard may move before a festival cluster counts as settled. */
const QUIET_MS = 5_000;

/** Throws unless the run did the work it claims (as scenarios.ts's, which imports this file). */
function check(what: string, actual: number, expected: number): void {
  if (actual !== expected)
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

// ---- processes ----

const children = new Set<ChildProcess>();
// A bench child that fails must not leave nodes running.
process.once('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

/** A port nothing listens on now, on 127.0.0.1. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (typeof bound !== 'object' || bound === null) throw new Error('no port');
  return bound.port;
}

/** A line a process wrote, and when it arrived here. */
interface Line {
  readonly line: Readonly<Record<string, unknown>>;
  readonly at: number;
}

/** A process the bench started, which writes JSON lines. */
class Proc {
  readonly address: string;
  readonly lines: Line[] = [];
  readonly #script: string;
  readonly #env: Readonly<Record<string, string>>;
  readonly #listeners = new Set<() => void>();
  #child: ChildProcess | undefined;
  #exited: Promise<void> = Promise.resolve();
  #stderr = '';

  constructor(script: string, port: number, env: Readonly<Record<string, string>>) {
    this.address = `127.0.0.1:${String(port)}`;
    this.#script = script;
    this.#env = env;
  }

  /** Starts it, and resolves once it says it's up. */
  async start(timeoutMs = 30_000): Promise<void> {
    const from = this.lines.length;
    const child = spawn(process.execPath, [join(ROOT, this.#script)], {
      cwd: ROOT,
      env: { ...process.env, ...this.#env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    children.add(child);
    this.#stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr += chunk;
    });
    createInterface({ input: child.stdout }).on('line', (text) => {
      try {
        this.lines.push({
          line: JSON.parse(text) as Record<string, unknown>,
          at: performance.now(),
        });
      } catch {
        return;
      }
      for (const listener of [...this.#listeners]) listener();
    });
    this.#exited = new Promise((resolve) => {
      child.once('exit', () => {
        children.delete(child);
        if (this.#child === child) this.#child = undefined;
        resolve();
      });
    });
    await this.until(
      `${this.#script} up`,
      () => this.lines.slice(from).some((l) => l.line['ev'] === 'up'),
      timeoutMs,
    );
  }

  /** Resolves once `check` holds, looking again after each line. */
  until(what: string, test: () => boolean, timeoutMs = 60_000): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const listener = () => {
        if (!test()) return;
        clearTimeout(deadline);
        this.#listeners.delete(listener);
        resolve();
      };
      const deadline = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(new Error(`timed out waiting for ${what}\n${this.#stderr}`));
      }, timeoutMs);
      this.#listeners.add(listener);
      this.#exited.then(
        () => {
          if (this.#child === undefined && this.#listeners.has(listener)) {
            this.#listeners.delete(listener);
            clearTimeout(deadline);
            reject(new Error(`${this.#script} exited waiting for ${what}\n${this.#stderr}`));
          }
        },
        () => undefined,
      );
    });
  }

  async kill(): Promise<void> {
    this.#child?.kill('SIGKILL');
    await this.#exited;
  }

  async stop(): Promise<void> {
    this.#child?.kill('SIGTERM');
    await this.#exited;
  }
}

/** A schema of its own for one process's runs, dropped as the process ends. */
async function freshSchema(env: BenchEnv): Promise<string> {
  const schema = `bench_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const pool = env.pool();
  await postgresShardStore({ pool, schema }).setup();
  await postgresPersistence({ pool, schema }).setup();
  env.defer(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
  return schema;
}

/** Joins this process to a cluster as a node that only routes, on TCP. */
async function router(opts: {
  name: string;
  secret: string;
  seeds: readonly string[];
  store: ShardStore;
  yieldAfter?: number;
}): Promise<{ system: ActorSystem; cluster: ReturnType<typeof joinCluster> }> {
  const system = createActorSystem({
    name: opts.name,
    logger: silentLogger,
    ...(opts.yieldAfter === undefined ? {} : { yieldAfter: opts.yieldAfter }),
  });
  const port = await freePort();
  const cluster = joinCluster(system, {
    name: opts.name,
    transport: tcpTransport({ port, secret: opts.secret }),
    seeds: opts.seeds,
    shards: opts.store,
  });
  await cluster.whenUp;
  return { system, cluster };
}

// ---- ping-pong through any ref ----

/**
 * A pinger that tells `target` a ping, with itself as the reply-to, `rounds` times, one at a
 * time. Resolves with the time from the first ping to the last pong.
 */
async function pingPongVia(
  system: ActorSystem,
  target: ActorRef<PongerMsg>,
  rounds: number,
): Promise<number> {
  let resolve = (): void => undefined;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  let pongs = 0;
  let started = 0;
  const pinger = system.spawn(
    actor<Pong | { readonly type: 'start' }, null>({
      initial: null,
      receive: (state, msg, ctx) => {
        if (msg.type === 'start') {
          started = performance.now();
        } else if (++pongs === rounds) {
          resolve();
          return state;
        }
        target.tell({ type: 'ping', replyTo: ctx.self });
        return state;
      },
    }),
    `pinger-${randomUUID().slice(0, 8)}`,
  );
  pinger.tell({ type: 'start' });
  await done;
  const ms = performance.now() - started;
  system.stop(pinger);
  check('pongs', pongs, rounds);
  return ms;
}

// ---- the local entity rows ----

/**
 * Ping-pong where every ping goes through an entity ref whose shard is on this node, on a cluster
 * of one, and every pong comes back on a plain ref. Against `ping-pong`, the difference is what
 * always encoding messages to entities costs (decision 0025, milestone 4 open question 3).
 */
export async function entityTellLocal(messages: number, yieldAfter?: number): Promise<Sample> {
  const scheduler = realScheduler();
  const system = createActorSystem({
    name: CLUSTER,
    logger: silentLogger,
    scheduler,
    ...(yieldAfter === undefined ? {} : { yieldAfter }),
  });
  const transport: Transport = inMemoryNetwork({ scheduler }).transport('local');
  const cluster = joinCluster(system, {
    name: CLUSTER,
    transport,
    seeds: ['local'],
    shards: inMemoryShardStore(),
  });
  try {
    await cluster.whenUp;
    const pongers = cluster.sharding.init({ type: 'ponger', shardCount: 1, entity: ponger });
    const ref = pongers.ref('p');
    // The shard's lease and the entity's spawn happen here, untimed.
    await ref.ask<Pong>((replyTo) => ({ type: 'ping', replyTo }));
    const rounds = Math.floor(messages / 2);
    return { ops: rounds * 2, ms: await pingPongVia(system, ref, rounds) };
  } finally {
    await system.terminate();
  }
}

function ponger() {
  return actor<PongerMsg, null>({
    initial: null,
    receive: (state, msg, ctx) => {
      if (msg.type === 'ping') msg.replyTo.tell({ type: 'pong' });
      else msg.replyTo.tell({ ref: ctx.self });
      return state;
    },
  });
}

// ---- the remote rows ----

interface Remote {
  readonly system: ActorSystem;
  /** The ponger, through its entity ref: every ping goes through the regions and its shard. */
  readonly entity: ActorRef<PongerMsg>;
  /** The ponger's plain ref, on the peer: remoting and nothing else. */
  readonly direct: ActorRef<PongerMsg>;
}

let remote: Promise<Remote> | undefined;

/**
 * The peer process and this process's node in its cluster, made once per process and kept for
 * every run, warm-ups included, so both sides are warm when the timed run starts.
 */
function remotePair(env: BenchEnv): Promise<Remote> {
  remote ??= (async () => {
    const schema = await freshSchema(env);
    const peerPort = await freePort();
    const peer = new Proc('bench/peer.ts', peerPort, {
      PEER_PORT: String(peerPort),
      BENCH_SCHEMA: schema,
      TROUPE_POSTGRES_URL: postgresUrl(process.env),
    });
    await peer.start();
    const { system, cluster } = await router({
      name: CLUSTER,
      secret: SECRET,
      seeds: [peer.address],
      store: postgresShardStore({ pool: env.pool(), schema }),
    });
    env.defer(async () => {
      await system.terminate();
      await peer.stop();
    });
    const pongers = cluster.sharding.init({
      type: 'ponger',
      shardCount: 1,
      entity: ponger,
      host: false,
    });
    const entity = pongers.ref('p');
    const { ref: direct } = await entity.ask<{ ref: ActorRef<PongerMsg> }>(
      (replyTo) => ({ type: 'whoami', replyTo }),
      { timeoutMs: 30_000 },
    );
    return { system, entity, direct };
  })();
  return remote;
}

/** Ping-pong with the peer, on the ponger's plain ref or through its entity ref. */
export async function remotePingPong(
  env: BenchEnv,
  messages: number,
  via: 'direct' | 'entity',
): Promise<Sample> {
  const pair = await remotePair(env);
  const rounds = Math.floor(messages / 2);
  return { ops: rounds * 2, ms: await pingPongVia(pair.system, pair[via], rounds) };
}

/** Sequential asks of the peer's ponger, on its plain ref, each one timed. */
export async function remoteAsk(env: BenchEnv, asks: number): Promise<Sample> {
  const { direct } = await remotePair(env);
  const latenciesMs: number[] = [];
  const start = performance.now();
  for (let i = 0; i < asks; i++) {
    const t = performance.now();
    await direct.ask<Pong>((replyTo) => ({ type: 'ping', replyTo }));
    latenciesMs.push(performance.now() - t);
  }
  const ms = performance.now() - start;
  check('replies', latenciesMs.length, asks);
  return { ops: asks, ms, latenciesMs };
}

// ---- festival night: three node processes and this one, which routes ----

interface Festival {
  readonly nodes: readonly Proc[];
  readonly shows: EntityType<ShowCmd>;
  /** Who holds each shard now, by the nodes' lines. */
  holders(): Map<number, string>;
  /** Resolves once no shard has been acquired or released for {@link QUIET_MS}. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

/** Starts three festival-night nodes from examples/cluster/, and joins them as a router. */
async function festival(
  env: BenchEnv,
  opts: { shardCount: number; timings?: Readonly<Record<string, unknown>> },
): Promise<Festival> {
  const schema = await freshSchema(env);
  const ports = [await freePort(), await freePort(), await freePort()];
  const seeds = ports.map((p) => `127.0.0.1:${String(p)}`);
  const nodes = ports.map(
    (port) =>
      new Proc('examples/cluster/node.ts', port, {
        CLUSTER_SECRET: FESTIVAL_SECRET,
        NODE_PORT: String(port),
        SEEDS: seeds.join(','),
        TROUPE_POSTGRES_URL: postgresUrl(process.env),
        TROUPE_SCHEMA: schema,
        SHARD_COUNT: String(opts.shardCount),
        ...(opts.timings === undefined ? {} : { TIMINGS: JSON.stringify(opts.timings) }),
      }),
  );
  await Promise.all(nodes.map((n) => n.start()));
  const pool = env.pool();
  const { system, cluster } = await router({
    name: FESTIVAL,
    secret: FESTIVAL_SECRET,
    seeds,
    store: postgresShardStore({ pool, schema }),
  });
  const shows = cluster.sharding.init({
    type: 'show',
    // Never called: this node only routes.
    entity: showEntity(postgresPersistence({ pool, schema }), 'bench'),
    shardCount: opts.shardCount,
    host: false,
  });

  const holders = () => {
    const out = new Map<number, string>();
    const all = nodes
      .flatMap((n) => n.lines)
      .filter((l) => l.line['ev'] === 'shardAcquired' || l.line['ev'] === 'shardReleased')
      .sort((a, b) => a.at - b.at);
    for (const { line } of all) {
      const shard = line['shard'] as number;
      const node = line['node'] as string;
      if (line['ev'] === 'shardAcquired') out.set(shard, node);
      else if (out.get(shard) === node) out.delete(shard);
    }
    return out;
  };
  const lastMove = () =>
    Math.max(
      0,
      ...nodes.flatMap((n) =>
        n.lines
          .filter((l) => l.line['ev'] === 'shardAcquired' || l.line['ev'] === 'shardReleased')
          .map((l) => l.at),
      ),
    );
  const settled = async () => {
    for (;;) {
      const quietFor = performance.now() - lastMove();
      if (quietFor >= QUIET_MS) return;
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS - quietFor));
    }
  };
  const close = async () => {
    await system.terminate();
    await Promise.all(nodes.map((n) => n.stop()));
  };
  return { nodes, shows, holders, settled, close };
}

/** A buy, answered or not. Never throws. */
async function tryBuy(
  ref: ActorRef<ShowCmd>,
  timeoutMs: number,
): Promise<Extract<BuyReply, { ok: true }> | undefined> {
  try {
    const reply = await ref.ask<BuyReply>(
      (replyTo) => ({ type: 'buy', customer: 'bench', seats: 1, replyTo }),
      { timeoutMs },
    );
    return reply.ok ? reply : undefined;
  } catch {
    return undefined;
  }
}

/** The address an incarnation ran on, from `<address>#<uid>:<n>`. */
function addressOf(inc: string): string {
  return inc.slice(0, inc.indexOf('#'));
}

/**
 * `kill -9` of the node holding a show's shard, to the first answer from another node, `kills`
 * times, with the default timings. A buy goes every 100 ms, each waiting up to 30 s, so the
 * measure is within 100 ms of when the show could first answer. Between kills, the killed node
 * restarts and the cluster settles.
 */
export async function failover(env: BenchEnv, kills: number): Promise<Sample> {
  const c = await festival(env, { shardCount: 32 });
  try {
    const latenciesMs: number[] = [];
    const start = performance.now();
    for (let k = 0; k < kills; k++) {
      const ref = c.shows.ref(SHOWS[k % SHOWS.length] ?? 'hamlet');
      let first: Extract<BuyReply, { ok: true }> | undefined;
      while (first === undefined) first = await tryBuy(ref, 30_000);
      const victimAddress = addressOf(first.inc);
      const victim = c.nodes.find((n) => n.address === victimAddress);
      if (victim === undefined) throw new Error(`no node at ${victimAddress}`);

      const killedAt = performance.now();
      await victim.kill();
      const back = await new Promise<number>((resolve) => {
        let done = false;
        const probe = () => {
          if (done) return;
          void tryBuy(ref, 30_000).then((reply) => {
            if (done || reply === undefined || addressOf(reply.inc) === victimAddress) return;
            done = true;
            clearInterval(timer);
            resolve(performance.now() - killedAt);
          });
        };
        const timer = setInterval(probe, 100);
        probe();
      });
      latenciesMs.push(back);
      await victim.start();
      await c.settled();
    }
    return { ops: kills, ms: performance.now() - start, latenciesMs };
  } finally {
    await c.close();
  }
}

/**
 * A graceful leave of the node holding the most of 64 shards, about a third, from SIGTERM to the
 * last of its shards acquired by another node.
 */
export async function handoff(env: BenchEnv, shardCount: number): Promise<Sample> {
  // A shorter seed timeout, so the three nodes form a cluster sooner. The leave doesn't use it.
  const c = await festival(env, { shardCount, timings: { seedTimeoutMs: 1_000 } });
  try {
    // Entities until every shard has one, each started by a buy.
    for (let batch = 0; c.holders().size < shardCount; batch++) {
      if (batch === 8) throw new Error(`only ${String(c.holders().size)} shards in use`);
      const ids = Array.from({ length: 128 }, (_, i) => `e-${String(batch * 128 + i)}`);
      await Promise.all(ids.map((id) => tryBuy(c.shows.ref(id), 30_000)));
    }
    await c.settled();
    const holders = c.holders();
    const count = (key: string) => [...holders.values()].filter((h) => h === key).length;
    const keys = [...new Set(holders.values())].sort((a, b) => count(b) - count(a));
    const leaverKey = keys[0] ?? '';
    const leaver = c.nodes.find((n) => leaverKey.startsWith(`${n.address}#`));
    if (leaver === undefined) throw new Error('no node holds a shard');
    const moving = [...holders].filter(([, h]) => h === leaverKey).map(([s]) => s);

    const leftAt = performance.now();
    const stopping = leaver.stop();
    const others = c.nodes.filter((n) => n !== leaver);
    const acquiredElsewhere = () => {
      const now = c.holders();
      return moving.every((s) => {
        const h = now.get(s);
        return h !== undefined && h !== leaverKey;
      });
    };
    await Promise.race(
      others.map((n) => n.until('the shards acquired elsewhere', acquiredElsewhere)),
    );
    const last = Math.max(
      ...others.flatMap((n) =>
        n.lines
          .filter((l) => l.at >= leftAt && l.line['ev'] === 'shardAcquired')
          .filter((l) => moving.includes(l.line['shard'] as number))
          .map((l) => l.at),
      ),
    );
    await stopping;
    const ms = last - leftAt;
    return { ops: moving.length, ms, latenciesMs: [ms] };
  } finally {
    await c.close();
  }
}

/**
 * Buys at `entities` shows at once, `buysPerEntity` each, one after another per show, across three
 * nodes and one Postgres journal: appends a second, against `journal-postgres-100`'s one process
 * (milestone 4, open question 8).
 */
export async function clusterAppends(
  env: BenchEnv,
  entities: number,
  buysPerEntity: number,
): Promise<Sample> {
  const c = await festival(env, { shardCount: 32, timings: { seedTimeoutMs: 1_000 } });
  try {
    const refs = Array.from({ length: entities }, (_, i) => c.shows.ref(`a-${String(i)}`));
    // Every shard acquired and every entity recovered, untimed.
    await Promise.all(refs.map((ref) => tryBuy(ref, 30_000)));
    await c.settled();
    let acked = 0;
    const start = performance.now();
    await Promise.all(
      refs.map(async (ref) => {
        for (let i = 0; i < buysPerEntity; i++) {
          const reply = await tryBuy(ref, 30_000);
          if (reply !== undefined) acked++;
        }
      }),
    );
    const ms = performance.now() - start;
    check('acknowledged buys', acked, entities * buysPerEntity);
    return { ops: acked, ms };
  } finally {
    await c.close();
  }
}
