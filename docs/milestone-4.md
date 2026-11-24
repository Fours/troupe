# Milestone 4: Multi-node: remoting, membership, cluster sharding

Source: [roadmap](roadmap.md), Milestones → 4. Carries milestone 1's open question 4 (checking that messages can be serialized), milestone 2's open question 1 (escalation) and the Postgres lock finding from milestone 3's benchmark ([0019](decisions/0019-how-the-benchmark-measures.md)). Open questions answered in spec review on 2026-11-23.

## Outcome

Several Node processes form a cluster. From any of them you can:

- address an entity, such as a show, by its type and ID, and `tell` or `ask` it as if it were local
- start a new node and watch some shards move to it, one handoff at a time
- kill a node with `kill -9` and see its entities come back on the others within seconds, recovered from the journal, with every acknowledged sale still there
- stop a node gracefully and see it hand its shards off before it exits

Throughout, **at most one live instance per entity ID**. Shard ownership is a lease in Postgres, not a vote among nodes, so a node that's slow, partitioned or wrong about who's alive can't start a second copy of an entity. The journal's sequence check stays underneath as the backstop ([0013](decisions/0013-sequence-check-is-the-single-writer-backstop.md)).

The same cluster code runs in a browser tab on an in-memory network, so the demo site gets a third page: three nodes in the page, with a button that kills one.

**Demo at the end:** `npm run cluster:up` starts Postgres, three nodes and a crowd in Docker Compose. Each node serves Backstage on its own port. The crowd buys seats for a dozen shows spread across the nodes. `docker compose -f docker-compose.cluster.yml kill node-2` kills one, and the log shows its shows failing over: asks to them time out for a few seconds, then they answer from node 1 and node 3 with their sales intact. Start node 2 again and a third of the shards move back. Then open `troupe.kylewillett.com/cluster/` and do the same with buttons.

## Scope

In scope:

