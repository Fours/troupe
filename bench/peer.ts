// The other process for the benchmark's remote rows (milestone 4, T8): a node on TCP loopback that
// hosts the `ponger` entity type, in one shard. bench/cluster.ts starts it, joins it as a node
// that only routes, and gets a plain ref to the ponger through its entity ref, since refs travel
// in messages or come from sharding, never from a lookup by path.
//
//   PEER_PORT=… BENCH_SCHEMA=… [TROUPE_POSTGRES_URL=…] node bench/peer.ts
import pg from 'pg';
import { actor, createActorSystem, silentLogger } from '@kylewillett/troupe';
import { joinCluster } from '@kylewillett/troupe/cluster';
import { postgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import { tcpTransport } from '@kylewillett/troupe/cluster/tcp';
import { CLUSTER, SECRET, type PongerMsg } from './remote.ts';
import { postgresUrl } from './setup.ts';

const port = Number(process.env['PEER_PORT']);
const schema = process.env['BENCH_SCHEMA'];
if (!Number.isSafeInteger(port) || schema === undefined) {
  throw new TypeError('PEER_PORT and BENCH_SCHEMA must be set');
}
const pool = new pg.Pool({ connectionString: postgresUrl(process.env), max: 2 });
const shards = postgresShardStore({ pool, schema });
await shards.setup();
// The same dispatcher as the bench's own side, so the remote rows measure the wire, not the yield.
const yieldAfter = Number(process.env['YIELD_AFTER'] ?? '1000');
const system = createActorSystem({ name: CLUSTER, logger: silentLogger, yieldAfter });
const address = `127.0.0.1:${String(port)}`;
const cluster = joinCluster(system, {
  name: CLUSTER,
  transport: tcpTransport({ port, secret: SECRET }),
  seeds: [address],
  shards,
});
cluster.sharding.init({
  type: 'ponger',
  shardCount: 1,
  entity: () =>
    actor<PongerMsg, null>({
      initial: null,
      receive: (state, msg, ctx) => {
        if (msg.type === 'ping') msg.replyTo.tell({ type: 'pong' });
        else msg.replyTo.tell({ ref: ctx.self });
        return state;
      },
    }),
});
await cluster.whenUp;
process.stdout.write(`${JSON.stringify({ ev: 'up', address })}\n`);

process.once('SIGTERM', () => {
  void system
    .terminate()
    .then(() => pool.end())
    .finally(() => process.exit(0));
});
