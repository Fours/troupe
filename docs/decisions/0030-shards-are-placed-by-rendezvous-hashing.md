# 0030. Shards are placed by rendezvous hashing over the reachable members, and move only by handoff or an expired lease

- **Status:** Proposed
- **Date:** 2026-11-23
- **Milestone:** 4

## Context

Cluster sharding has to answer two questions for every message to an entity: which shard it's in, and which node runs that shard. The first answer must be the same on every node, forever, or two nodes would route one entity to two places. The second can change as nodes come and go, but it shouldn't move more shards than it has to, since each move stops entities and recovers them elsewhere. A lease decides where a shard is ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)). Something has to decide where it should be, with no coordinator to fail and no table to keep consistent. Every choice runs on the system's scheduler and random, so a cluster in memory repeats from its seed ([0003](0003-injected-scheduler-and-random.md)).

## Decision

**An entity's shard is a hash of its id. A shard's desired owner is the member with the highest rendezvous score for it, among those that are up, reachable from this node, and host the type. The lease, not the desired owner, says where the shard is.**

- **Entity to shard.** A 32-bit FNV-1a hash of the id, modulo the type's `shardCount` (default 64, at most 65,536). It's the hash the Postgres lock key already used ([0016](0016-postgres-appends-take-a-journal-lock.md)), now in `src/hash.ts` for both. Ids are actor names, so entity paths go on the wire unescaped.
- **Placement by rendezvous hashing.** A shard's score for a member is FNV-1a of `<lease>@<address>`, mixed by MurmurHash3's finalizer, since FNV-1a alone barely changes its high bits when only a string's end differs. The highest score wins, and the lower address breaks a tie. Addresses, not uids, are scored, so a node that restarts gets the same shards back. Every node computes the same answer from the same members. A node that joins tops about one shard in N, and only those move to it. A node that leaves moves only its own.
- **Regions route.** Each node that calls `sharding.init` has a region at `/system/sharding/<type>`. The region holds shard actors at `/system/sharding/<type>/<shard>`, and each shard holds its entities at `/system/sharding/<type>/<shard>/<id>`. A message for an entity goes:
  - to the local shard, if this node holds its lease by its own clock
  - otherwise to the holder's region, if the region's cache of the store's holders names a member that isn't down
  - otherwise into a buffer for the shard, in order, up to `bufferSize` (default 1,000). Past that, messages are `unreachable` dead letters.
- **Finding a shard a home always starts from the store.** The region reads the store's holders. If a usable member holds the shard, the region routes there. If none does, the desired owner acquires the lease: this region, or the desired owner's region when this one asks it with `start`, which answers `home` with the holder. A failed acquire returns the holder, and the region routes there. Every retry waits on a backoff from the scheduler, doubling from 100 ms to 2 s, with jitter from the system's random.
- **`notOwner`.** A region that gets a message for a shard it doesn't hold, and isn't finding a home for, sends the message back. The sender drops the stale holder from its cache and looks again. It also remembers who sent the message back, so a lease the store still names but the holder has let go of doesn't bounce the message back and forth. A message sent back 5 times is an `unreachable` dead letter.
- **Regions say hello.** Regions talk with ordinary remote messages, so Backstage can show the routing (T9). When a region starts, and whenever a member joins, it sends each member's region its `shardCount` and whether it hosts, and a region that hears a hello first answers it. A member counts as a host only once its hello says so. Before placing a shard, a region waits up to four backoffs, about a second, for a hello from every up member, so nodes that start together agree on placement. A member that never calls `init` for the type costs that wait once per shard.
- **A different `shardCount` is refused per type.** A region whose hello gives another shard count is logged as an error on both sides, and is never routed to or placed on for that type. The spec put this check in the remoting handshake, but `init` can run after connections exist, and other types on the same nodes can still work.
- **`host: false`** gives a region that routes and never acquires. Its hello says so, so no one places a shard on it.
- **Entities.** A shard spawns an entity on its first message, from `entity(id)`, with the type's supervision (default `supervise.stop()`, per [0006](0006-supervision-chosen-at-spawn.md)). An entity that stops is started again by its next message. A shard resumes after a failure of its own, and an `entity(id)` that throws is logged and dead-letters that message.
- **Messages to entities are always encoded** ([0025](0025-messages-on-the-wire-are-json-plus-refs.md)). The entity ref encodes the message where it's sent, so a message that isn't JSON plus refs, or is over `maxFrameBytes`, is an `unserializable` dead letter on the sender, even with the shard on the same node. The shard decodes it where the entity runs, then checks it against the type's Standard Schema, if it has one ([0018](0018-standard-schema-and-upcasters.md)). A failure is an `invalid` dead letter, with its issues logged.
- **Entity refs** have the path `/sharding/<type>/<id>` on every node, travel as `{ "$entity": { "type", "id" } }`, and decode into the receiving node's own entity ref, so they outlive shard moves. One decoded on a node that hasn't initialised the type gives `unreachable` dead letters. `ctx.watch` refuses an entity ref with a `TypeError`, since an entity has no single incarnation to watch.
- **Leases.** One lease keeper per node, made on the first hosting `init`, with `joinCluster`'s `leases: { ttlMs, renewMs, marginMs }` (defaults 10,000, 3,000 and 2,000). Lease timing is per node, not per type, because `renewAll` renews every lease a holder has. A shard whose lease is lost stops at once. A region that stops, because the node leaves, is downed or terminates, stops its shards and releases their leases after their entities have stopped, so others can take them without waiting for expiry.
- **Events.** `shardAcquired` with the entity type, shard, node and token, before the shard starts. `shardReleased` with the same and a reason: `leaseLost`, published at the deadline, or `leaving` or `downed`, published once the shard's entities have stopped. T7 adds `handoff`.
- **Moving shards** (T7). A shard moves only when its owner hands it off or its lease expires. Rebalancing, handoff, passivation and remembered entities come in T7, which also accepts this record.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A coordinator that keeps the shard table, as Akka's shard coordinator does | A singleton that needs an election, persistence and handover of its own. Leases already decide ownership, so a table would be a second source of truth |
| Consistent hashing on a ring | Moves about as few shards, but needs virtual nodes to spread them evenly, and a ring to keep in step. Rendezvous hashing is a loop over the members |
| Modulo placement, `shard % members` | Almost every shard moves when a member joins or leaves |
| FNV-1a alone for scores | Its high bits change little when only a string's end differs, and `show/3@node-1` and `show/3@node-2` differ only at the end. The finalizer spreads them evenly, and costs a few multiplies |
| Scoring `address#uid` | A restarted node would get different shards from its last incarnation, so a restart would move shards twice |
| Checking `shardCount` in the remoting handshake, as the spec first said | Types are registered after the connections are up, and refusing a connection would cut off types that agree |
| Placing at once with whoever has said hello | Nodes that call `init` together each place every shard on themselves first. The leases keep that safe, but placement would depend on timing |
| Retrying a `notOwner` straight away | A holder whose deadline has passed is still named by the store until its lease expires, so the message would bounce until then |