- **The wire format.** Messages that cross a node are JSON values plus refs, checked before they're sent. Refs travel as an address and a path. Messages to entities are encoded even when the entity is local, so placement never changes what arrives
- **Remoting.** A `Transport` interface, location-transparent remote refs, `tell` and `ask` across nodes, replies, remote death watch, and dead letters for what can't be delivered
- **Two transports:** an in-memory network (any runtime: tests, the browser demo, and later milestone 5's simulated network) and TCP on `node:net`, with a handshake that checks a shared secret
- **Membership:** a static seed list, heartbeats between every pair of nodes, gossip of who's up, leaving and down, and downing a node that has been unreachable too long
- **Shard leases:** a `ShardStore` interface with an in-memory store and a Postgres store, and a contract suite both run
- **Cluster sharding:** entity types, entity refs, entity ID to shard to node, routing and buffering, shards placed by rendezvous hashing, passivating idle entities, rebalancing when nodes join or leave, handoff, and remembering entities
- **Cluster events** on the system's event stream, so Backstage and tests see membership and shard moves in order with everything else
- **Backstage for clusters:** a cluster panel (members, reachability, shard owners) and the sharding tree, from the node it's attached to
- **A multi-process test** with real processes, TCP and Postgres, that kills nodes and checks the invariant
- **Benchmark rows** for remoting and sharding, and the failover time
- **The cluster demo,** in Docker Compose and on the demo site
- **The write-up** gains a section on the cluster, citing the new records
- **Release 0.2.0** with the new entry points

Out of scope:

| Item | Where |
| --- | --- |
| A split-brain strategy (keep the majority, stop the minority) | Stretch, below. Leases already keep a partition from making two owners |
| Understudy: warm standbys that tail an entity's journal to take over faster | Stretch, below |
| Phi-accrual failure detection, SWIM | Stretch. A fixed heartbeat timeout first |
| Partitions, message loss, delay, reordering and slow disks as injected faults | Milestone 5 (Rehearsal) |
| Journal and shard store timeouts (milestone 2, open question 2) | Milestone 5 |
| Spawning an actor on another node (remote deployment) | Not planned |
| Looking up an actor on another node by path (Akka's actor selection). Refs travel in messages, or come from sharding | Not planned |
| Cluster singletons, distributed pub-sub, distributed data | Later |
| TLS between nodes. The TCP transport authenticates peers but doesn't encrypt: run it on a private network | Later |
| Changing a type's shard count on a running cluster | Not planned: it moves every entity |
| Exactly-once delivery. Remoting is at most once, as Akka's is | Not planned |
| Removing the Postgres journal lock ([0016](decisions/0016-postgres-appends-take-a-journal-lock.md)) | Open question 8 |
| A public cluster testkit | Later. The in-memory network and shard store are public, so you can build one |
| A browser-to-server transport (roadmap, later ideas) | Later |

Design for these without building them. In particular:

- **Milestone 5 replaces the network and the store.** `Transport` and `ShardStore` are interfaces that know nothing about Node, and every timer in membership, leases and sharding goes through the system's scheduler, and every choice through its `random` ([0003](decisions/0003-injected-scheduler-and-random.md)). A cluster of in-memory nodes on one `ManualScheduler` is deterministic from its seed, and a test proves it.
- **Rehearsal reads the history from events.** Every shard acquired, released or lost is a system event with its node, lease token and time, and an entity's start and stop are its `spawned` and `stopped`. That's what milestone 5's invariant checker needs to check "one live instance per entity" after a run.
- **No clocks are compared across nodes.** Each node times its own leases on its own monotonic clock, and the store judges expiry on its own clock. Milestone 5 can then skew and pause nodes' clocks without changing the design.

## Design

### The shape of a cluster

```ts
import { createActorSystem, supervise } from '@kylewillett/troupe';
import { joinCluster } from '@kylewillett/troupe/cluster';
import { tcpTransport } from '@kylewillett/troupe/cluster/tcp';
import { postgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import { postgresPersistence } from '@kylewillett/troupe/persistence/postgres';

const system = createActorSystem({ name: 'box-office' });
const persistence = postgresPersistence({ pool });

const cluster = joinCluster(system, {
  name: 'opening-night',
  transport: tcpTransport({ port: 2552, advertise: 'node-1:2552', secret: process.env.CLUSTER_SECRET }),
  seeds: ['node-1:2552', 'node-2:2552'],
  shards: postgresShardStore({ pool }),
});

const shows = cluster.sharding.init({
  type: 'show',
  entity: (id) => show(id, persistence), // a persistentActor, or any ActorDef
  shardCount: 32,
  supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5000 }),
  passivation: { idleMs: 120_000 },
});

await cluster.whenUp;
const hamlet = shows.ref('hamlet'); // ActorRef<ShowCmd>
const receipt = await hamlet.ask<Receipt>((replyTo) => ({ type: 'hold', seats: 2, replyTo }));
```

- `joinCluster` checks its options and returns at once, as `spawn` does. Invalid options throw there, never later. `whenUp` resolves once the transport is listening and the node has gossiped with a seed, or at once on the only seed of a one-node cluster.
- `sharding.init` registers an entity type on this node. Every node that hosts the type calls it with the same `type` and `shardCount`. A node can pass `host: false` to route to a type without hosting any of its shards, as the crowd does in the demo.
- An entity ref is an `ActorRef<M>`, so `tell` and `ask` work as they do everywhere, and an entity can be a `replyTo`.
- The cluster lives on the system: `system.terminate()` leaves the cluster first, and `cluster.leave()` hands the node's shards off and then resolves.

Sketch of the public types, settled in the tasks:

```ts
export interface Cluster {
  /** This node: its address, as other nodes reach it, and its uid, new on every start. */
  readonly self: { readonly address: string; readonly uid: number };
  /** The members as this node sees them, including itself. */
  members(): readonly Member[];
  readonly whenUp: Promise<void>;
  readonly sharding: Sharding;
  /** Hands this node's shards off, tells the others it's leaving, and resolves once it has left. */
  leave(): Promise<void>;
}

export interface Member {
  readonly address: string;
  readonly uid: number;
  readonly status: 'up' | 'leaving' | 'down';
  /** Whether this node hears its heartbeats. Each node's own view, never gossiped. */
  readonly reachable: boolean;
}

export interface Sharding {
  init<M, S>(opts: EntityTypeOptions<M, S>): EntityType<M>;
}

export interface EntityType<M> {
  /** A ref to the entity with this id, wherever it lives now. Never throws for a valid id. */
  ref(id: string): ActorRef<M>;
}
```

### Refs and messages on the wire

A message that leaves a node is turned into JSON text, and every ref in it becomes an address and a path ([0025](#decision-records)).

- **Messages are JSON values plus refs.** The same rule as events ([0014](decisions/0014-events-are-json.md)), with one addition: a ref may appear anywhere a value can. Its check is the one events use, extended for refs, so "is this a JSON value" has one definition in the package.
- **A ref on the wire** is `{ "$ref": "troupe://opening-night@node-1:2552#17/user/box-office" }`: the cluster's name, the node's address and uid, and the path. The `$` escaping is Backstage's ([0021](decisions/0021-backstage-only-watches.md)), so the two encodings agree on refs and markers can't be forged. An entity ref is `{ "$entity": { "type": "show", "id": "hamlet" } }`: it names the entity, not where it lives, so it stays good after the shard moves.
- **`path` grows an address for remote refs.** A local ref's `path` is still `/user/...`. A remote ref's is the full `troupe://...` form, so two refs with the same path are the same actor. An entity ref's path is `/sharding/<type>/<id>`, the same on every node. The actor behind it lives at `/system/sharding/<type>/<shard>/<id>` on whichever node owns its shard.
- **Decoding a ref to this node** finds the live actor or temporary ask ref by path. One that has gone becomes a ref whose `tell`s are `stopped` dead letters, as telling a stopped local actor does. A ref to an old incarnation of this node (another uid) is the same.
- **`tell` never throws.** A message that isn't JSON plus refs, or whose text is over `maxFrameBytes` (default 1 MiB), is a dead letter with the new reason `unserializable`, and a warning names the first bad path in it, as 0014's errors do.
- **Messages to entities are always encoded** (open question 3). Even when the entity is on the same node, the region encodes the message and the shard decodes it, so a message with a `Map` in it fails on your laptop's one-node cluster, not in production when the shard moves. It also means an entity never shares an object with its sender. This answers milestone 1's open question 4: sharding is where the check matters, and sharding always runs it. Plain local refs are unchanged and pay nothing.
- **Inbound checks.** `init` takes an optional Standard Schema for the type's messages ([0018](decisions/0018-standard-schema-and-upcasters.md)). Every message an entity gets is checked after decoding, and one that fails is a dead letter with the new reason `invalid`, with the issues logged. A message from another process is input, and this is where it's checked.

### Remoting

Remoting turns `tell` on a remote ref into a frame on a connection, and a frame into a `tell` on a local ref ([0026](#decision-records)).

- **A `Transport` carries text frames between addresses.** It knows nothing about actors:

  ```ts
  export interface Transport {
    /** The address other nodes reach this one at, such as `node-1:2552`. */
    readonly address: string;
    listen(onConnection: (connection: Connection) => void): Promise<void>;
    /** Returns at once. Frames sent before it opens wait for it, in order. */
    connect(address: string): Connection;
    close(): Promise<void>;
  }

  export interface Connection {
    /** Never throws. A frame sent on a closed connection is dropped, and `onClose` has said so. */
    send(frame: string): void;
    onFrame(listener: (frame: string) => void): void;
    onClose(listener: (error?: unknown) => void): void;
    close(): void;
  }
  ```

- **One connection per pair of nodes.** The node with the lower address keeps its outbound connection when both dial at once. Frames on one connection arrive in order, so **messages from one node to one actor arrive in the order they were sent**, as Akka promises.
- **At most once.** A lost connection loses what was on it. Remoting doesn't retry or acknowledge: an `ask` times out ([0009](decisions/0009-ask-is-a-temporary-ref.md)), and a protocol that needs more retries at its own level.
- **The handshake** is the first frame each way: the cluster's name, the protocol version, the node's address and uid. A mismatch closes the connection and logs why. A new uid at a known address is a restarted node: its old incarnation is gone, and everything watched on it is `terminated`.
- **While a peer is unreachable**, frames for it wait in a bounded buffer (default 10,000 messages). Past that, and once the peer is down, they're `unreachable` dead letters.
- **Remote asks settle through the asker.** A reply to a temporary ref arrives as a frame, and is told to the local temporary ref, so a piped remote ask stays on the scheduler as a local one does ([0010](decisions/0010-piped-asks-stay-on-the-scheduler.md)). Temporary refs gain a lookup by path, for exactly this.
- **The sender travels.** A frame carries the sender's path when the sending node knew it (best-effort, as [0020](decisions/0020-message-events-are-opt-in.md) defines it), so a remote message's `delivered.from` is the remote sender's full path, and Backstage can draw it.
- **Remote death watch** (open question 4). `ctx.watch(remoteRef)` tells the remote node, which sends `terminated` when the actor stops. If the node is downed or restarts with a new uid first, every watch on it signals `terminated` at once, with `failure` saying the node is gone. Watching an entity ref throws a `TypeError`, since an entity has no single incarnation to watch. Watching a local ref is unchanged.

### The TCP transport (`@kylewillett/troupe/cluster/tcp`)

```ts
export function tcpTransport(opts: {
  port: number;
  /** Default `127.0.0.1`. */
  host?: string;
  /** The address other nodes dial, when it isn't host:port, as in Docker. */
  advertise?: string;
  /** Shared by every node. Never sent: proven by challenge and response. */
  secret: string;
}): Transport;
```

- `node:net` only, with no dependency ([0027](#decision-records), open question 1). Each frame is a 4-byte big-endian length and UTF-8 JSON text. A frame over the limit closes the connection, since the peer is broken or hostile.
- **Peers prove the secret** before any other frame (open question 5). Each side sends a random nonce and answers the other's with an HMAC-SHA256 of it under the secret (`node:crypto`), compared in constant time. The secret never crosses the wire. A peer that fails is disconnected and logged. TLS is out of scope, so the README says to keep cluster traffic on a private network.
- **Localhost by default**, as `serveBackstage` is ([0023](decisions/0023-backstage-server-uses-sse.md)). Binding anywhere else is a choice you make with `host`.
- Connections reconnect with backoff, from the system's scheduler and `random`, while the peer isn't down. Remoting does this for every transport (T2, [0026](decisions/0026-remoting-is-at-most-once-behind-a-transport.md)), since only it has the scheduler, so the TCP transport doesn't.

### The in-memory network (`@kylewillett/troupe/cluster`)

`inMemoryNetwork({ scheduler, latencyMs })` gives each node a `Transport` in the same process. Frames are strings, so the wire format is exercised as it is over TCP, and each is delivered after `latencyMs` (default 1) on the scheduler, in order per connection. `kill(address)` drops a node's connections without a goodbye, as `kill -9` does. It's what the tests, the browser demo and milestone 5 build on. Faults beyond a kill (partitions, loss, delay, reordering) are milestone 5's.

### Membership

Membership answers two questions: where to send a message, and where a shard should live. It doesn't decide who owns a shard, which is the lease's job ([0028](#decision-records)).

- **Seeds.** A node joins by handshaking with any seed in its list, and gossips from there. A seed that starts first, with no other seed reachable, forms the cluster alone after `seedTimeoutMs` (default 5,000) only if it's the first in the list, so two halves can't each form their own cluster at start-up.
- **No leader.** Each member's entry is its address, uid and status (`up`, `leaving` or `down`). Every second, each node sends its whole table to one other node, chosen by `random`, which merges it: a later uid replaces an earlier one at the same address, and for one uid `down` beats `leaving` beats `up`. The table converges with no coordinator. A cluster of tens of nodes fits in one frame, which is all this milestone aims at.
- **Heartbeats, full mesh.** Every node heartbeats every other one every `heartbeatMs` (default 1,000). A peer silent for `unreachableAfterMs` (default 5,000) is unreachable, in this node's view only. Reachability isn't gossiped.
- **Downing is automatic.** A peer unreachable for `downAfterMs` (default 10,000) is marked `down`, and that's gossiped. Auto-downing is unsafe in Akka, because a downed node that's still running would keep its shards. Here it can't: a shard is owned by whoever holds its lease, whatever membership says. Downing only stops routing to the node and releases its watches.
- **A node that learns it has been downed** leaves: it stops its shards, releases its leases and closes its connections. It rejoins only by restarting, with a new uid.
- **Leaving.** `cluster.leave()` marks the node `leaving`, hands off every shard it holds, then gossips one last time and closes. The others remove it from placement as soon as they see `leaving`.
- **Events.** `memberUp`, `memberLeaving`, `memberDown` and `memberRemoved` with the address and uid, and `reachability` with the address and the new value, all on the system's event stream.

### Shard leases

A shard is owned by the node that holds its lease in the `ShardStore`. Nothing else makes a node an owner ([0029](#decision-records)).

```ts
export interface ShardStore {
  /** Takes the lease if it's free, expired or already this holder's. */
  acquire(lease: string, holder: string, ttlMs: number):
    Promise<{ readonly acquired: true; readonly token: number } | { readonly acquired: false; readonly holder: string }>;
  /** Extends every lease `holder` still holds, and returns their names. */
  renewAll(holder: string, ttlMs: number): Promise<readonly string[]>;
  /** Gives a lease up, if `holder` still holds it with `token`. */
  release(lease: string, holder: string, token: number): Promise<void>;
  /** The current holders of the leases whose names start with `prefix`, for routing. */
  holders(prefix: string): Promise<readonly { readonly lease: string; readonly holder: string }[]>;
  /** Remembered entities, for `remember: true` (below). */
  remember(shard: string, id: string): Promise<void>;
  forget(shard: string, id: string): Promise<void>;
  remembered(shard: string): Promise<readonly string[]>;
}
```

- A lease's name is `<type>/<shard>`. A holder is `<address>#<uid>`, so a restarted node never mistakes its old incarnation's leases for its own: they expire.
- `token` goes up by one every time the lease changes hands. Events carry it, so a history can tell one ownership from the next.
- **The store judges expiry on its own clock.** Postgres compares against `clock_timestamp()`, and the in-memory store against the clock it's given (0015's injected clock). No node's clock is compared with another's.
- **The holder judges it on its own.** A node notes its monotonic `now()` before it sends a renewal. If the renewal succeeds, it treats the lease as its own until that time plus `ttlMs` minus `marginMs`. Since it noted the time before the store did, its deadline always comes first, as long as the two clocks run at about the same rate. If a renewal fails or hangs, the node keeps trying, and at its deadline it stops the shard's entities and stops routing to them, whether or not the store has answered.
- **Defaults:** `ttlMs` 10,000, renewed every 3,000, `marginMs` 2,000. T8 measures the failover time they give and tunes them.
- **The journal stays the backstop.** A node whose clock pauses (a long GC, a suspended VM) past its deadline can still write once after another node has taken over. The new owner recovered from the journal and appends at its own `lastSeq`, so one of the two appends fails with `JournalConflictError` and the stream stays one stream ([0013](decisions/0013-sequence-check-is-the-single-writer-backstop.md)). Checking the lease token inside the journal's append would close that gap too, but it ties the journal to sharding: open question 2.
- **Backends:** `inMemoryShardStore({ clock })` in `/cluster`, and `postgresShardStore({ pool, schema })` in `/cluster/postgres`, on the same structurally typed pool as the journal ([0017](decisions/0017-backends-add-no-dependencies.md)), with its tables in the same schema and its SQL shipped in `dist/`. A contract suite runs against both, as the journal's does.
- **Postgres is what the cluster stands on.** If the store is unreachable, no lease is renewed, and every shard on every node stops at its deadline. That's the trade: entities go unavailable rather than double. The journal already needed Postgres, so this adds no new thing that can fail.

### Cluster sharding

Each entity type has a **region** on every node, an actor at `/system/sharding/<type>`. Regions route messages, and on hosting nodes they own **shard** actors, which own the entities. Regions talk to each other with ordinary remote messages, so Backstage shows the routing as it shows everything else.

- **Entity to shard:** a 32-bit FNV-1a hash of the entity ID, modulo `shardCount`, the hash 0016 already uses. `shardCount` defaults to 64, can't change on a running cluster, and is in each region's hello, so a node whose count differs is refused for that type (T6).
- **Entity IDs are actor names:** 1 to 64 letters, digits, `.`, `_`, `~` or `-` ([names.ts](../src/names.ts)), so entity paths are URL-safe on the wire. `ref(id)` throws `ActorNameError` for any other id, where it's passed in.
- **Routing.** The region finds the shard's owner in its cache of the store's holders. If it's this node, the message goes to the local shard. If it's another node, the message goes to that node's region. If nobody holds it, the region asks the shard's **desired owner** to start it. A region that gets a message for a shard it no longer holds answers `notOwner`, and the sender refreshes its cache and sends again. While a shard's owner is being found, its messages wait in the region, in order, up to `bufferSize` (default 1,000) per shard. Past that they're `unreachable` dead letters.
- **Placement by rendezvous hashing** ([0030](#decision-records)). A shard's desired owner is the member, among those that are up, reachable from this node and host the type, with the highest hash of the shard name and the member's address. When a node joins, only the shards it now tops move to it, about one in N. When it goes, only its own shards move. No coordinator keeps a table, and every node computes the same answer from the same membership.
- **Starting a shard.** The desired owner acquires the lease, spawns the shard actor, and starts its remembered entities. If the lease is held, it answers with the holder, and the sender routes there. If the holder is down, its lease expires within `ttlMs`, and the next attempt, on a backoff from the scheduler, gets it.
- **Entities** spawn under their shard on their first message, from `entity(id)`, with the type's supervision (default `supervise.stop()`, as everywhere, per [0006](decisions/0006-supervision-chosen-at-spawn.md)). An entity that stops, from a failure or `ctx.stop()` or `thenStop()`, is started again by its next message.
- **Passivation.** With `passivation: { idleMs }`, a shard stops an entity that has had no message for that long. Messages that arrive while it stops wait in the shard and go to the next incarnation, in order.
- **Rebalancing.** Every `rebalanceMs` (default 2,000), each node looks at the shards it holds. For each whose desired owner is another node, it starts a handoff, at most `maxHandoffs` (default 2) at a time. A shard whose holder is unreachable isn't moved: nobody else can take its lease until it expires.
- **Handoff.** The owner stops routing to the shard and holds its new messages, stops its entities (each finishes its current message, a persist included), releases the lease, and sends what it held to the desired owner, which acquires the lease and carries on. Messages that were already on their way to the old owner come back as `notOwner` and are sent again. Messages from one sender to one entity stay in order while its shard stays put. A move can reorder messages in flight, and never delivers one twice.
- **Remembering entities.** With `remember: true`, a shard records each entity it starts in the store, and forgets it when the entity stops itself. A shard that starts on a new node starts every remembered entity at once, rather than waiting for its next message. Passivation is off for remembered types, since it would forget them.
- **Escalation** (milestone 2, open question 1). Still nothing escalates. An entity's failure is its shard's to handle, by the type's supervision, and the shard is the cluster's.
- **Events:** `shardAcquired` and `shardReleased` with the type, shard, node and token, and a reason for a release: `handoff`, `leaving`, `leaseLost` or `downed`. Entities appear as `spawned` and `stopped` at their paths.

### The invariant

At most one live instance per entity ID. Every design choice above is checked against it:

| Threat | What stops a second instance |
| --- | --- |
| Two nodes both think they're a shard's desired owner (membership views differ) | Only one can hold the lease. The other gets the holder back and routes there |
| A node is partitioned from the others but can reach Postgres | It keeps renewing, so nobody can take its leases. Its entities stay up, unreachable from the other side, until the partition heals or it's downed and leaves |
| A node is partitioned from Postgres | It can't renew, and stops its entities at its deadline, before the lease can expire in the store |
| A node pauses past its deadline, then wakes and writes | The journal's sequence check fails one of the two appends |
| A node restarts quickly at the same address | Its new uid makes it a new holder. It waits for its old leases to expire |
| Handoff while a persist is in flight | The lease is released only after every entity in the shard has stopped, and a persistent actor stops only after its persist settles ([0011](decisions/0011-persisting-holds-the-mailbox.md)) |

Tests check it two ways. In process, on the in-memory network and one `ManualScheduler`, every entity's `spawned` and `stopped` events are collected from every node, and no two intervals for one ID overlap in virtual time, across joins, leaves, kills, passivation and handoffs, over many seeds. Across real processes (T8), every entity counts its own incarnations in the journal, and the run ends with no `JournalConflictError` and every acknowledged event present.

### Backstage for clusters

- **The sharding tree.** The tree walk includes `/system/sharding`, so regions, shards and entities appear under their type. The UI shows them in their own section above `/user`.
- **A cluster panel:** this node's member table, with reachability as it sees it, and a grid of shards per type, coloured by owner, from `shardAcquired` and `shardReleased`. Shard moves animate.
- **The protocol goes to version 2.** `hello` gains `cluster`, with this node's address, the members and the shard holders, or `null` for a system with no cluster. The new events are lifecycle events, so they're in `hello.history`.
- **One view per node** (open question 6). Backstage shows the node it's attached to. In Docker, each node serves its own on its own port. On the demo page, a node picker switches the source, and a cluster map built from all three sources sits above it.
- Backstage still only watches ([0021](decisions/0021-backstage-only-watches.md)). The demo's kill button is the demo's.

### The demo

**Festival night.** The box office grows to a dozen shows, each an entity of type `show`, with three hosting nodes and a crowd that only routes. Customers, holds, returns and the sales board are opening night's, reused from `demo/src/domain/`. The sales board is a projection, which runs on one node: the crowd's.

- **In Docker Compose:** `docker-compose.cluster.yml` runs Postgres, `node-1` to `node-3` and `crowd`, each built from `examples/cluster/`, against `dist/`, on real time. Each node serves Backstage on `127.0.0.1:7071` to `7073`. `npm run cluster:up` builds and starts it and follows the narrated log. The README walks through killing `node-2`, starting it again, and `docker compose stop node-3` for a graceful leave.
- **On the site, at `/cluster/`:** the same domain on three in-memory nodes and a crowd, one `ManualScheduler` and the in-memory journal and shard store, driven from animation frames like opening night ([0022](decisions/0022-demo-drives-virtual-time.md)), with `ttlMs` and the membership timeouts scaled down so a failover takes seconds at 1×. Buttons: *Kill node*, *Restart node*, *Add a node* (up to five), *Leave gracefully*, and opening night's *Rush*. Words first, as on the other pages: the log says what happened, in plain words, and the technical detail is one click away.
- The page is its own Vite entry, as the write-up is, and loads nothing from opening night's page.

### The benchmark

New scenarios in `bench/`, recorded under a results folder per run as [0019](decisions/0019-how-the-benchmark-measures.md) asks:

| Scenario | What it measures |
| --- | --- |
| Remote ping-pong | Two processes on TCP loopback, 100,000 `tell`s back and forth: messages per second |
| Remote ask | 10,000 sequential asks across processes: round trips per second, p50 and p99 |
| Entity tell, local | Ping-pong through an entity ref whose shard is on this node, against a plain local ref: the cost of always encoding |
| Entity tell, remote | The same with the shard on the other node |
| Failover | `kill -9` of the node holding a shard, to the first successful reply from its entity on another node: p50 and max over 20 kills |
| Handoff | A graceful leave of a node holding a third of 64 shards, to the last shard acquired elsewhere |

The failover and handoff rows run against Postgres, in processes, and are what the README quotes. CI's `--quick` run covers the in-memory rows only.

### Layout and build

```
src/
  cluster/            the /cluster entry point (any runtime): joinCluster, the wire codec,
                      remoting, membership, sharding, the Transport and ShardStore interfaces,
                      the in-memory network and shard store
    postgres/         the /cluster/postgres entry point: postgresShardStore, on a structural pool
  node/cluster/       the /cluster/tcp entry point: tcpTransport, on node:net and node:crypto
examples/cluster/     a node and the crowd, the Dockerfile, run against dist/
demo/cluster/         the site's /cluster/ page
test/cluster/         unit tests on the in-memory network; helpers/cluster.ts runs N nodes on one
                      ManualScheduler
test/integration/     the Postgres shard store's contract run
test/multiprocess/    real processes, TCP and Postgres: npm run test:cluster
```

| Entry point | Runtime | Built with |
| --- | --- | --- |
| `@kylewillett/troupe/cluster` | any | `tsconfig.build.json`, no Node types |
| `@kylewillett/troupe/cluster/postgres` | any | `tsconfig.build.json`, no Node types |
| `@kylewillett/troupe/cluster/tcp` | Node | `tsconfig.build.node.json` |

- **The core gains internal hooks, never exported** ([internal.ts](../src/internal.ts)): a `/system` guardian for the cluster's actors, finding a live actor or temporary ref by path, and a ref provider the cluster installs to make remote refs through the system's asker. The core still knows nothing about the network.
- **Public API changes:** `SystemEvent` gains the cluster events, and `deadLetter`'s reason gains `unreachable`, `unserializable` and `invalid`. `ActorRef.path`'s TSDoc says what a remote ref's path looks like. `ctx.watch` accepts remote refs. Under 0.x a minor version can change these, and the changelog lists each one.
- `npm run test:cluster` builds the package, then runs `test/multiprocess/` with Vitest: child processes running `examples/cluster/` against `dist/`, on TCP and the test Postgres. Its own CI job, like the Playwright one.
- Package tests: `/cluster` and `/cluster/postgres` load no Node built-in, `/cluster/tcp` loads only `node:net` and `node:crypto`, and the core, `/persistence` and `/backstage` load nothing from `/cluster`.
- `src/`'s 90% line threshold covers the new code. The multi-process tests aren't counted toward it, since they run against `dist/`.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T1. The wire format and the core's hooks | Done | 1bb8120 |
| T2. Remoting on the in-memory network | Done | 11322d6 |
| T3. The TCP transport | Done | dfceded |
| T4. Membership | Done | bd3f20f |
| T5. Shard leases | Done | d6e0db9 |
| T6. Cluster sharding: routing and placement | Done | 5941f00 |
| T7. Passivation, rebalancing, handoff and remembering | Done | 666dd65 |
| T8. Real processes: the multi-process test and the benchmark | Not started | |
| T9. Backstage for clusters, and festival night on the site | Not started | |
| T10. Docker Compose, the write-up and 0.2.0 | Not started | |

### T1. The wire format and the core's hooks

Write [0025](#decision-records).

- The codec: encode a message to text with refs as addresses, decode it back with refs resolved, and the JSON-plus-refs check shared with 0014's
- The core's hooks: the `/system` guardian, lookup by path for actors and temporary refs, and the ref provider
- The new dead-letter reasons

**Done when** tests cover:

- [x] Every JSON value, and refs anywhere in one, round-trip through encode and decode, including a property test of arbitrary values
- [x] A value that isn't JSON plus refs is refused with the path to the first bad part, and `$` keys are escaped
- [x] A local ref encodes with this node's address and uid, and decodes back to the same ref on this node. A ref to a stopped actor, or another uid, decodes to one whose `tell` is a `stopped` dead letter
- [x] A temporary ask ref can be found by path while its ask waits, and not after
- [x] Actors under `/system` don't appear under `/user`, and `terminate()` stops them after `/user`
- [x] Nothing changes for a system with no cluster: the existing suite passes unchanged, and the benchmark's `events-none` stays within its spread

### T2. Remoting on the in-memory network

Write [0026](#decision-records).

- `Transport` and `Connection`, `inMemoryNetwork`, the handshake, remote refs, `tell` and `ask` across nodes, and remote death watch
- `test/helpers/cluster.ts`: N systems on one `ManualScheduler` and one network, with `advance` and `settle` across all of them

**Done when** tests cover:

- [x] A `tell` to a remote ref arrives, and messages from one node to one actor arrive in send order
- [x] An `ask` across nodes resolves, a piped one stays on the scheduler, and one whose node is killed times out
- [x] A reply carries a ref back, and a ref passed on to a third node still reaches the right actor
- [x] An unserializable message is a dead letter, never a throw. Frames for a killed node fill the buffer, then become `unreachable` dead letters
- [x] A handshake with the wrong cluster name or protocol is refused, with a log entry saying why
- [x] Watching a remote actor gives `terminated` when it stops, and when its node goes. Watching an entity ref throws
- [x] `delivered.from` is the remote sender's full path when the sender was known
- [x] Determinism: two runs of three nodes with the same seed give identical events on every node

Notes from T2 (plan review, 2026-11-23):

- Without membership, a node "goes" in two ways: a hello brings a new uid at its address, or `nodeDown` is called, which T4's downing will call. Both are tested. A kill alone signals nothing, since the node may come back.
- Entity refs come in T6. T2 proves that a ref nothing can watch, such as a temporary ask ref, throws a `TypeError`. The entity-ref case is a box in T6's Done when.
- `/cluster` stays internal until T4 adds `joinCluster`. T2's tests import from `src/cluster/`.
- A remote actor's failure arrives as a plain `Error` with the original's name and message, and no stack. A gone node's watches fail with `node <address> is gone`.

### T3. The TCP transport

Write [0027](#decision-records).

- `src/node/cluster/`, the `./cluster/tcp` export: length-prefixed frames on `node:net`, the challenge-response, reconnecting with backoff

**Done when** tests cover:

- [x] Two systems in one process, on TCP over loopback, pass T2's remoting tests (the same suite, on another transport)
- [x] Frames split across reads, and several in one read, decode correctly. A frame over the limit closes the connection
- [x] A peer with the wrong secret is disconnected before any other frame, and the secret never appears in what's sent (checked on the raw socket)
- [x] A dropped connection reconnects with backoff, and messages sent meanwhile arrive in order once it's back
- [x] `host` defaults to `127.0.0.1`, and `close()` ends every connection
- [x] A package test: the entry point loads from `dist/` and imports only `node:net` and `node:crypto`

Notes from T3 (plan review, 2026-11-23):

- The suite runs on TCP with remoting still on the `ManualScheduler`, and the test network waits for the sockets to go quiet. Two of its tests run only on the in-memory network, since TCP's timing belongs to the operating system: determinism from a seed, and a piped ask completing with only the scheduler running.
- `Transport.listen` gains an optional `onRefused`, so a refused peer is logged by the system's logger, not a logger of the transport's own.
- `tcpTransport` takes `maxFrameBytes` too, default 1 MiB, the same as remoting's limit on what it sends.
- A peer gets 5 s to prove the secret, on the socket's own idle timer. The test of it shortens that through an internal option, and runs on real time, as `realScheduler`'s tests do.
- Once connected, remoting writes without backpressure, so a slow peer grows Node's write buffer. T8's benchmark checks whether it matters.
- The README's note on keeping cluster traffic on a private network comes in T10, when the cluster is documented.

### T4. Membership

Write [0028](#decision-records).

- `joinCluster`, seeds, gossip, heartbeats, reachability, downing, `leave()`, and the member events

**Done when** tests cover:

- [x] Three nodes started from a seed list converge on the same table, whatever order they start in. Only the first seed forms a cluster alone
- [x] A killed node is unreachable after `unreachableAfterMs` and down after `downAfterMs`, on every node, and its watches signal
- [x] A node restarted at the same address with a new uid replaces its old entry
- [x] A node that learns it's down leaves, and a leaving node is gone from every table once it has left
- [x] Gossip merges correctly in any order: a property test of merge being commutative, associative and idempotent
- [x] Invalid options throw from `joinCluster`, unknown fields included

Notes from T4 (plan review, 2026-11-23):

- Uids are random, so no uid is later than another. The table has one entry per incarnation, keyed by address and uid, and a status that only moves forward (`up`, `leaving`, `down`, then a hidden `removed` tombstone), so merge keeps each entry's furthest status. A new incarnation retires the others at its address, and so does the member that lets it in. Tombstones are pruned after 24 hours, as Akka's are.
- `downAfterMs` counts from when the member became unreachable, so a killed node is down about 15 s after its last heartbeat with the defaults.
- Membership's frames (`hb`, `join`, `gossip`, `downed`) are remoting control frames, sent only on an open connection, never buffered, and not actor messages. Gossip goes out on the heartbeat tick, so there's no `gossipMs`.
- A downed node learns it from gossip, or from a `downed` frame sent when its hello is refused, and honours either only from a member it still treats as up. Two sides of a partition that down each other leave two clusters, not none.
- A down member stays in `members()` as `down` until a new incarnation replaces it. A node that left is gone at once.
- `system.terminate()` leaves as it finishes, with no handoff, since T4 has no shards. T7 adds the core hook that makes `terminate()` wait for the handoff before it stops `/user`.
- The member events aren't in Backstage's `hello.history` yet. T9 adds them with protocol version 2.
- Membership doesn't close a connection whose peer has gone unreachable. T8's processes will show whether TCP's half-open connections need it.

### T5. Shard leases

Write [0029](#decision-records).

- `ShardStore`, `inMemoryShardStore`, `postgresShardStore` and its schema SQL, and a contract suite run against both

**Done when** tests cover:

- [x] The contract, on both backends: acquire a free lease, fail on a held one with its holder, take an expired one with a higher token, renew all, release only with the right token, list holders by prefix, remember and forget
- [x] Postgres: two pools racing to acquire one lease, many times, never both win (integration)
- [x] Postgres judges expiry on its own clock: a holder whose renewal is held past the TTL loses the lease (integration, with the pool that holds a statement: the renewal before it's sent, and at its `COMMIT`)
- [x] A holder stops treating a lease as its own at its deadline when renewals fail or hang, before the store would give it to anyone else
- [x] `setup()` is safe to run twice at once, as the journal's is

Notes from T5 (plan review, 2026-11-23):

- Re-acquiring a live lease you hold keeps its token. Taking one that's free, released or expired raises it, even for the holder that had it, since that's a new ownership. Release keeps the row, expired, so tokens never reset.
- `inMemoryShardStore`'s `clock` defaults to `Date.now`, as the journals' do (0015). Clusters on a `ManualScheduler` pass the scheduler's `now`.
- The test pool's hold is generalized to any statement, held before it's sent. `holdNextCommit` is one case of it. `renewAll` still runs in a read-committed transaction, for isolation, so the tests hold it both before it's sent and at its `COMMIT`.
- The holder's side, `src/cluster/leases.ts`, is internal. T6's shards use it, and emit `shardAcquired` and `shardReleased`. T6's `sharding.init` sets the defaults (`ttlMs` 10,000, `renewMs` 3,000, `marginMs` 2,000).
- If Postgres's wall clock jumps forward, a lease can expire in the store before its holder's deadline. The journal's sequence check still catches the second writer. 0029 says so, and milestone 5's clock skew will measure it.
- The shard store's `setup()` takes the schema's advisory lock, as the journal's does, so the two can set up one schema at once. The Postgres helpers both share are in `src/persistence/postgres/pool.ts`.

### T6. Cluster sharding: routing and placement

Write [0030](#decision-records).

- `sharding.init`, entity refs, regions and shards, routing with buffering and `notOwner`, rendezvous placement, acquiring on demand, the inbound schema

**Done when** tests cover:

- [x] A message to an entity ref from any node reaches the one entity with that id, and `ask` works through it
- [x] Every node computes the same desired owner from the same members, and adding a fourth node moves only the shards it now tops
- [x] A message to an entity on the same node is encoded and decoded: a message with a `Map` is a dead letter even there
- [x] Watching an entity ref throws a `TypeError` (moved from T2, which had no entity refs)
- [x] A message that fails the type's schema is an `invalid` dead letter, with its issues logged
- [x] An entity ref travels in a message and still reaches its entity after the shard moves
- [x] A node with `host: false` routes but never holds a shard
- [x] A node whose `shardCount` differs is refused
- [x] **The invariant, in process:** over 200 seeds of three nodes with kills and restarts, no two live intervals for one entity overlap, and every acknowledged hold is in the journal

Notes from T6 (plan review, 2026-11-23):

- Lease timing is per node, on `joinCluster`'s `leases: { ttlMs, renewMs, marginMs }`, not per type on `sharding.init`, since `renewAll` renews every lease a holder has. The defaults are T5's.
- `shards` is optional on `joinCluster`, so a cluster without sharding needs no store. `sharding.init` throws without one.
- The `shardCount` check isn't in the remoting handshake, since `init` can run after connections are up. Regions exchange a hello with their `shardCount` and whether they host, as ordinary messages, and a mismatch is refused for that type on both sides, with an error logged. The same hello tells placement which members host the type.
- A region waits up to about a second for a hello from every up member before it places a shard, so nodes that start together agree on placement.
- Messages that race an entity's own stop (`ctx.stop()`, `thenStop()`, a failure) are `stopped` dead letters. Buffering through a stop comes with T7's passivation, where the shard knows the stop is coming.
- A leaving, downed or terminating node stops its shards and releases their leases, with no handoff. T7 adds the handoff, and the core hook that makes `terminate()` wait for it.
- The test cluster's `kill` cuts the node off from the shard store first, so its leases expire as after a real `kill -9`, rather than being released.
- The invariant test's entities are the test helper's persistent accounts, so its acknowledged holds are acknowledged deposits. It adds network partitions and store cuts to kills and restarts. Kills alone never make two owners, since a killed node's entities stop at once, so without them a store that granted held leases went unnoticed.

### T7. Passivation, rebalancing, handoff and remembering

**Done when** tests cover:

- [x] An idle entity passivates after `idleMs`, and a message during its stop reaches the next incarnation
- [x] A new node gets its shards one handoff at a time, at most `maxHandoffs` at once, and messages sent during a handoff are delivered once each
- [x] A handoff waits for an in-flight persist before releasing the lease
- [x] A graceful leave hands off every shard before the node exits, and no ask to its entities times out
- [x] A killed node's shards come back on the others once its leases expire, and remembered entities start without a message
- [x] A shard whose holder is unreachable isn't moved
- [x] The T6 invariant test runs again with joins, leaves and passivation in the mix

Notes from T7 (plan review, 2026-11-23):

- Two core hooks, never exported. `stopWhenIdle(ref)` puts a stop at the back of an actor's mailbox, because a stop goes ahead of it and would make what's queued dead letters. `onTerminate(task)` runs the cluster's leave after `/user` has stopped and before `/system` stops, and `/system` actors keep spawning and taking messages until then.
- A handoff reuses T6's `start` and `home`: drain the shard, release the lease, then ask the desired owner to start it and send what waited when it answers.
- `passivation`, `remember`, `rebalanceMs` and `maxHandoffs` are per type, on `sharding.init`. `remember` with `passivation` throws.
- A remembered entity's first message doesn't wait for the store's write. An entity that stops on its own, a failure its supervision stops it for included, is forgotten.
- A remembered type takes every shard it's the desired owner of that nobody holds, at each rebalance, so after a kill its entities come back with no message. That needs no new `ShardStore` method.
- A graceful leave hands every shard off at once, ignoring `maxHandoffs`, and its releases say `leaving`. A rebalance's say `handoff`.
- Out of scope: a timeout for a handoff whose entity never finishes, such as a persist that never settles. It holds the leave until the lease's deadline. Store and journal timeouts are milestone 5's.

### T8. Real processes: the multi-process test and the benchmark

- `examples/cluster/`: a node and the crowd, configured by environment
- `npm run test:cluster` and its CI job
- The benchmark scenarios above, recorded on Node 22, 24 and 26

**Done when:**

- [ ] Three node processes and a crowd on TCP and Postgres sell seats, and `kill -9` of one brings its entities back on the others within 15 s with the defaults, with every acknowledged sale in the journal
- [ ] Restarting the killed node moves about a third of the shards back to it, and stopping one gracefully loses no ask
- [ ] Over 20 kills, no `JournalConflictError` is logged, and every entity's incarnations, read back from the journal, never overlap
- [ ] The benchmark rows are recorded with their `setup.json`, and the failover and handoff numbers are in 0029's and 0030's Evidence
- [ ] The lease defaults are tuned against the failover numbers, and the reason is recorded

### T9. Backstage for clusters, and festival night on the site

- The protocol's version 2, the cluster panel, the sharding tree, the node picker and cluster map
- `demo/cluster/` and its domain on the in-memory network

**Done when:**

- [ ] The store has unit tests for cluster frames: members, reachability, shard owners and moves, and a version 1 `hello` still works
- [ ] `/cluster/` shows three nodes selling seats. *Kill node* makes its shards fail over, *Restart node* and *Add a node* move shards to it, and *Leave gracefully* hands off with no lost ask
- [ ] Two runs with the same seed tell the same story, event for event, on every node
- [ ] Playwright covers each button, the node picker, the phone width and the frame budget (no frame over 50 ms in a kill at 4×)
- [ ] The site bar links the new page, and it has its own title, link preview and pageviews
- [ ] Someone non-technical can say what happened when a node was killed (you check this)

### T10. Docker Compose, the write-up and 0.2.0

Write [0032](#decision-records).

- `docker-compose.cluster.yml`, `npm run cluster:up` and `cluster:down`, a `scripts/cluster-smoke.sh` run in CI
- The write-up's new section, the README's cluster section, AGENTS.md's layout and commands
- 0.2.0 from CI, after your approval of the tag

**Done when:**

- [ ] The demo in "Outcome" works from a clean clone with `npm ci && npm run cluster:up`, and the smoke script kills a node and checks the failover in CI
- [ ] "How Troupe works" has a section on the cluster that cites 0025 to 0032, and "What's next" is only Rehearsal. The records test passes
- [ ] The README covers joining a cluster, sharding an entity type, what's guaranteed (at most one instance, at most once, order per pair) and what isn't, the secret and the private network, and the failover numbers
- [ ] Every new export has TSDoc, and the export-list test, `publint`, `attw` and `check-pack.ts` cover the three new entry points
- [ ] After your approval in chat, `v0.2.0` is tagged and published with provenance, and the smoke script's quick start works from npm on Node 22, 24 and 26
- [ ] The changelog lists every public API change in 0.2.0

## Stretch goals

Only after T10, and only if the milestone is otherwise done.

- **Keep the majority.** A node that sees fewer than half the members as reachable for `downAfterMs` releases its leases and stops its shards, so the larger side of a partition takes them over instead of waiting for it to heal.
- **Understudy.** For a type with `understudy: true`, each shard's second choice by rendezvous hashing runs a standby that follows the shard's entities' journals by tag, so on failover it has their state and only replays the tail. Measured against T8's failover time.
- **Phi-accrual failure detection** in place of the fixed timeout, if T8's numbers show false downs under load.

## Definition of done

- [ ] T1 to T10 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration`, `coverage`, `build` and `check:package` all pass, locally and in CI, and so do the Playwright job and the `test:cluster` job.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies, and no peer dependencies.
- [ ] Everything outside `src/node/` builds with no Node types and imports no Node built-ins.
- [ ] Both shard stores pass the contract suite, and the invariant holds over every seed in the in-process test and every kill in the multi-process one.
- [ ] `@kylewillett/troupe` 0.2.0 is on npm with provenance.
- [ ] The cluster demo works in Docker Compose and is live on the site.

## Decision records

The tasks add these records, as Proposed, and accept them once their tests pass. Read [0003](decisions/0003-injected-scheduler-and-random.md), [0009](decisions/0009-ask-is-a-temporary-ref.md), [0010](decisions/0010-piped-asks-stay-on-the-scheduler.md), [0013](decisions/0013-sequence-check-is-the-single-writer-backstop.md), [0014](decisions/0014-events-are-json.md), [0016](decisions/0016-postgres-appends-take-a-journal-lock.md) and [0021](decisions/0021-backstage-only-watches.md) first, since these build on them.

| # | Decision | Task |
| --- | --- | --- |
| 0025 | Messages on the wire are JSON plus refs, refs travel as an address and a path, and messages to entities are always encoded | T1 |
| 0026 | Remoting is at most once and ordered per pair of nodes, behind a `Transport` interface, and remote asks settle through the asker | T2 |
| 0027 | Nodes talk over TCP on `node:net` with length-prefixed JSON frames and a challenge-response on a shared secret | T3 |
| 0028 | Membership is gossiped with no leader, and downing is automatic, because ownership doesn't depend on it | T4 |
| 0029 | A shard is owned by whoever holds its lease, and the store and the holder each time the lease on their own clock | T5 |
| 0030 | Shards are placed by rendezvous hashing over the reachable members, and move only by handoff or an expired lease | T6, T7 |
| 0031 | Failover waits for the lease, not for downing: a region routes only to a holder it can reach, and the lease defaults stay, as measured. Supersedes only 0030's rule for routing to an unreachable holder, so 0030 stays Accepted, and its status line points to 0031 | T8 |
| 0032 | 1.0 comes after milestone 5, not milestone 4. It supersedes only 0024's plan for 1.0, so 0024 stays Accepted, and its status line points to 0032 | T10 |

## Open questions

1. **The node-to-node transport.** Options: TCP on `node:net` with length-prefixed frames, as above; a WebSocket server written by hand on `node:http` (Node has a WebSocket client built in, but no server); or `ws` as an optional peer dependency. Recommendation: TCP. Nodes don't need anything WebSockets add, framing is about 40 lines, and there's no upgrade handshake to get right. `ws` breaks "no peer dependencies". A browser can't reach a node either way without a different design, which is the roadmap's later browser-to-server transport.

   *Answer (spec review, 2026-11-23): TCP on `node:net`, with length-prefixed frames.*

2. **Fencing the journal with the lease token.** Options: leave the sequence check as the only backstop, as above; or have the Postgres journal's append also check, in the same transaction, that the writer still holds its shard's lease with its token. Recommendation: leave it. The sequence check already keeps every stream linear when a paused node wakes and writes, which is the only case fencing adds to, and fencing would tie the journal to sharding and to Postgres. Milestone 5's paused clocks will show whether the gap matters.

   *Answer (spec review, 2026-11-23): the sequence check only. No lease check in the journal.*

3. **Encoding messages to local entities.** Options: always, as above; or only when the entity is on another node, as Akka does by default, with a testing switch to encode everything. Recommendation: always. Otherwise whether a message works depends on where a shard happens to be, which is the thing location transparency promises you never need to know. The benchmark's "entity tell, local" row prices it. If it's too dear, a switch can turn it off later. A switch can't easily turn it on once code depends on sharing objects.

   *Answer (spec review, 2026-11-23): always encode, even when the entity is on the same node.*

4. **Remote death watch.** Options: build it, as above; or keep `ctx.watch` local-only and throw for remote refs until a later milestone. Recommendation: build it. It's small once membership has down events, and a `watch` that throws for some refs and not others breaks location transparency, which AGENTS.md makes a rule.

   *Answer (spec review, 2026-11-23): build remote death watch in this milestone.*

5. **Authenticating nodes.** Options: none, on a private network; a shared secret proven by challenge and response, as above; or mutual TLS on `node:tls`. Recommendation: the challenge-response. Remoting lets a peer tell any actor anything, so a cluster port open to the wrong network is a remote control for the whole system. A secret closes that for a few lines, with no certificates to manage for a demo. TLS can come later in the same transport.

   *Answer (spec review, 2026-11-23): a shared secret, proven by challenge and response. TLS later.*

6. **Backstage across nodes.** Options: one view per node, with the demo page switching sources, as above; or one node's Backstage gathering every node's frames over the cluster transport. Recommendation: one view per node. Gathering would make every node stream every message to one place, a second protocol to secure ([0021](decisions/0021-backstage-only-watches.md)), and the demo can draw the whole cluster without it, from three in-process sources.

   *Answer (spec review, 2026-11-23): one view per node, with a node picker and a cluster map on the demo page.*

7. **The browser cluster demo.** Options: three in-memory nodes on the site at `/cluster/`, as above; or the Docker Compose demo only, with a recording on the site. Recommendation: in the browser. It's what makes the milestone visible to someone who won't run Docker, it runs the real sharding code as opening night runs the real actors (0004), and it's the in-memory network milestone 5 builds on anyway.

   *Answer (spec review, 2026-11-23): in the browser, at `/cluster/`, as well as Docker Compose.*

8. **The Postgres journal lock.** Milestone 3 found it caps one journal at about 2,200 appends a second, and many entities writing at once is what sharding makes common ([0019](decisions/0019-how-the-benchmark-measures.md)). Options: keep it; or replace it with gap detection in tag readers, as 0016 names. Recommendation: keep it in this milestone. The demo writes tens of events a second, not thousands, and the change is a journal change, not a cluster one. T8 records appends a second across three nodes, so the write-up can say where the ceiling is.

   *Answer (spec review, 2026-11-23): keep the lock, and measure it across three nodes in T8.*

9. **The version.** Options: 0.2.0; or 1.0.0, as [0024](decisions/0024-publish-from-ci-with-provenance.md) planned for after this milestone. Recommendation: 0.2.0. Milestone 5's simulated network and store will test `Transport` and `ShardStore` harder than anything here, and journal timeouts (milestone 2, open question 2) still change the persistence interfaces. 1.0 after milestone 5. 0024 is Accepted and plans 1.0 for after this milestone, so choosing 0.2.0 adds a short record that supersedes that plan, rather than rewriting 0024.

   *Answer (spec review, 2026-11-23): 0.2.0, with 1.0 after milestone 5. T10 writes 0031 to record it.* (T8 took 0031 for the failover finding, so this is 0032.)
