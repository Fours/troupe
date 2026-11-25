# 0035. Safety is checked under any network fault, and ordering only under faults the `Transport` contract allows

- **Status:** Accepted, `failoverWithin` superseded by [0040](0040-planted-bugs-are-found-by-what-they-break.md)
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

Rehearsal needs a network that fails the way real ones do, so it can show the cluster survives them. The `Transport` contract ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)) promises frames in order per connection and at most once, and remoting's order and at-most-once guarantees rest on that. But one live instance per entity and no lost acknowledged write are meant to rest on the lease ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)) and the journal's sequence check ([0013](0013-sequence-check-is-the-single-writer-backstop.md)), never on the network. A network that only keeps the contract can't test that claim, and one that only breaks it would fail checks the design never promised to pass. The spec's partition fault also has to lose no frame from the middle of a connection in contract mode, while connections "see nothing", as with a dropped cable.

## Decision

- **`simulatedNetwork({ scheduler, random, mode, latencyMs, resetAfterMs })` implements `Transport` on simulation time,** as the in-memory network does, in `src/rehearsal/network.ts`. It's a separate implementation: the public `inMemoryNetwork` doesn't change. Every latency, loss and repeat is drawn from the network's own `random`, so a run repeats from its seed.
- **Each open, frame and close takes a latency drawn from `latencyMs`** (default 1 to 3 ms, both included). In contract mode nothing overtakes what was sent before it on the same direction of a connection, so drawn latencies reorder frames across connections but never within one.
- **Faults are methods that return a function to end them,** and T5's plans call them: `partition(side, other, { oneWay })`, `reset(a, b)`, `delay({ node, peer, latencyMs })`, `reorder({ node, peer, windowMs, within })`, and in chaos mode only, `lose({ node, peer, rate })` and `duplicate({ node, peer, rate })`. A fault that breaks the contract throws if it's asked for in contract mode. Two delays on one frame take the longer draw.
- **A partition in contract mode holds frames, as TCP does across a dropped cable.** What it stops waits, in order, and arrives once the partition heals. If a connection holds frames for `resetAfterMs` (default 10,000), it resets at both ends with an error, and what it held is lost, as TCP gives up retransmitting. A dial across a partition opens on heal, or fails after `resetAfterMs`. An idle connection notices nothing, however long the partition lasts. Opens, closes and a killed node's reset are held too, so the other end hears of them only once the partition heals or the connection times out.
- **Chaos mode breaks the contract on purpose:** single frames lost from an open connection, frames reordered within one, frames repeated, and partitions that lose the frames they cut instead of holding them. Opens, closes and resets are never lost, reordered or repeated, since they stand for TCP's own handshakes.
- **So the checks split by mode.** One live instance and no lost acknowledged write are checked in both modes. At-most-once delivery and order per pair are checked in contract mode only. T5 builds the checks.
- **The checks, as T5 settled them,** in `src/rehearsal/invariants.ts`, each a function of a run's history ([0034](0034-a-run-is-a-seed-and-a-plan.md)), never of the live system:
  - `oneLiveInstance`: no two instances of an entity are live at once. An instance is live from `spawned` until it stops, its process ends, or its node's lease on its shard runs out by the node's own clock (`leaseLost`), less the times its node was paused. From a lost lease on, an instance takes no new message. What it's still finishing, such as an append whose reply never came, is for the journal's sequence check to fence ([0013](0013-sequence-check-is-the-single-writer-backstop.md)), and the next two checks catch anything that gets past it.
  - `acknowledgedWritesKept`: every operation the scenario names as a write, which completed with a reply that acknowledged it, is in the journal at the end, found by the scenario's `kept`. And every stream is numbered 1 to n with no gaps.
  - `noStaleReads`: a read's position, read from its reply by the scenario, is at least that of every write to its entity that completed before the read began.
  - `atMostOnce`, contract mode only: no message an operation sent reaches its entity more often than it was sent.
  - `orderPerPair`, contract mode only: two messages from one client to one entity, delivered to one instance, arrive in the order they were sent. A pair counts only if the shard had stayed put: both were sent a lease's TTL or more after the shard started where they arrived, and after every node that held it before had let it go, with no fault under way until the last delivery. A move reorders messages in flight by design ([0030](0030-shards-are-placed-by-rendezvous-hashing.md)), and a client only hears of a move once the old owner answers, which the history can't show. So the check leaves out what it can't tell apart from a move.
  - `recovers({ withinMs })`: once the last fault has ended, within `withinMs`, every running node's member table, rebuilt from its member events, has exactly the running nodes up, and every shard a running node holds is on its desired owner. Every operation begun from then on must also answer.
  - `failoverWithin({ withinMs })`: after a kill with no other fault near it, every entity that was on the dead node, and is asked for, runs on another incarnation within the bound, by default `ttlMs` plus a renewal and a 2 s rebalance.
  - Overlaps in a run whose clocks went past the lease's margin are `expected`, not violations, while `acknowledgedWritesKept` and `noStaleReads` are checked and pass. A run goes past the margin when an incarnation's drift over one TTL exceeds `marginMs`, or a jump of the database's clock does ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)).
  - An invariant is anything with a `name` and a `check(history)`. It may give the `modes` it can be checked in, which a scenario holds it to when it's made.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Contract mode only | Can't test that safety rests on the lease and the journal rather than the network. That claim is what chaos mode is for |
