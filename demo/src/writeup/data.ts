// The shape of the write-up's chart data. demo/build/writeup-data.ts reads it from
// docs/decisions/data/ when the site builds, and the page gets it from virtual:writeup-data.
// Types only, so the page and the loader agree without the page importing Node code.
import type { RehearsalData } from '../rehearsal/data.ts';

/** The Node lines the benchmark was recorded on (0019). */
export const NODE_LINES = ['22', '24', '26'] as const;
export type NodeLine = (typeof NODE_LINES)[number];

/** The line the write-up leads with: the one the release publishes from (0024). */
export const HEADLINE: NodeLine = '24';

/** The baseline's scenarios the write-up uses (0019). */
export const BASELINE_SCENARIOS = [
  'ping-pong',
  'ping-pong-noyield',
  'ask',
  'fan-out',
  'fan-out-noyield',
  'spawn-stop',
  'journal-memory-1',
  'journal-memory-100',
  'journal-sqlite-1',
  'journal-sqlite-100',
  'journal-postgres-1',
  'journal-postgres-100',
  'journal-postgres-100-nolock',
] as const;
export type BaselineScenario = (typeof BASELINE_SCENARIOS)[number];

/** The message-events run's scenarios (0020). They ran without yields. */
export const EVENTS_SCENARIOS = ['events-none', 'events-plain', 'events-messages'] as const;
export type EventsScenario = (typeof EVENTS_SCENARIOS)[number];

/**
 * The cluster run's scenarios (0031): plain ping-pong in the same run, for comparison, entity
 * refs with the shard here and on another process, plain refs across processes, and appends from
 * entities spread over three nodes against 100 streams on one.
 */
export const CLUSTER_SCENARIOS = [
  'ping-pong',
  'entity-tell-local',
  'entity-tell-remote',
  'remote-ping-pong',
  'remote-ask',
  'journal-postgres-100',
  'cluster-appends-postgres',
] as const;
export type ClusterScenario = (typeof CLUSTER_SCENARIOS)[number];

/** A median of 10 runs, each in a fresh process, with the lowest and highest run. Per second. */
export interface Stat {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/** Where and how one recorded run was made, from its setup.json. */
export interface Setup {
  /** The folder in docs/decisions/data/. */
  readonly folder: string;
  readonly node: string;
  readonly cpu: string;
  readonly command: string;
  readonly commit: string;
}

/** One recorded run, per Node line. */
export interface Recorded<S extends string> {
  readonly setup: Readonly<Record<NodeLine, Setup>>;
  readonly scenarios: Readonly<Record<S, Readonly<Record<NodeLine, Stat>>>>;
}

export interface WriteupData {
  readonly baseline: Recorded<BaselineScenario> & {
    /** Each ask's latency in µs, the median run's p50 and p99. */
    readonly askLatencyUs: Readonly<
      Record<NodeLine, { readonly p50: number; readonly p99: number }>
    >;
  };
  readonly events: Recorded<EventsScenario>;
  readonly cluster: Recorded<ClusterScenario> & {
    /** From `kill -9` to the first answer from another node, in ms: one run of 20 kills. */
    readonly failoverMs: Readonly<Record<NodeLine, Latency>>;
    /** A remote ask's round trip in µs, the median run's p50 and p99. */
    readonly remoteAskUs: Readonly<
      Record<NodeLine, { readonly p50: number; readonly p99: number }>
    >;
  };
  /** Rehearsal's planted bugs and the hunt (0040, 0043), as the /rehearsal/ page reads them. */
  readonly rehearsal: Omit<RehearsalData, 'runs' | 'sources'>;
}

/** The middle and the worst of a run's timings. */
export interface Latency {
  readonly p50: number;
  readonly max: number;
}
