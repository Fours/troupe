// The benchmark's scenarios (decision 0019). Each run builds what it needs, times only the work
// being measured, tears down, and checks that the work really happened, so a scenario that
// silently did less can't post a better number.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  actor,
  createActorSystem,
  silentLogger,
  type ActorRef,
  type ActorSystem,
} from '@kylewillett/troupe';
import { inMemoryPersistence, type Journal } from '@kylewillett/troupe/persistence';
import {
  postgresPersistence,
  type PgPool,
  type PgPoolClient,
} from '@kylewillett/troupe/persistence/postgres';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import type pg from 'pg';

/** What one timed run did. */
export interface Sample {
  /** How many operations the timed part completed. */
  readonly ops: number;
  /** How long the timed part took, in ms, from `performance.now()`. */
  readonly ms: number;
  /** Per-operation latencies in ms, for scenarios that report percentiles. */
  readonly latenciesMs?: readonly number[];
}

/** A scenario's parameters, such as `{ messages: 1_000_000 }`. Recorded with its results. */
export type Size = Readonly<Record<string, number>>;

/** One row of the benchmark. */
export interface Scenario {
  /** A stable id, used by `--only` and to match runs in `--compare`. */
  readonly name: string;
  /** The row of the spec's table it belongs to. */
  readonly group: string;
  /** What `ops` counts, per second. */
  readonly unit: string;
  /** The size of a full run. */
  readonly full: Size;
  /** The size of a `--quick` run. Absent for scenarios `--quick` leaves out (not in-memory). */
  readonly quick?: Size;
  run(size: Size): Promise<Sample>;
}

/** What the scenarios need from where they run. */
export interface BenchEnv {
  /** A directory for SQLite files, which exists. */
  readonly tmpDir: string;
  /** The Postgres pool, opened on first use and shared by every run, so connections are warm. */
  readonly pool: () => pg.Pool;
}

