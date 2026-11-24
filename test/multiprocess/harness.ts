// Real processes for the multi-process tests (milestone 4, T8): festival-night nodes and a crowd
// from examples/cluster/, against dist/, on TCP over loopback and the test Postgres, each test on
// a fresh schema. Every process writes JSON lines (examples/cluster/log.ts), and the harness keeps
// them in the order they arrive, with the time each arrived on this process's clock.
//
// Tests wait for lines, never for a fixed time. The only timers here are deadlines, after which a
// wait fails and says what it was waiting for.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { desiredOwner, shardOf } from '../../src/cluster/placement.js';
import { freePort } from '../helpers/tcp-network.js';
import { dropSchema, freshSchema, postgresUrl, testPool } from '../helpers/postgres.js';

const ROOT = resolve(import.meta.dirname, '../..');
const SECRET = 'multiprocess-secret';
/** What examples/cluster/env.ts defaults to. */
export const SHARD_COUNT = 32;
export const TYPE = 'show';

/** One line a process wrote. */
export interface Line {
  readonly ev: string;
  readonly [key: string]: unknown;
}

/** A line, who wrote it and when it arrived, by `performance.now()` here. */
export interface Seen {
  readonly from: string;
  readonly line: Line;
  readonly at: number;
}

/** The timings a test passes to every process, as examples/cluster/env.ts reads TIMINGS. */
export type Timings = Readonly<Record<string, unknown>>;

/** One process: a node or the crowd, at a fixed port, started and restarted by the harness. */
export class Proc {
  readonly name: string;
  readonly address: string;
  readonly #script: string;
  readonly #env: Readonly<Record<string, string>>;
  #child: ChildProcess | undefined;
  #exited: Promise<number | null> = Promise.resolve(null);
  #stderr = '';
  /** This incarnation's holder name, `<address>#<uid>`, once it's up. */
  key: string | undefined;