## Evidence

**T6 (2026-11-23), Node 26.12.1, on the in-memory network and one `ManualScheduler`:**

- `test/cluster/placement.test.ts`: the hash matches published FNV-1a vectors and the old lock key. Ids spread evenly over shards, and shards over nodes. Owners don't depend on the candidates' order. Over 1,000 shards, a fourth node takes between 200 and 300, every one of them a shard it scores highest for, and removing it moves only its own.
- `test/cluster/sharding.test.ts`:
  - An entity ref from each of three nodes reaches the one entity with its id, spawned once in the cluster, and `ask` works through it.
  - Every acquired shard is on its desired owner. A shard first used after a fourth node joins goes to the fourth node when it tops the shard.
  - A message with a `Map` is an `unserializable` dead letter even when the shard is on the sending node, and one over `maxFrameBytes` is too. What arrives is a copy, never the sent object.
  - `ctx.watch` of an entity ref throws a `TypeError`.
  - A schema, sync or async, checks messages after decoding, and what arrives is its output. A message that fails it, or makes it throw, is an `invalid` dead letter, with its issues logged.
  - An entity ref sent to another node still reaches its entity after the owner is killed, from the node that took the lease, with token 2.
  - A `host: false` node never acquires a shard, and shards that would be its, if it hosted, go elsewhere.
  - A node with another `shardCount` is refused on both sides, with an error logged, and gets no shard.
  - A node cut off from the store stops its shard at its deadline (`leaseLost`). Messages sent meanwhile come back with `notOwner`, nobody else starts the entity while the lease lives, and once the node reaches the store again it takes the lease back and answers what waited.
  - A node that leaves releases its shards (`leaving`), and another node takes one well inside the lease's TTL. A node that learns it's down releases them as `downed`.
  - Per-shard buffers hold at most `bufferSize`, and what waits when the region stops becomes `stopped` dead letters. Malformed messages from other regions are logged and ignored, and nothing fails.
- `test/cluster/invariant.test.ts`: over 200 seeds, three nodes sell to six persistent accounts for 20 virtual seconds. At random, a node is killed and restarted, partitioned from the others while it keeps running until it's downed, or cut off from the store. No two live intervals of one entity overlap, across every incarnation of every node. Every acknowledged deposit is in the journal, and no actor fails. Two runs of one seed give the same events on every node.
- Breaking each of these fails a test: a store that grants a held lease (the invariant fails at seed 1 with two live instances of one account), rendezvous picking the lowest score, never refusing a different `shardCount`, counting `host: false` peers as candidates, dropping what comes back with `notOwner`, placing without waiting for hellos, leaving a shard running after its lease is lost, not releasing leases as the region stops, not encoding local messages, and not checking the schema.

Still to prove: T7's rebalancing and handoff, after which this record is accepted.

## Consequences

- No coordinator, and nothing to elect. Any node can work out where a shard should be, from the member list and the hellos it has heard.
- Placement depends on each node's view of who's up and reachable. Views can differ for a while, and then two nodes may both try to start a shard. Only one can hold the lease, so that costs a retry, never a second instance.
- A shard's first message waits for a store read, an acquire, and on a new cluster up to a second for hellos. T8's benchmark measures what that adds.
- A node partitioned from the store makes its entities unavailable until it reaches the store again or leaves. That's 0029's trade, chosen over two instances.
- Messages that race an entity's own stop become `stopped` dead letters. Buffering through a stop comes with T7's passivation, where the shard knows a stop is coming.
