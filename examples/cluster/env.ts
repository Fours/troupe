// How a festival-night process is configured: environment variables only, so the same files run
// under `npm run test:cluster`, the benchmark and Docker Compose (docker-compose.cluster.yml).
//
//   CLUSTER_SECRET       required: the shared secret every node proves (decision 0027)
//   CLUSTER_NAME         default festival-night
//   NODE_PORT            default 2552
//   NODE_HOST            the interface to listen on, default 127.0.0.1
//   NODE_ADVERTISE       the address other nodes dial, default <NODE_HOST>:<NODE_PORT>
//   SEEDS                comma-separated addresses, default this node's own
//   TROUPE_POSTGRES_URL  default the test database from docker-compose.test.yml
//   TROUPE_SCHEMA        the journal's and shard store's schema, default troupe
//   SHARD_COUNT          default 32
//   BACKSTAGE_PORT       serve Backstage on this port, optional: left out, there's none
//   BACKSTAGE_HOST       the interface Backstage listens on, default 127.0.0.1
//   TIMINGS              JSON, optional: joinCluster's heartbeatMs, unreachableAfterMs,
//                        downAfterMs, seedTimeoutMs and leases, and sharding's rebalanceMs and
//                        maxHandoffs. Leave it out for the defaults.
//
// The crowd also reads:
//
//   CROWD_SHOWS          how many of the shows to buy at, default all 12
//   CUSTOMERS_PER_SHOW   how many customers buy at each show at once, default 2
//   ASK_TIMEOUT_MS       how long a buy waits for its answer, default 2000
//   PAUSE_MS             how long each customer waits between buys, default 100
import { SHOWS } from './shows.ts';

const DEFAULT_POSTGRES_URL = 'postgres://troupe:troupe@localhost:5440/troupe';
const CLUSTER_KEYS = new Set([
  'heartbeatMs',
  'unreachableAfterMs',
  'downAfterMs',
  'seedTimeoutMs',
  'leases',
]);
const SHARDING_KEYS = new Set(['rebalanceMs', 'maxHandoffs']);

/** What every festival-night process reads. */
export interface NodeEnv {
  readonly secret: string;
  readonly clusterName: string;
  readonly port: number;
  readonly host: string;
  readonly advertise: string;
  readonly seeds: readonly string[];
  readonly postgresUrl: string;
  readonly schema: string;
  readonly shardCount: number;
  /** Where to serve Backstage, or `undefined` for no Backstage. */
  readonly backstage: { readonly port: number; readonly host: string } | undefined;
  /** Passed to `joinCluster` as they are, so its own checks reject bad values. */
  readonly clusterTimings: Readonly<Record<string, unknown>>;
  /** Passed to `sharding.init` as they are. */
  readonly shardingTimings: Readonly<Record<string, unknown>>;
}

/** What the crowd reads as well. */
export interface CrowdEnv extends NodeEnv {
  readonly shows: readonly string[];
  readonly customersPerShow: number;
  readonly askTimeoutMs: number;
  readonly pauseMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function text(env: Env, key: string, fallback?: string): string {
  const value = env[key];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} must be set`);
}

function int(env: Env, key: string, fallback: number): number {
  const value = Number(text(env, key, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer, got ${String(env[key])}`);
  }
  return value;
}

function timings(env: Env): {
  cluster: Record<string, unknown>;
  sharding: Record<string, unknown>;
} {
  const raw = env['TIMINGS'];
  const cluster: Record<string, unknown> = {};
  const sharding: Record<string, unknown> = {};
  if (raw === undefined || raw === '') return { cluster, sharding };
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TIMINGS must be a JSON object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (CLUSTER_KEYS.has(key)) cluster[key] = value;
    else if (SHARDING_KEYS.has(key)) sharding[key] = value;
    else throw new Error(`TIMINGS has an unknown key: ${key}`);
  }
  return { cluster, sharding };
}

/** Reads a node's configuration. Throws, naming the variable, for anything it can't use. */
export function nodeEnv(env: Env): NodeEnv {
  const port = int(env, 'NODE_PORT', 2552);
  const host = text(env, 'NODE_HOST', '127.0.0.1');
  const advertise = text(env, 'NODE_ADVERTISE', `${host}:${String(port)}`);
  const { cluster, sharding } = timings(env);
  return {
    secret: text(env, 'CLUSTER_SECRET'),
    clusterName: text(env, 'CLUSTER_NAME', 'festival-night'),
    port,
    host,
    advertise,
    seeds: text(env, 'SEEDS', advertise)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    postgresUrl: text(env, 'TROUPE_POSTGRES_URL', DEFAULT_POSTGRES_URL),
    schema: text(env, 'TROUPE_SCHEMA', 'troupe'),
    shardCount: int(env, 'SHARD_COUNT', 32),
    backstage:
      env['BACKSTAGE_PORT'] === undefined || env['BACKSTAGE_PORT'] === ''
        ? undefined
        : { port: int(env, 'BACKSTAGE_PORT', 0), host: text(env, 'BACKSTAGE_HOST', '127.0.0.1') },
    clusterTimings: cluster,
    shardingTimings: sharding,
  };
}

/** Reads the crowd's configuration. */
export function crowdEnv(env: Env): CrowdEnv {
  const count = int(env, 'CROWD_SHOWS', SHOWS.length);
  if (count < 1 || count > SHOWS.length) {
    throw new Error(`CROWD_SHOWS must be 1 to ${String(SHOWS.length)}, got ${String(count)}`);
  }
  return {
    ...nodeEnv(env),
    shows: SHOWS.slice(0, count),
    customersPerShow: Math.max(1, int(env, 'CUSTOMERS_PER_SHOW', 2)),
    askTimeoutMs: int(env, 'ASK_TIMEOUT_MS', 2_000),
    pauseMs: int(env, 'PAUSE_MS', 100),
  };
}
