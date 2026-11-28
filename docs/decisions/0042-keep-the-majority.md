# 0042. Keep the majority: only the larger side of a split downs the rest, and two clusters settle it when they meet

- **Status:** Accepted
- **Date:** 2026-11-25
- **Milestone:** 5

## Context

[0028](0028-membership-is-gossiped-with-automatic-downing.md) downs a member that stays unreachable, on every node's own view, and says what that costs: "a partition that leaves each side downing the other leaves two clusters until a restart", with keep-majority, milestone 4's stretch goal, as the fix. Leases keep every entity single across the two ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)), so it was never a safety problem. T7's hunt measured it as an availability one. Over the first 10,000 seeds of festival night, `recovers` failed 726 in contract mode and 860 in chaos mode, and four in five of those shrank to a single partition: each side downed the other, neither listens to a member it has downed, and the halves never merged. A one-way partition was worse, since a node that heard no one downed everyone while they, still hearing it, downed no one.

Once a partition no longer split the cluster for good, the hunt found the next layer down: the views a decision is made on. A node knows only its own table, so two sides of a partition can count different members, when a join hasn't spread yet or a newcomer was let in on one side, and each can believe itself the larger.

## Decision

- **Only the larger side downs the rest.** When a member has been unreachable for `downAfterMs`, the node counts the members up or leaving in its own table, itself included, and how many of them it can reach. If that's more than half, it downs the unreachable ones, as before. If it's less, it downs itself: it gossips that to whoever still hears it, and leaves, to come back as a new incarnation through its seeds. At exactly half, the side holding the first seed that's a member keeps the cluster, or, if no seed is a member, the side with the lowest address. Seeds rather than addresses because every node has the same list, seeds are the nodes that host, and a client such as `crowd` sorts before `node-1`: in the hunt's contract seed 10,475 the crowd's side won a tie by address, and a kill a moment later left the crowd alone. The rule is a pure function, `decideDowning`, of one node's view.
- **A side of one never keeps the cluster,** unless that node is the only seed, which may form a cluster alone anyway ([0028](0028-membership-is-gossiped-with-automatic-downing.md)). A node by itself can't tell a dead peer from a partition, and a view of two can be a join that hasn't spread. One that goes rejoins; a lone survivor would have downed the rest for good.
- **No one new is let in while a member is unreachable,** and a node in that state greets no missing seed. Otherwise a newcomer counts towards one side's majority and not the far side's. The joiner asks again every tick. Members at the joiner's own address don't count: it replaces them. This is Akka's rule that members join only on convergence, without the leader.
- **A member greets the seeds it has no live member at,** every tick. A node that downs itself can restart while the partition still holds, and as the first seed form a cluster of its own. Whichever side hears the other's join lets it in, and its answer merges the tables.
- **Two clusters settle it when they meet.** Every hello now says which uid at the hearer's address the sender has down, if any, which it counts a member, if any, and the sender's side: how many members are up on it, the earliest seed among them, and its lowest address. Two nodes are in different clusters when one has the other down and the other doesn't count it a member: they downed each other after a split their views disagreed on, or one side has restarted since and the other has never heard of it. Then each end compares the two sides the same way, larger first, then the earlier seed, then the lower lowest address, and the end with the smaller side downs itself and rejoins. Both ends compute it, so exactly one gives way. A node downed by one it still counts a member is no split: it's a node that hasn't heard, and the `downed` frame makes it leave, as before. Remoting still refuses a downed incarnation's hello. The hello's new fields are optional, so the wire protocol stays version 1.
- **Membership's frames dial an address even while an old incarnation there is down.** Before, `nodeDown` without a uid it had met marked the whole address down, and nothing dialed it again, while the new incarnation there, which the table said was up, waited to be dialed. The hello says which uid answers, and a downed one is still refused. A message waits for a down address, and dials it, when its ref names another incarnation than the one downed there; one for the downed incarnation, or for no particular one, is dropped as before.
- **A refused downed incarnation is told so whichever side dialed,** not only when it dialed in. And a node still joining that's told its uid is down gives up, since that uid will never get in, and comes back as a new one: a one-way partition can lose the welcome of a node that was let in, and then downed.
- **A leaving node keeps heartbeating and gossiping** until it has left, and marks members it can't hear unreachable, so its handoffs go where they can land, but it downs no one. A handoff that outlasts `unreachableAfterMs` plus `downAfterMs` no longer gets the node downed halfway.