| Chaos mode only | Ordering and at-most-once would fail under faults the contract rules out, so those checks couldn't run at all |
| A partition resets every connection across it at once | Connections would see the partition the moment it began, which a dropped cable doesn't do, and heartbeats that stop arriving would never be tested |
| A partition loses frames and keeps the connection open, in both modes | Loses frames from the middle of a connection, which TCP never does: that's chaos mode |
| Add faults to `inMemoryNetwork` | It's public API with a fixed latency and no random. Its users don't need faults, and Rehearsal's would leak into it |
| One `fault(json)` call now | The plan's JSON format belongs to T5. Methods give each fault a typed signature that the plans can map onto |

## Evidence

**T2 (2026-11-24):**

- `test/rehearsal/remoting.test.ts` runs remoting's whole suite on the simulated network with no faults, as it runs on the in-memory network and on TCP. The suite's short advances assume a fixed 1 ms latency, so it runs on `[1, 1]`.
- `test/rehearsal/network.test.ts`, on raw transports:
  - Latencies are drawn within the range, vary, and keep frames in order. Frames sent before a connection opens arrive just after it.
  - Dialing nothing, closing, killing, closing a transport and refusing a second one behave as on the in-memory network.
  - The same seed gives identical arrival times, and another seed gives different ones.
  - **Partitions.**
    - In contract mode, a partition holds frames both ways and delivers them in order on heal, and a one-way partition holds only what goes from the cut side.
    - A connection holding frames for `resetAfterMs` resets at both ends and loses them. An idle one survives a partition of any length.
    - A dial across a partition opens on heal, or fails after `resetAfterMs`.
    - A partition stops only frames between its sides, overlapping partitions hold until the last one heals, and a close or a kill's reset is held and arrives on heal.
    - In chaos mode, a partition loses the frames it cuts and leaves the connection open.
  - **Resets** close every connection between two nodes with an error and lose what was on its way, including a dial still in flight.
  - **Delay** applies to a node both ways or to one pair, keeps order, ends when asked, and the longer of two delays wins.
  - **Reorder** lets frames on three connections overtake each other, while each connection stays in order.
  - **Chaos mode** loses single frames with the connection open, reorders within a connection and repeats frames. It never loses or reorders opens and closes. Contract mode refuses all three faults.
  - Every option is checked where it's passed in.
  - **The contract-mode property.** 200 seeds of 400 random steps among four nodes: connections opened, frames sent both ways, closes, partitions both ways and one way, heals, resets, delays, reorders, and kills with restarts. Over those seeds, 7,199 frames were delivered, partitions held 38,958 opens, frames and closes, and 3,543 connections timed out. On every connection, each end got the start of what the other sent, in order, with nothing skipped or repeated. Every end that got less than everything had closed or been killed. The same steps in chaos mode break the property on 11 connections in 20 seeds, so the check can fail.
- `test/rehearsal/chaos.test.ts`, on whole clusters:
  - On latency drawn from 1 to 10 ms, with a 30 ms reorder window, 500 tells from each of two nodes reach an actor in each sender's order, interleaved differently from the order they were sent in.
  - **Chaos mode never makes the framework throw.** Three nodes with membership, sharding and a clock each run for 65 s of simulation time with 10% loss, 10% duplicates, reordering within connections and a partition every 15 s. The network lost 541 frames, repeated 386 and let 637 overtake. Every `advance` resolved, every ask was answered or timed out, nothing failed and nothing logged an error.
  - **Membership converges after a partition heals.** Node 1 is cut off for 1,500 ms, past `unreachableAfterMs` but short of downing, on clocks 2,000 ppm apart. The run is done three ways: in contract mode with frames held, in contract mode with a `resetAfterMs` of 500 so connections time out, and in chaos mode with 5% loss and reordering within connections. Each time, both sides see the other as unreachable during the partition, every table agrees afterwards with every member up and reachable, and no one was downed.
