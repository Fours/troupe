# 0031. Failover waits for the lease, not for downing: a region routes only to a holder it can reach

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 4

## Context

Milestone 4's T8 ran festival night as real processes, three nodes and a crowd on TCP and Postgres, and killed nodes with `kill -9`. Its first failover took 16.1 s with the default timings, and every show on the killed node came back at the same moment, past the spec's 15 s. That was neither of the times the design intended. The killed node's leases ran out 7 to 10 s after the kill (a 10 s TTL, renewed every 3 s), but nothing answered until the node had been marked down, 5 s to unreachable plus 10 s to down.

The cause was [0030](0030-shards-are-placed-by-rendezvous-hashing.md)'s routing rule: a region sends a message to the holder in its cache "if the cache names a member that isn't down". An unreachable holder isn't down yet, so the crowd kept sending to the dead node. Remoting held those messages in its buffer for the peer ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)), and since the region's routing seemed to work, it never went back to the store to see that the lease had gone. Only downing turned the buffer into dead letters and the holder into one the region would skip. So in practice ownership waited on membership, which 0028 and 0029 set out to avoid.

T8 also asks for the lease defaults to be tuned against the failover it measures.

## Decision

**A region routes a message to a shard's holder only if this node can reach that holder.** Otherwise the message waits in the region's buffer for the shard, and the region looks for a home as it does when nobody holds the shard. It reads the store's holders. While the store still names the unreachable holder, the region asks the desired owner among the members it can reach to `start` the shard, and the acquire fails until the lease expires. The region backs off and tries again, up to 2 s apart. Once the lease has expired, the desired owner takes it, and what waited goes there.

This supersedes one bullet of 0030, which stays Accepted: "to the holder's region, if the region's cache of the store's holders names a member that isn't down" now reads "names a member this node can reach, that isn't down". Nothing else in 0030 changes. In particular, a holder that's unreachable still keeps its shards until its lease runs out or it leaves, and a rebalance still never moves a shard whose holder can't be reached.

**The lease defaults stay** at `ttlMs` 10,000, `renewMs` 3,000 and `marginMs` 2,000 ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)), and so do membership's 5 s to unreachable and 10 s to down ([0028](0028-membership-is-gossiped-with-automatic-downing.md)). With the routing fixed, failover takes the lease's remaining time plus a backoff, and the measurements below leave room under the 15 s target, so a shorter lease isn't worth what it costs (see Consequences).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the rule, and down nodes sooner (`downAfterMs` 5,000) | Failover would still wait on membership, now about 10 s, the lease's longest. A shorter `downAfterMs` downs a node that's only slow, and a downed node has to leave and restart |
| Keep the rule, and have remoting fail what waits for an unreachable peer at once | Remoting's buffer is what carries messages over a connection that drops and comes back ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)). Every actor on every node would lose messages on a short blip, to fix one thing sharding does |
| Read the store's holders again every so often, whatever routing seems to do | Every region would poll the store for every type. And it would still route to an unreachable holder until the next read, so a kill would cost up to that interval on top |
| A shorter lease: `ttlMs` 6,000, `renewMs` 2,000, `marginMs` 1,500 | Failover about 4 s sooner, but a node would lose every lease after a stall of 2.5 s (a GC pause, a slow Postgres) instead of 5 s, and losing a lease stops the shard's entities on a node that's otherwise fine. The defaults already meet the target |

## Evidence

**The fix (T8, 2026-11-24), Node 26.12.1, in process:** `test/cluster/sharding.test.ts`, "routes around a holder it can’t reach": three in-memory nodes with a 2 s lease and `downAfterMs` 60,000. After node 3 is killed, an entity on it answers from another node within 5 s, well before node 3 could be downed, and nobody has downed it. Before the fix, the test failed: no ask was answered within 20 virtual seconds.

**On real processes:** `npm run test:cluster` runs `test/multiprocess/failover.test.ts` with the default timings. Before the fix, every show on the killed node came back after 16.1 s. After it, each one did within 15 s. The benchmark's `failover` row measures the time on its own, below.

**The benchmark's `failover` row** (`bench/cluster.ts`): three festival-night nodes from `examples/cluster/`, on TCP loopback and Postgres 18.7, with the bench as a fourth node that only routes. For each of 20 kills, it finds the node holding a show, kills it with `kill -9`, and buys a seat every 100 ms until a node other than the killed one answers. Then it restarts the killed node and waits for no shard to have moved for 5 s. A first run on Node 26.12.1, before the recorded ones: p50 10.5 s, max 11.7 s.

## Consequences

- A killed node's shards come back once its leases expire, 7 to 10 s after the kill with the defaults, plus a backoff of up to 2 s and the entity's recovery. Membership's timings no longer bound failover, as long as `unreachableAfterMs` is shorter than the lease's TTL minus its renewal interval.
- Messages for an unreachable holder now wait in the region rather than in remoting. Each region holds at most `bufferSize` (default 1,000) for each shard, against remoting's 10,000 for each peer, and those past it are `unreachable` dead letters, as before. While the holder can't be reached, the region reads the store's holders and asks the desired owner to start the shard on every retry, up to every 2 s for each shard that has messages waiting. That's a little more work for Postgres during a partition, in exchange for not routing into a void.
- A partition that heals before the lease expires delivers what waited, in order, from the region's buffer. Messages already in remoting's buffer before the holder became unreachable still go there.
- Asks sent to a killed node before anyone notices it's unreachable, in the first 5 s, are lost with the node, and time out. Remoting is at most once ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)).
- The lease defaults are now measured rather than guessed. Anyone who wants faster failover can shorten them, at the cost of losing leases after shorter stalls, and the README will say so.