The rest of 0028 stands: the table, gossip, failure detection, leaving, and that ownership is the lease's.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep 0028's two clusters, and call the failures expected | Four in five of the hunt's failures, and a partition long enough to down is routine in production. Leases make it safe, not available |
| Akka's lease-majority, with the shard store as referee | Puts every downing decision behind the database, so a disk hang during a partition downs both sides. The hello settles the rare split keep-majority gets wrong without a new dependency |
| Keep-oldest or a static quorum | Need an order of age or a configured size that every node agrees on. Uids are random, so there's no oldest ([0028](0028-membership-is-gossiped-with-automatic-downing.md)), and a static quorum breaks as spares join |
| A leader that decides for everyone on a converged view, as Akka does | Brings back the election 0028 avoided. Settling at the hello covers the views that disagree, which is all a leader's convergence buys here |
| Down all when unstable, as Akka's resolver can | Turns every flapping link into a full restart |
| Let the lowest address win a tie even on a side of one | The hunt's chaos seed 710: the crowd, knowing only node-1 when a partition cut it off, won on its address and downed node-1 for good |
| Break every tie by the lowest address | Clients sort before hosts by name, so a side of clients and one host wins over a side of hosts. Every node agrees on the seed list just as well |

## Evidence

**T7 (2026-11-25):**

- `test/cluster/downing.test.ts`:
  - `decideDowning`: more than half keeps the cluster and less gives it up, at exactly half only the side with the first seed, or else the lowest address, keeps it, and a side of one never does unless its node is the only seed.
  - On the simulated network: a 3–2 partition of five nodes downs the two, which down themselves, and they merge once healed and restarted; a 2–2 partition keeps the half with node-1, or with the first seed where that's another node; in a one-way partition the node that hears no one downs itself, and the others down only it; of two nodes, each downs itself unless it's the only seed.
  - The first seed, restarted on the far side of a partition, forms a cluster alone, and the two merge once it heals.
  - A node that can't reach every member lets no newcomer in until it can, but a restarted node at an unreachable member's own address gets in at once.
  - A node let in whose welcome was lost, and then downed, gives up joining, and gets in as a new uid.
- `test/cluster/remoting-suite.ts`, on the in-memory, simulated and TCP networks: two nodes that downed each other settle it at their hello, the smaller side giving way, and at the same size the side without the earlier seed; downed by a node it still counts a member, nobody gives way; downed by a node it doesn't count at all, the smaller side gives way. A control frame dials an address whose old incarnation is down, and a downed incarnation that was dialed is told so.
- `test/cluster/handoff.test.ts`: a leave whose handoff takes twice as long as downing ends with the node removed, never downed.
- The hunt's regression plans in `test/demo/found.test.ts`, each of which broke `recovers` or `failoverWithin` before its fix: split brain, a lone first seed, an address never dialed, a newcomer counted twice, a side of one, two sides that downed each other, a join never finished, a reply dropped at a down address, and two clusters that never met.
- Across the hunt's million seeds (data in [0043](0043-the-hunt-and-fencing.md)), every run recovered, in both network modes and every fault mix.
- Breaking each of these fails a test:
  - always downing the others fails the three `decideDowning` tests and the 3–2, 2–2, one-way, two-node and merge tests
  - letting a side of one keep the cluster fails its `decideDowning` test and the two-node test
  - breaking ties by address alone fails the first-seed test
  - not greeting missing seeds fails the merge test and four plans: a lone first seed, a lost hello, two sides that downed each other, and a lease given back twice
  - letting newcomers in while a member is unreachable fails the newcomer test
  - not settling at the hello fails the remoting test, the two-sides plan and the never-met plan
  - not dialing a down address fails three remoting tests, the address-never-dialed plan and the two-sides plan
  - dropping messages for a newer incarnation at a down address fails its remoting test and the reply-dropped plan
  - ignoring `downed` while joining fails the joiner test and its plan
  - stopping heartbeats while leaving fails the long-handoff test
  - not marking reachability while leaving fails the leaving-node-that-never-stopped-asking plan

## Consequences

- A partition now costs the smaller side a restart: its nodes leave, and their shards fail over to the larger side by lease, as a kill's do. A cluster of two survives losing a node only through the only seed.
- A node can down itself, so a process manager that restarts nodes that exit is part of running a cluster, as it is for Akka. The examples' Docker Compose file already restarts them, and Rehearsal's scenarios do.
- Joins wait while a member is unreachable, by up to `downAfterMs`.
- The hello is a few bytes longer, and a node with a down address dials it with each membership tick, under remoting's backoff.