/** Reads one parameter, so a misspelt size fails instead of running with `undefined`. */
export function param(size: Size, key: string): number {
  const value = size[key];
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`size.${key} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

/** Throws unless the scenario did the work it claims. */
export function check(what: string, actual: number, expected: number): void {
  if (actual !== expected)
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

/**
 * A `yieldAfter` no run reaches, so the dispatcher never yields to the event loop. With the
 * default of 1,000, a busy pair of actors spends most of its time in the yield's zero-delay
 * timer, which Node clamps to 1 ms, so the `-noyield` rows show the per-message cost that the
 * default rows hide (found in T1, see decision 0019).
 */
export const NO_YIELD = 1_000_000_000;

/** How a scenario's system is set up. */
export interface SystemOptions {
  /** The dispatcher's `yieldAfter`. Default: the system's own default. */
  readonly yieldAfter?: number;
  /** Runs on the new system before the work, so the message-events rows can subscribe. */
  readonly attach?: (system: ActorSystem) => void;
}

function benchSystem(opts: SystemOptions): ActorSystem {
  const system = createActorSystem({
    name: 'bench',
    logger: silentLogger,
    ...(opts.yieldAfter === undefined ? {} : { yieldAfter: opts.yieldAfter }),
  });
  opts.attach?.(system);
  return system;
}

/** A promise and the function that resolves it. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Ping = { readonly type: 'ping'; readonly replyTo: ActorRef<Pong> };
type Pong = { readonly type: 'pong' } | { readonly type: 'start' };

/** Two actors passing `messages` tells back and forth. */
export async function pingPong(messages: number, opts: SystemOptions = {}): Promise<Sample> {
  const system = benchSystem(opts);
  const done = signal();
  const rounds = Math.floor(messages / 2);
  let sent = 0;
  const ponger = system.spawn(
    actor<Ping, null>({
      initial: null,
      receive(state, msg) {
        msg.replyTo.tell({ type: 'pong' });
        return state;
      },
    }),
    'ponger',
  );
  const pinger = system.spawn(
    actor<Pong, number>({
      initial: rounds,
      receive(remaining, _msg, ctx) {
        if (remaining === 0) {
          done.resolve();
          return 0;
        }
        sent += 1;
        ponger.tell({ type: 'ping', replyTo: ctx.self });
        return remaining - 1;
      },
    }),
    'pinger',
  );
  const start = performance.now();
  pinger.tell({ type: 'start' });
  await done.promise;
  const ms = performance.now() - start;
  await system.terminate();
  check('ping-pong round trips', sent, rounds);
  return { ops: rounds * 2, ms };
}

/** `count` sequential asks of an actor that answers at once, each one timed. */
export async function askRoundTrips(count: number): Promise<Sample> {
  const system = benchSystem({});
  const echo = system.spawn(
    actor<{ readonly replyTo: ActorRef<number> }, number>({
      initial: 0,
      receive(n, msg) {
        msg.replyTo.tell(n + 1);
        return n + 1;
      },
    }),
    'echo',
  );
  const latenciesMs: number[] = [];
  let last = 0;
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    last = await echo.ask<number>((replyTo) => ({ replyTo }));
    latenciesMs.push(performance.now() - t);
  }
  const ms = performance.now() - start;
  await system.terminate();
  check('ask replies', last, count);
  return { ops: count, ms, latenciesMs };
}

type FanMsg = { readonly type: 'round' } | { readonly type: 'pong' };
type ChildMsg = { readonly replyTo: ActorRef<FanMsg> };

/**
 * One parent and `children` children. Each round, the parent tells every child and every child
 * replies. One untimed round first makes sure every child has started.
 */
export async function fanOut(
  children: number,
  rounds: number,
  opts: SystemOptions = {},
): Promise<Sample> {
  const system = benchSystem(opts);
  let roundDone = signal();
  let pongs = 0;
  const child = actor<ChildMsg, null>({
    initial: null,
    receive(state, msg) {
      msg.replyTo.tell({ type: 'pong' });
      return state;
    },
  });
  // The children's refs live outside state, since refs aren't plain values (decision 0001).
  const refs: ActorRef<ChildMsg>[] = [];
  const parent = system.spawn(
    actor<FanMsg, number>({
      initial: (ctx) => {
        for (let i = 0; i < children; i++) refs.push(ctx.spawn(child, `c${String(i)}`));
        return 0;
      },
      receive(waiting, msg, ctx) {
        if (msg.type === 'round') {
          for (const ref of refs) ref.tell({ replyTo: ctx.self });
          return children;
        }
        pongs += 1;
        if (waiting === 1) roundDone.resolve();
        return waiting - 1;
      },
    }),
    'parent',
  );
  const round = async (): Promise<void> => {
    roundDone = signal();
    parent.tell({ type: 'round' });
    await roundDone.promise;
  };
  await round();
  pongs = 0;
  const start = performance.now();
  for (let r = 0; r < rounds; r++) await round();
  const ms = performance.now() - start;
  await system.terminate();
  check('fan-out replies', pongs, children * rounds);
  return { ops: children * rounds * 2, ms };
}

/** Spawns `count` top-level actors, stops them all, and waits for the last `postStop`. */
export async function spawnAndStop(count: number): Promise<Sample> {
  const system = benchSystem({});
  const done = signal();
  let stopped = 0;
  const def = actor<never, null>({
    initial: null,
    receive: (state) => state,
    onSignal(state, sig) {
      if (sig.type === 'postStop') {
        stopped += 1;
        if (stopped === count) done.resolve();
      }
      return state;
    },
  });
  const start = performance.now();
  const refs = [];
  for (let i = 0; i < count; i++) refs.push(system.spawn(def));
  for (const ref of refs) system.stop(ref);
  if (count > 0) await done.promise;
  const ms = performance.now() - start;
  await system.terminate();
  check('actors stopped', stopped, count);
  return { ops: count, ms };
}

/**
 * `streams` event streams appended to in parallel, each one event at a time, `perStream` times.
 * Only the appends are timed. Afterwards every stream is read back to check its length.
 */
export async function appends(
  journal: Journal,
  streams: number,
  perStream: number,
): Promise<Omit<Sample, 'latenciesMs'>> {
  const ids = Array.from({ length: streams }, (_, i) => `stream-${String(i)}`);
  const start = performance.now();
  await Promise.all(
    ids.map(async (id) => {
      for (let seq = 0; seq < perStream; seq++) {
        await journal.append(id, seq, [{ event: { n: seq }, version: 1, tags: ['bench'] }]);
      }
    }),
  );
  const ms = performance.now() - start;
  for (const id of ids) {
    const stored = await journal.read(id, 1, perStream + 1);
    check(`${id} events`, stored.length, perStream);
  }
  return { ops: streams * perStream, ms };
}

const LOCK_QUERY = 'SELECT pg_advisory_xact_lock(';

/**
 * Wraps a pool so its clients skip the journal-wide advisory lock when `lock` is false. For
 * measuring what the lock costs only: without it, tag offsets can commit out of order
 * (decision 0016). The benchmark's streams never share a persistence id, so the appends are
 * still correct. Both variants go through the wrapper, so it costs both the same.
 */
export function lockSwitch(pool: PgPool, lock: boolean): PgPool {
  const wrap = (client: PgPoolClient): PgPoolClient => ({
    query: (text, values) =>
      !lock && text.startsWith(LOCK_QUERY)
        ? Promise.resolve({ rows: [] })
        : client.query(text, values),
    release: (destroy) => {
      client.release(destroy);
    },
  });
  return {
    query: (text, values) => pool.query(text, values),
    connect: async () => wrap(await pool.connect()),
  };
}

function removeSqlite(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
}

/** Every scenario, in the order the spec's table lists them. */
export function scenarios(env: BenchEnv): readonly Scenario[] {
  const journalRows = (
    backend: string,
    one: number,
    parallel: number,
    quick: boolean,
    open: () => Promise<{ journal: Journal; close: () => Promise<void> }>,
  ): Scenario[] =>
    (
      [
        [1, one],
        [100, parallel],
      ] as const
    ).map(([streams, perStream]) => ({
      name: `journal-${backend}-${String(streams)}`,
      group: 'Journal appends',
      unit: 'appends/s',
      full: { streams, appendsPerStream: perStream },
      ...(quick ? { quick: { streams, appendsPerStream: Math.ceil(perStream / 10) } } : {}),
      run: async (size) => {
        const { journal, close } = await open();
        try {
          return await appends(journal, param(size, 'streams'), param(size, 'appendsPerStream'));
        } finally {
          await close();
        }
      },
    }));

  const sqlite = (): Promise<{ journal: Journal; close: () => Promise<void> }> => {
    const path = join(env.tmpDir, `bench-${randomUUID()}.db`);
    const persistence = sqlitePersistence({ path });
    return Promise.resolve({
      journal: persistence.journal,
      close: () => {
        persistence.close();
        removeSqlite(path);
        return Promise.resolve();
      },
    });
  };

  const postgres =
    (lock: boolean) => async (): Promise<{ journal: Journal; close: () => Promise<void> }> => {
      const pool = env.pool();
      const schema = `bench_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await postgresPersistence({ pool, schema }).setup();
      return {
        journal: postgresPersistence({ pool: lockSwitch(pool, lock), schema }).journal,
        close: async () => {
          await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        },
      };
    };

  return [
    {
      name: 'ping-pong',
      group: 'Ping-pong',
      unit: 'msg/s',
      full: { messages: 1_000_000 },
      quick: { messages: 20_000 },
      run: (size) => pingPong(param(size, 'messages')),
    },
    {
      name: 'ping-pong-noyield',
      group: 'Ping-pong',
      unit: 'msg/s',
      full: { messages: 1_000_000 },
      quick: { messages: 20_000 },
      run: (size) => pingPong(param(size, 'messages'), { yieldAfter: NO_YIELD }),
    },
    {
      name: 'ask',
      group: 'Ask',
      unit: 'asks/s',
      full: { asks: 100_000 },
      quick: { asks: 2_000 },
      run: (size) => askRoundTrips(param(size, 'asks')),
    },
    {
      name: 'fan-out',
      group: 'Fan-out',
      unit: 'msg/s',
      full: { children: 10_000, rounds: 100 },
      quick: { children: 1_000, rounds: 5 },
      run: (size) => fanOut(param(size, 'children'), param(size, 'rounds')),
    },
    {
      name: 'fan-out-noyield',
      group: 'Fan-out',
      unit: 'msg/s',
      full: { children: 10_000, rounds: 100 },
      quick: { children: 1_000, rounds: 5 },
      run: (size) =>
        fanOut(param(size, 'children'), param(size, 'rounds'), { yieldAfter: NO_YIELD }),
    },
    {
      name: 'spawn-stop',
      group: 'Spawn and stop',
      unit: 'actors/s',
      full: { actors: 10_000 },
      quick: { actors: 2_000 },
      run: (size) => spawnAndStop(param(size, 'actors')),
    },
    // Without yields, so the cost per message isn't hidden behind the yield timer.
    {
      name: 'events-none',
      group: 'Message events',
      unit: 'msg/s',
      full: { messages: 1_000_000 },
      quick: { messages: 20_000 },
      run: (size) => pingPong(param(size, 'messages'), { yieldAfter: NO_YIELD }),
    },
    {
      name: 'events-plain',
      group: 'Message events',
      unit: 'msg/s',
      full: { messages: 1_000_000 },
      quick: { messages: 20_000 },
      run: (size) =>
        pingPong(param(size, 'messages'), {
          yieldAfter: NO_YIELD,
          attach: (system) => {
            system.events.subscribe(() => undefined);
          },
        }),
    },
    {
      name: 'events-messages',
      group: 'Message events',
      unit: 'msg/s',
      full: { messages: 1_000_000 },
      quick: { messages: 20_000 },
      run: (size) =>
        pingPong(param(size, 'messages'), {
          yieldAfter: NO_YIELD,
          attach: (system) => {
            system.events.subscribe(() => undefined, { messages: true });
          },
        }),
    },
    ...journalRows('memory', 10_000, 100, true, () => {
      const persistence = inMemoryPersistence();
      return Promise.resolve({ journal: persistence.journal, close: () => Promise.resolve() });
    }),
    ...journalRows('sqlite', 2_000, 20, false, sqlite),
    ...journalRows('postgres', 2_000, 20, false, postgres(true)),
    {
      name: 'journal-postgres-100-nolock',
      group: 'Journal appends',
      unit: 'appends/s',
      full: { streams: 100, appendsPerStream: 20 },
      run: async (size) => {
        const { journal, close } = await postgres(false)();
        try {
          return await appends(journal, param(size, 'streams'), param(size, 'appendsPerStream'));
        } finally {
          await close();
        }
      },
    },
  ];
}
