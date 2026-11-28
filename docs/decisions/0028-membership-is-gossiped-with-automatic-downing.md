# 0028. Membership is gossiped with no leader, and downing is automatic, because ownership doesn't depend on it

- **Status:** Accepted. Its downing, and what a node does about being downed, are superseded by [0042](0042-keep-the-majority.md)
- **Date:** 2026-11-23
- **Milestone:** 4

## Context

A cluster needs every node to agree, eventually, on who the members are: where a message can go, and, from T6, where a shard should live. Akka answers this with a leader that moves members through their states, plus a split-brain resolver. Auto-downing without one is unsafe in Akka, since a downed node that's still running keeps its shards. In Troupe, a shard is owned by whoever holds its lease in the shard store (0029, in T5), whatever membership says. So membership only has to be eventually right, and a wrong answer costs availability, never a second copy of an entity. The design must run on the system's scheduler and `random`, so a cluster on a `ManualScheduler` repeats from its seed ([0003](0003-injected-scheduler-and-random.md)), and it must work on any transport ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)).

## Decision

- **The table has one entry per incarnation, keyed by address and uid.** An entry's status is `up`, `leaving`, `down`, or `removed`, in that order, and only moves forward. `removed` is a tombstone: it's hidden from `members()`, and kept so stale gossip can't bring the entry back. Merging two tables keeps each entry's furthest status. That's commutative, associative and idempotent, so the table converges in any order, with no coordinator.
- **Uids are random, so nothing compares them.** The spec's sketch said a later uid replaces an earlier one at the same address, but a random uid can't say which incarnation came later. Instead, a new incarnation retires the others at its own address when it learns of them, and so does a member that lets it in, since only one process can hold an address. Retiring is a local step that moves the old entry to `removed`, and gossip carries it from there.
- **Joining goes through seeds, and only the first seed forms a cluster alone.** A node sends `join` to each seed on every tick, and at once when a connection to one opens. Only a member that's up answers, with its table, which now includes the joiner. The first seed in the list forms a cluster alone after `seedTimeoutMs` (default 5,000) if no other seed has let it in, or at once if it's the only seed. So two halves can't each form a cluster at start-up. `whenUp` resolves when the node is in, and rejects if it leaves first.
- **Gossip, one member per tick.** Every `heartbeatMs` (default 1,000), each node sends its whole table to one member, chosen by the system's `random`, preferring reachable ones. The receiver merges it. If it knew something the sender didn't, it answers once, with a frame marked as a reply, so two nodes agree after one exchange. A few tens of nodes fit in one frame, which is all this milestone aims at. Gossip from a member this node has downed or removed is ignored.
- **Heartbeats, full mesh.** On the same tick, every node sends a heartbeat to every member that's up or leaving. A member not heard for `unreachableAfterMs` (default 5,000) is unreachable, in this node's view only. Reachability is never gossiped, and a heartbeat makes the member reachable again.
- **Downing is automatic.** A member that stays unreachable for `downAfterMs` (default 10,000), counted from when it became unreachable, is downed, and that's gossiped. With the defaults, a killed node is down about 15 s after its last heartbeat. Downing a node, or removing one, ends every watch on its actors and turns what was waiting for it into `unreachable` dead letters, through remoting's `nodeDown`, which now takes the uid, so downing an old incarnation never downs its replacement.
- **A node that learns it's down leaves.** It learns from gossip, or from a `downed` frame that remoting sends when it refuses a downed incarnation's hello. Both count only from a member this node still treats as up or leaving. The node then closes its connections, and can come back only by restarting, with a new uid. So when two sides of a partition down each other, the result is two clusters rather than none. The shard leases keep each entity single across them, and the keep-majority stretch goal is what would end the smaller one.
- **Leaving.** `leave()` marks the node `leaving` and sends its table to every member, then (after T7's handoff) marks itself `removed`, sends its table again, and closes. The others see `memberLeaving`, then `memberRemoved`, and stop heartbeating it, so it's never found unreachable. `system.terminate()` leaves the same way as it finishes. T7 adds the core hook that makes `terminate()` wait for the handoff before it stops `/user`.
- **Tombstones are pruned after 24 hours,** as Akka prunes its gossip tombstones. A pruned key is remembered for another 24 hours, and gossip that still has it is filtered, since other nodes prune a little later than this one. A down member stays visible as `down` until a new incarnation at its address replaces it, or it's pruned.
- **Membership's frames are remoting's control frames.** `hb`, `join`, `gossip` and `downed` are sent only on an open connection. Without one, the send starts a dial and drops the frame, since the next tick sends a fresh one. They never wait in the message buffer, and they aren't actor messages, so they don't flood Backstage's message view.
- **Events.** `memberUp`, `memberLeaving`, `memberDown` and `memberRemoved`, each with the address and uid, and `reachability` with the address, uid and new value, on the system's event stream. Each node publishes its own view, itself included.
- **Options are checked in `joinCluster`,** unknown ones included. `unreachableAfterMs` must be more than `heartbeatMs`, seeds must be addresses with none listed twice, and a system can join only one cluster.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A leader moves members through their states, as Akka's does | Needs leader election or convergence checks with seen-sets in every gossip. Here membership decides nothing that needs one: leases decide ownership |
| Downing by hand, or only by a split-brain resolver | Safe in Akka only because ownership follows membership. Here a downed node that's still running can't keep a shard past its lease, so automatic downing costs nothing in safety |
| Key the table by address, with "a later uid wins" | Uids are random, so there's no later. Ordering them by a clock compares two nodes' clocks, which the spec rules out, and milestone 5 skews them |
| SWIM, or phi-accrual failure detection | A fixed timeout first, measured in T8. Phi-accrual is a stretch goal if T8 shows false downs under load |
| A `/system/cluster` actor, with heartbeats as actor messages | Every heartbeat would be a message event, flooding Backstage. Remoting's buffer would keep stale heartbeats for an unreachable peer and deliver them in a burst, saying it's reachable when the link comes back rather than when it was heard |
| Honour any `downed` frame or gossip, from anyone | When both sides of a partition down each other, each would make the other leave, and no cluster would be left |
| Never prune tombstones | Every incarnation that ever left would stay in every gossip frame forever |

## Evidence

**T4 (2026-11-23):**

- `test/cluster/table.test.ts`:
  - A property test over 1,000 seeds of three random tables each: merge is commutative, associative and idempotent, its result is sorted the same way whatever the order, and it never loses a status either side had.
  - An incarnation keeps its furthest status, and two uids at one address are two entries.
  - Gossip encoding round-trips, and anything that isn't a table is refused.
- `test/cluster/membership.test.ts`, on `test/helpers/cluster.ts`, which can now start nodes one by one, join them with `startCluster`, and wrap their transports to drop frames:
  - **Joining.**
    - Three nodes converge on the same table, all up and reachable, in all six start orders, two seconds apart, and when they start together. Each sees three `memberUp`s.
    - The second and third seeds started alone are never up after 60 s, with empty tables.
    - The first seed alone is up at exactly 5,000 ms, and a node whose only seed is itself is up at once.
    - A node that isn't a seed joins through one.
    - `whenUp` rejects when the node leaves first.
    - Three nodes converge on TCP over loopback too, and one leaves.
  - **Failure detection.**
    - After a kill, every node sees the node unreachable between 4 and 6 s later, and down exactly 10 s after that. A watch on its actor gets `terminated` with `node node-3 is gone: down`, and a tell that waited for it becomes an `unreachable` dead letter.
    - A node whose heartbeats are lost for 7 s is unreachable but still up, and reachable again once they arrive.
    - A node restarted before it was downed, and one restarted after, are each in every table once, with the new uid. The others see `memberRemoved` for the old uid and `memberUp` for the new one.
    - A down member's tombstone is pruned after `pruneAfterMs`, with a `memberRemoved`, and the other node's later gossip doesn't bring it back.
  - **Downing and leaving.**
    - A node whose heartbeats are lost one way, so it still hears the others, is downed by them. It learns this from the `downed` frame, publishes `memberDown` for itself, logs why, and leaves.
    - A leaving node is gone from every table once `leave()` resolves. The others see `memberLeaving`, then `memberRemoved`, and nothing about it afterwards. `system.terminate()` does the same.
    - A `downed` frame from a node that isn't a member is ignored.
    - Gossip from a node that knew less gets one answer, and an answer gets none.
    - Malformed gossip and unknown frames are logged and ignored.
  - **Determinism.** Joining, a kill, a restart and a leave, run twice with seed 42, give identical events on every incarnation of every node. Seed 43 gives different ones.
  - **Options.** Every bad option throws a `TypeError` from `joinCluster` naming it, unknown fields included, as does a system not made by `createActorSystem`. A second `joinCluster` on one system throws.
- Breaking each of these fails a test:
  - merging to the earlier status fails the property test and most of the membership tests
  - letting any seed form a cluster alone fails the first-seed test and the start orders
  - ignoring `downed` frames fails the downed-node test
  - not calling `nodeDown` fails the watch and dead-letter tests
  - counting `downAfterMs` from the last heartbeat fails the kill test's 10 s
  - not filtering pruned keys fails the pruning test
  - not answering gossip fails the push-pull test

## Consequences

- A partition that leaves each side downing the other leaves two clusters until a restart. Leases keep entities single across them, and the keep-majority stretch goal is the fix.
- A node takes about `unreachableAfterMs + downAfterMs` to be downed after it dies. That's not the failover time: a shard moves when its lease expires (T5, T7).
- Remoting's buffer for a dead peer, which T2 held for good, now empties once the peer is downed.
- A half-open connection, which the other side hasn't seen close, makes its peer unreachable but isn't closed by membership. T8's processes will show whether TCP needs it closed on unreachability.
- Milestone 5 can partition, delay and reorder frames, and the table still converges, since merge is order-free. Its checker can read the member events from each node's stream.