- Breaking each of these fails a test:
  - letting frames overtake within a connection in contract mode fails the order, delay, cluster and membership tests
  - losing cut frames in contract mode instead of holding them fails the partition and membership tests
  - never timing out held frames fails the timeout, dial and property tests
  - never flushing on heal fails the partition and membership tests
  - letting contract mode take chaos faults fails the refusal test

**T5 (2026-11-24):**

- `test/rehearsal/invariants.test.ts`. Each check passes on a run built to pass it, and fails on one built to fail it, with a violation that names the invariant, says what in a sentence, and gives the time, the nodes and the entity:
  - All seven pass on three nodes and a crowd with no faults, and with a kill and its restart.
  - `oneLiveInstance` fails when a store grants leases that are still held and a node is partitioned from the others, and the same plan passes without the bug. On a hand-built history, an instance stuck past its node's lost lease isn't a second live instance, and without the `leaseLost` event it is.
  - `acknowledgedWritesKept` fails for an entity that acknowledges deposits it never writes, and for a journal with an event taken out. It doesn't count replies the scenario says acknowledged nothing.
  - `noStaleReads` fails for an entity whose reads return 0.
  - `atMostOnce` fails when the crowd's transport sends every frame twice.
  - `orderPerPair` fails on a run's history with two deliveries swapped, since the contract network never reorders them itself.
  - `recovers` fails 1 ms after a restart, and `failoverWithin` with a 1 s bound, and both pass with theirs.
  - **Drift past the margin.** node-1's clock runs 10% slow, with a 10 s lease and a 100 ms margin, while it's cut off from the others and from the database. The others start its ledgers while it still runs them, and the overlaps are `expected`, with the journal invariants passing. With no journal invariants to vouch for them, the same overlaps are violations.
  - Bad options throw where they're passed in, `atMostOnce` and `orderPerPair` in a chaos-mode scenario included.
- `test/demo/rehearsal.test.ts`. Festival night, rehearsed: the lineup's shows on three nodes, a spare and a crowd that buys seats, as a hold then its confirm, and reads how many are sold, for a minute, under every group of faults. Over seeds 1 to 1,000 in each mode (`FESTIVAL_SEEDS=1000`, 100 in `npm test`):

  | Mode | ms a run | Faults | Operations | Answered ok | Seeds failing `oneLiveInstance`, `acknowledgedWritesKept`, `noStaleReads`, `failoverWithin` | `atMostOnce` | `orderPerPair` | `recovers` |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | contract | 30 | 3,573 | 399,539 | 374,615 | 0 | 0 | 1 | 63 |
  | chaos | 29 | 3,620 | 399,539 | 370,279 | 0 | not checked | not checked | 91 |

  Raw data: [0035-festival-2026-11-24.json](data/0035-festival-2026-11-24.json). Chaos mode lost, repeated and reordered frames within connections on top of every contract fault, and no run lost an acknowledged sale, served a stale read or ran a show twice. That's the claim this record makes. The operations are the same in both modes, since the workload draws from its own stream ([0034](0034-a-run-is-a-seed-and-a-plan.md)). The `recovers` and `orderPerPair` failures are real behaviour of the cluster, found by the checks, and left to T7's hunt: they're listed in the milestone spec.
- On the way, three checks were made narrower after they flagged runs that broke nothing. Each change is in the definitions above:
  - An instance waiting out a lost reply after its lease had gone was counted as live.
  - A refused buy was counted as an acknowledged write. In seed 602 of chaos mode, a deposed holder's hold landed after the new owner had recovered. The new owner's next append conflicted, it restarted, and it recovered the event: the sequence check doing its job.
  - Pairs a shard move had reordered were counted as out of order.
- Breaking each of these fails a test:
  - never finding an overlap fails the held-lease and drift tests
  - not ending an instance at its lost lease fails the hand-built history
  - never reporting drift as expected fails the drift test

## Consequences

- Rehearsal can test the claim that safety doesn't depend on the network, and the checks that do depend on it run only where the contract holds.
- A partition in contract mode can deliver a burst of stale frames when it heals: old heartbeats, gossip and messages, all in order. Membership and remoting already have to cope with this on TCP. Under Rehearsal they're tested on it every run.
- Shorter partitions leave connections alone and longer ones reset them, depending on `resetAfterMs`, so plans should draw both.
- Remoting's suite pins exact 1 ms timings, so it runs on a fixed latency. Remoting on drawn latency is tested by its own cluster tests, and from T5 by every run.
