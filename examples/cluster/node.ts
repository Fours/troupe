// A festival-night node: it hosts shows, on TCP and Postgres, configured by environment (env.ts).
// SIGTERM leaves gracefully, handing its shards off first. `kill -9` doesn't, and the other nodes
// take its shards once their leases expire.
//
//   CLUSTER_SECRET=s NODE_PORT=2552 SEEDS=127.0.0.1:2552,127.0.0.1:2553 node examples/cluster/node.ts
import { nodeEnv } from './env.ts';
import { startNode, stopOnSignals } from './start.ts';

const node = await startNode(nodeEnv(process.env), { host: true });
stopOnSignals(node.stop);