  constructor(
    name: string,
    port: number,
    script: string,
    env: Readonly<Record<string, string>>,
    private readonly onLine: (seen: Seen) => void,
  ) {
    this.name = name;
    this.address = `127.0.0.1:${String(port)}`;
    this.#script = script;
    this.#env = { ...env, NODE_PORT: String(port) };
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  /** What the process wrote to stderr, for a failure's message. */
  get stderr(): string {
    return this.#stderr;
  }

  start(): void {
    if (this.#child !== undefined) throw new Error(`${this.name} is already running`);
    this.key = undefined;
    this.#stderr = '';
    const child = spawn(process.execPath, [resolve(ROOT, 'examples/cluster', this.#script)], {
      cwd: ROOT,
      env: { ...process.env, ...this.#env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (text) => {
      let line: Line;
      try {
        line = JSON.parse(text) as Line;
      } catch {
        line = { ev: 'text', text };
      }
      if (line.ev === 'up' && typeof line['node'] === 'string') this.key = line['node'];
      this.onLine({ from: this.name, line, at: performance.now() });
    });
    this.#exited = new Promise((done) => {
      child.once('exit', (code) => {
        if (this.#child === child) this.#child = undefined;
        done(code);
      });
    });
  }

  /** `kill -9`: no goodbye, no handoff. Resolves once the process has gone. */
  async kill(): Promise<void> {
    this.#child?.kill('SIGKILL');
    await this.#exited;
  }

  /** SIGTERM: a graceful leave. Resolves with the exit code once the process has gone. */
  async stop(): Promise<number | null> {
    this.#child?.kill('SIGTERM');
    return this.#exited;
  }
}

/** Three hosting nodes, or as many as asked for, and a crowd, on one fresh schema. */
export class TestCluster {
  readonly schema: string;
  readonly nodes: readonly Proc[];
  readonly crowd: Proc;
  readonly seen: Seen[] = [];
  readonly #waiters = new Set<(seen: Seen) => void>();

  private constructor(schema: string, ports: readonly number[], crowdPort: number, opts: Options) {
    this.schema = schema;
    const seeds = ports.map((p) => `127.0.0.1:${String(p)}`).join(',');
    const env: Record<string, string> = {
      CLUSTER_SECRET: SECRET,
      SEEDS: seeds,
      TROUPE_POSTGRES_URL: postgresUrl(process.env),
      TROUPE_SCHEMA: schema,
      SHARD_COUNT: String(SHARD_COUNT),
      ...(opts.timings === undefined ? {} : { TIMINGS: JSON.stringify(opts.timings) }),
    };
    const onLine = (seen: Seen) => {
      this.seen.push(seen);
      for (const waiter of [...this.#waiters]) waiter(seen);
    };
    this.nodes = ports.map(
      (port, i) => new Proc(`node-${String(i + 1)}`, port, 'node.ts', env, onLine),
    );
    this.crowd = new Proc(
      'crowd',
      crowdPort,
      'crowd.ts',
      {
        ...env,
        ASK_TIMEOUT_MS: String(opts.askTimeoutMs ?? 2_000),
        PAUSE_MS: String(opts.pauseMs ?? 100),
      },
      onLine,
    );
  }

  /** Starts the nodes, waits for each to be up, then starts the crowd and waits for it too. */
  static async start(opts: Options = {}): Promise<TestCluster> {
    const schema = freshSchema();
    const ports: number[] = [];
    for (let i = 0; i < (opts.nodes ?? 3); i++) ports.push(await freePort());
    const cluster = new TestCluster(schema, ports, await freePort(), opts);
    for (const node of cluster.nodes) node.start();
    await Promise.all(cluster.nodes.map((node) => cluster.up(node)));
    cluster.crowd.start();
    await cluster.up(cluster.crowd);
    return cluster;
  }

  /** Waits for `proc`'s current incarnation to say it's up. */
  async up(proc: Proc, timeoutMs = 30_000): Promise<void> {
    if (proc.key !== undefined) return;
    await this.waitFor(`${proc.name} up`, (s) => s.from === proc.name && s.line.ev === 'up', {
      timeoutMs,
      since: 0,
      proc,
    });
  }

  /** Restarts a node that was killed or stopped, at the same address, and waits for it. */
  async restart(proc: Proc, timeoutMs = 30_000): Promise<void> {
    const since = this.seen.length;
    proc.start();
    await this.waitFor(`${proc.name} up again`, (s) => s.from === proc.name && s.line.ev === 'up', {
      timeoutMs,
      since,
      proc,
    });
  }

  /**
   * Resolves with the first line from `since` (an index into `seen`, default now) that `match`
   * accepts. Fails after `timeoutMs`, naming `what`, with the last lines and `proc`'s stderr.
   */
  waitFor(
    what: string,
    match: (seen: Seen) => boolean,
    opts: { timeoutMs?: number; since?: number; proc?: Proc } = {},
  ): Promise<Seen> {
    const { timeoutMs = 30_000, since = this.seen.length } = opts;
    const found = this.seen.slice(since).find(match);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((done, fail) => {
      const waiter = (seen: Seen) => {
        if (!match(seen)) return;
        clearTimeout(deadline);
        this.#waiters.delete(waiter);
        done(seen);
      };
      const deadline = setTimeout(() => {
        this.#waiters.delete(waiter);
        const tail = this.seen
          .slice(-20)
          .map((s) => `${s.from}: ${JSON.stringify(s.line)}`)
          .join('\n');
        const stderr =
          opts.proc === undefined ? '' : `\n${opts.proc.name} stderr:\n${opts.proc.stderr}`;
        fail(
          new Error(
            `timed out after ${String(timeoutMs)} ms waiting for ${what}\n${tail}${stderr}`,
          ),
        );
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  /** Waits until `check` holds, checking again after every line. */
  async until(what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
    if (check()) return;
    await this.waitFor(what, () => check(), { timeoutMs });
  }

  /** Who holds each shard now, by the lines so far: a shard's last acquire, unless released. */
  holders(): Map<number, string> {
    const holders = new Map<number, string>();
    for (const { line } of this.seen) {
      if (line['entityType'] !== TYPE) continue;
      const shard = line['shard'] as number;
      const node = line['node'] as string;
      if (line.ev === 'shardAcquired') holders.set(shard, node);
      else if (line.ev === 'shardReleased' && holders.get(shard) === node) holders.delete(shard);
    }
    return holders;
  }

  /** The hosting nodes that are running now. */
  live(): Proc[] {
    return this.nodes.filter((n) => n.running && n.key !== undefined);
  }

  /**
   * Whether every shard in `shards` is held by its desired owner among the live nodes, as
   * rendezvous hashing places it (decision 0030).
   */
  placed(shards: Iterable<number>): boolean {
    const live = this.live();
    const holders = this.holders();
    for (const shard of shards) {
      const owner = desiredOwner(
        `${TYPE}/${String(shard)}`,
        live.map((n) => n.address),
      );
      const holder = holders.get(shard);
      if (holder === undefined || owner === undefined || !holder.startsWith(`${owner}#`))
        return false;
      if (!live.some((n) => n.key === holder)) return false;
    }
    return true;
  }

  /** The crowd's `ack` lines from `since`. */
  acks(since = 0): Seen[] {
    return this.seen.slice(since).filter((s) => s.from === 'crowd' && s.line.ev === 'ack');
  }

  /** Lines that would mean a second live instance: a `JournalConflictError` anywhere. */
  conflicts(): Seen[] {
    return this.seen.filter((s) => JSON.stringify(s.line).includes('JournalConflictError'));
  }

  /** Stops the crowd, then every node, gracefully, and fails if any exits badly. */
  async stopAll(): Promise<void> {
    if (this.crowd.running) expectExit(this.crowd, await this.crowd.stop());
    for (const node of this.nodes) if (node.running) expectExit(node, await node.stop());
  }

  /** Every event in the journal, in order: per stream, by sequence number. */
  async journal(): Promise<{ id: string; seq: number; event: Record<string, unknown> }[]> {
    const pool = testPool({ max: 1 });
    try {
      const { rows } = await pool.query<{
        id: string;
        seq: string;
        event: Record<string, unknown>;
      }>(
        `SELECT persistence_id AS id, seq, event FROM "${this.schema}".events
         ORDER BY persistence_id, seq`,
      );
      return rows.map((r) => ({ id: r.id, seq: Number(r.seq), event: r.event }));
    } finally {
      await pool.end();
    }
  }

  /** Kills whatever still runs, and drops the schema. */
  async close(): Promise<void> {
    await Promise.all([this.crowd, ...this.nodes].map((p) => p.kill()));
    const pool = testPool({ max: 1 });
    try {
      await dropSchema(pool, this.schema);
    } finally {
      await pool.end();
    }
  }
}

function expectExit(proc: Proc, code: number | null): void {
  if (code !== 0) throw new Error(`${proc.name} exited with ${String(code)}\n${proc.stderr}`);
}

/** Options for {@link TestCluster.start}. */
export interface Options {
  readonly nodes?: number;
  readonly timings?: Timings;
  readonly askTimeoutMs?: number;
  readonly pauseMs?: number;
}

/** The shard each show is in. */
export function shardOfShow(show: string): number {
  return shardOf(show, SHARD_COUNT);
}

/** The address part of a holder name or an incarnation, `<address>#<uid>[:<n>]`. */
export function addressOf(key: string): string {
  return key.slice(0, key.indexOf('#'));
}
