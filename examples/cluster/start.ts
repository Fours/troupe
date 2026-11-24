// Starts one festival-night process in the cluster: a node that hosts shows, or the crowd, which
// only routes to them. Both stand on Postgres, for the journal and the shard leases, and talk TCP.
import pg from 'pg';
import { createActorSystem, type ActorSystem } from '@kylewillett/troupe';
import {
  joinCluster,
  type Cluster,
  type ClusterOptions,
  type EntityType,
} from '@kylewillett/troupe/cluster';
import { postgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import { tcpTransport } from '@kylewillett/troupe/cluster/tcp';
import { serveBackstage, type BackstageServer } from '@kylewillett/troupe/backstage/server';
import { postgresPersistence } from '@kylewillett/troupe/persistence/postgres';
import type { NodeEnv } from './env.ts';
import { describeError, emit, emitEvents, jsonLogger } from './log.ts';
import { showEntity, type ShowCmd } from './show.ts';

/** A process in the cluster. */
export interface FestivalNode {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly shows: EntityType<ShowCmd>;
  /** Leaves the cluster gracefully, handing off any shards, then closes the pool. */
  readonly stop: () => Promise<void>;
}

/** Joins the cluster, and resolves once this process is in it. */
export async function startNode(env: NodeEnv, opts: { host: boolean }): Promise<FestivalNode> {
  const pool = new pg.Pool({ connectionString: env.postgresUrl, max: 10 });
  pool.on('error', (error) => {
    emit({ ev: 'log', level: 'error', msg: 'postgres pool error', error: describeError(error) });
  });
  const persistence = postgresPersistence({ pool, schema: env.schema });
  const shards = postgresShardStore({ pool, schema: env.schema });
  // Both are safe on every start, from every process at once.
  await persistence.setup();
  await shards.setup();

  const system = createActorSystem({ name: env.clusterName, logger: jsonLogger });
  emitEvents(system);
  // Before the cluster starts, so Backstage's history has every member and shard from the first.
  let backstage: BackstageServer | undefined;
  if (env.backstage !== undefined) {
    backstage = await serveBackstage(system, env.backstage);
    emit({ ev: 'backstage', url: backstage.url });
  }
  const cluster = joinCluster(system, {
    name: env.clusterName,
    transport: tcpTransport({
      port: env.port,
      host: env.host,
      advertise: env.advertise,
      secret: env.secret,
    }),
    seeds: env.seeds,
    shards,
    ...(env.clusterTimings as Partial<ClusterOptions>),
  });
  const node = `${cluster.self.address}#${String(cluster.self.uid)}`;
  const shows = cluster.sharding.init({
    type: 'show',
    entity: showEntity(persistence, node),
    shardCount: env.shardCount,
    host: opts.host,
    ...env.shardingTimings,
  });

  // A node that learns it was downed has already left (decision 0028). It can only come back as
  // a new incarnation, so the process ends, and whatever runs it starts it again.
  system.events.subscribe((event) => {
    if (
      event.type === 'memberDown' &&
      event.address === cluster.self.address &&
      event.uid === cluster.self.uid
    ) {
      emit({ ev: 'downed', node });
      void system.terminate().finally(() => process.exit(1));
    }
  });

  await cluster.whenUp;
  emit({ ev: 'up', node, host: opts.host });

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      emit({ ev: 'leaving', node });
      // Leaves the cluster first, handing every shard off (decision 0030).
      await system.terminate();
      await backstage?.close();
      await pool.end();
      emit({ ev: 'left', node });
    })());
  return { system, cluster, shows, stop };
}

/** Stops gracefully on SIGTERM or SIGINT, then exits. */
export function stopOnSignals(stop: () => Promise<void>): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stop().then(
        () => process.exit(0),
        (error: unknown) => {
          emit({ ev: 'log', level: 'error', msg: 'stop failed', error: describeError(error) });
          process.exit(1);
        },
      );
    });
  }
}
