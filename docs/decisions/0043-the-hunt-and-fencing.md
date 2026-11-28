# 0043. The hunt: a million seeds pass on the fixed code, and the journal stays unfenced

- **Status:** Accepted
- **Date:** 2026-11-25
- **Milestone:** 5

## Context

Milestone 5's T7 runs Rehearsal against the real code at scale: festival night, in both network modes, under varied fault mixes, fixing whatever it finds. Two questions ride on it. Milestone 4's open question 2 left fencing the journal with the lease token to be decided by what paused clocks show ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)), and T6 ([0040](0040-planted-bugs-are-found-by-what-they-break.md)) counted `recovers`, `orderPerPair` and `failoverWithin` failures without failing on them, until T7 fixed them. Over the first 10,000 seeds, `recovers` failed 726 in contract mode and 860 in chaos mode, `failoverWithin` 23 in each, and `orderPerPair` 4.

## Decision

- **Hunt in rounds, and fix what each round finds before the next.** Each failing seed is shrunk, traced from its history and the nodes' logs, fixed, and kept as a regression plan in `test/demo/found.ts`, which `found.test.ts` replays on festival night with every invariant checked. Five fault mixes vary what's drawn: `all`, festival's own; `nodes`, kills, pauses, leaves and joins with disk faults; `network`, the network alone; `clocks`, drift and jumps with disk faults; and `heavy`, every kind at twice the rate, three at once. `npm run rehearse -- --mix <mix>` and `festival({ mode, mix })` take them.
- **The fixes.** Twenty bugs in the real code, one of them introduced by an earlier fix, and two in Rehearsal's own checks; each is in the table under Evidence. The ones that change a decision are [0042](0042-keep-the-majority.md), keep the majority. The rest restore what a record already promised:
  - A lease the store renews as a holder's, that the holder doesn't hold, is given back: the store renews every lease it has as the holder's, so a failed release, a lease lost at its deadline while a renewal was on its way, or an acquire that timed out after it landed, was renewed for good and its shard never found another home. It's given back only a TTL after the holder let it go, as the store would have kept it had its renewals stopped, so a write its shard sent before then lands before the next owner recovers. An acquire waits for a release or give-back of the same lease to finish, since an acquire of a lease still held keeps its token, and refuses to take a lease again under the token of a release that never answered, which may still land and free it.
  - A connection without a hello after 5 s is closed and dialed again, as the TCP transport already closes one that doesn't prove the secret.
  - A leaving region checks whether it's done whenever a shard stops, and waits for its acquires to be answered, handing on a shard granted after the leave began.
  - A shard tries a remember write that failed again, with backoff, while its entity runs, so a failover starts it ([0030](0030-shards-are-placed-by-rendezvous-hashing.md)'s remembering).
  - A region never routes a message past messages waiting for its shard, and a message that comes back with `notOwner` goes in ahead of everything that never left the queue, so ordering per pair ([0026](0026-remoting-is-at-most-once-behind-a-transport.md)) holds through a stale holder cache.
- **Fencing stays off.** The journal doesn't check the lease token. Across the million seeds, `acknowledgedWritesKept` and `noStaleReads` never failed, so no stale write or read got past the sequence check ([0013](0013-sequence-check-is-the-single-writer-backstop.md)), and the check refused every second writer on its own, most often after a pause, the case fencing would add to. Fencing would tie the journal to sharding and to Postgres for a gap the hunt didn't find. This answers milestone 4's open question 2.
- **The planted bugs, hunted again on the fixed code.** Two rows bring new hunts of their own ([0040](0040-planted-bugs-are-found-by-what-they-break.md) lets a row bring its own), since the fixes hid them from the old ones. `late-deadline` hunts with downing pushed past the run, since a holder cut off from the others now downs itself and exits, ending its shards before a stretched deadline could overlap the next owner; and with a 250 ms margin. The bug stretches a holder's deadline by the renewal's round trip, which the store timeout ([0036](0036-timeouts-are-unknown-outcomes-settled-by-recovery.md)) now caps, so it overlaps the next owner only when the reply alone takes longer than the margin. Festival's margin equals its store timeout, and 200,000 seeds of the old hunt didn't find it; `joinCluster`'s defaults, a 3,000 ms timeout against a 2,000 ms margin, leave it room. `greets-once` hunts on kills, joins, leaves and resets, 30 a minute, since members now greet the seeds they lack ([0042](0042-keep-the-majority.md)) and festival's own mix took 36,233 seeds to lose a hello both ways.
- **`gossip-backwards` is tolerated, not found.** Keep the majority made membership heal a status that goes backwards: the resurrected member is unreachable, and is downed again within seconds, well before `recovers` checks. The row stays, marked tolerated, and its test shows both halves of that claim: statuses do go backwards with the bug planted, and no invariant breaks. A planted bug that the code has since learned to survive is a result too, and the spec's Definition of done now reads "found and shrunk, or shown harmless since a fix".

## Alternatives considered

| Option | Why not |
| --- | --- |
| Fence every append with the lease token | Nothing got past the sequence check in a million seeds. It would make the journal depend on sharding, and every backend check a lease |
| One fault mix, more seeds | Festival's mix almost never draws three partitions in a row, or a leave in a hang. The `network` mix found three of the bugs festival's own mix hadn't, and `heavy` one of Rehearsal's own |
| Mark the failures as expected and move on | All but two were real bugs, and the two that weren't were bugs in Rehearsal's checks |
| Fix in one pass at the end | A fix changes timing, which moves the failures, so each round found the next layer down |
| Add an invariant that membership statuses never go backwards, to keep finding `gossip-backwards` | It would check how membership works rather than anything a user sees, and be one more public invariant to keep at 1.0 |
| Swap `gossip-backwards` for a gossip bug that still does harm | The point of the row was this bug; that the cluster now survives it is worth recording as it is |

## Evidence

**T7 (2026-11-25),** Apple M5 Pro, darwin 25.4.0, Node v26.12.1, 17 worker processes ([raw data](data/0043-hunt-2026-11-25.json)).

The bugs, in the order the hunt found them. Each plan is in `test/demo/found.ts`, and broke its invariant before its fix:

| Bug | Found by | Seed | What went wrong | The fix |
| --- | --- | --- | --- | --- |
| Split brain | `recovers` | contract 18 | When a partition cut both ways, each side downed the other, and the halves never merged | Keep the majority ([0042](0042-keep-the-majority.md)) |
| A lone first seed | `recovers` | contract 80 | A node that downed itself restarted while the partition held and formed a cluster of its own, which nothing merged | Members greet the seeds they lack ([0042](0042-keep-the-majority.md)) |
| A lost hello | `recovers` | chaos 73 | A dial across a partition had its hello lost, and remoting waited on the connection for good | A 5 s wait for the hello |
| A lease renewed for good | `recovers` | contract 1,529 | A lease whose release failed was renewed with the holder's others, for good | Give back what the store renews and the holder doesn't hold |
| A leave cut short | `recovers` | contract 1,914 | A leaving node stopped heartbeating, and was downed halfway through its handoff | Heartbeat while leaving ([0042](0042-keep-the-majority.md)) |
| A leave that never ends | `recovers` | contract 1,914 | A shard that lost its lease in a hang stopped after the leave began, and its stop never told the region | Check when any shard stops; wait for acquires |
| A message overtaken | `orderPerPair` | contract 138 | A lookup for one shard named another's holder while that one's messages waited, and the next went straight there | Never route past waiting messages |
| An address never dialed | `recovers` | contract 1,970 | An address marked down for an incarnation never met was never dialed again | Membership's frames dial it anyway ([0042](0042-keep-the-majority.md)) |
| A newcomer counted twice | `recovers` | chaos 9,264 | A newcomer let in during a partition made both sides think they were the larger | No one new while a member is unreachable ([0042](0042-keep-the-majority.md)) |
| A lease given back twice | `oneLiveInstance` | contract 9,886 | The give-back raced the region's own acquire and freed the lease it had just taken, so another node ran the shard alongside it for 891 ms | An acquire waits for a give-back |
| A side of one | `recovers` | chaos 710, network mix | The crowd, knowing only node-1, won a tie on its address and downed node-1 for good | A side of one never keeps the cluster ([0042](0042-keep-the-majority.md)) |
| Two sides that downed each other | `recovers` | chaos 7,270, network mix | A partition while a join spread left the sides counting different members | Settle at the hello ([0042](0042-keep-the-majority.md)) |
| A join never finished | `recovers` | chaos 9,347, network mix | A node let in, whose welcome was lost, was downed while still joining, and ignored being told | A joiner told it's down gives up ([0042](0042-keep-the-majority.md)) |
| A bounced message overtaken | `orderPerPair` | contract 27,843 | A message bounced by a stale holder rejoined the queue behind a later one | Bounced messages go back in ahead |
| A reply dropped at a down address | `failoverWithin` | contract 70,628, in the million's first pass | A restarted node learned the crowd's old incarnation only as removed, marked the address down, and dropped its replies to the crowd's new one | A message for another incarnation than the downed one waits and dials ([0042](0042-keep-the-majority.md)) |
| Two clusters that never met | `recovers` | chaos 162,500, in the million's second pass | node-1 gave way to a cluster that had downed it, and rejoined node-2, which had downed that cluster too, but it had never heard of either new incarnation, so neither side counted the other | Two clusters meet whenever one has the other down and the other doesn't count it, and ties go to the earlier seed ([0042](0042-keep-the-majority.md)) |
| A lease given back too soon | `noStaleReads` | contract 37,436, nodes mix, in the million's third pass | The first give-back released a lease at once, while its show was still persisting a sale on a slow disk; another node recovered before the sale landed, and answered a read from before it | A lease is given back only a TTL after its holder let it go |
| A release that landed late | `oneLiveInstance` | contract 48,788, heavy mix, in the million's fourth pass | A node handed a shard off on a slow disk, its release timed out, and alone in a partition it took the shard straight back under the same token; the release landed after, freed the lease, and another node ran the show alongside it for 244 ms | An acquire refuses the token of a release that never answered |
| A leaving node that never stopped asking | `recovers` | contract 48,977, heavy mix, in the million's fourth pass | A leaving node stopped checking who it could hear, went on asking a node that had downed itself to take its last shard, and as the first seed, still leaving, let no one back in | A leaving node marks members unreachable, though it downs no one ([0042](0042-keep-the-majority.md)) |
| A show forgotten after an error | `failoverWithin` | chaos 120,717, in the million's fifth pass | A write recording a show as remembered failed on a database error and was only logged; after a kill its shard started elsewhere without it, and the one ask for it had gone to the dead node | A remember that fails is tried again while its entity runs |

And Rehearsal's own:

| Bug | Seed | What went wrong | The fix |
| --- | --- | --- | --- |
| Jumps judged one at a time | contract 1,002, heavy mix | Two jumps of the database's clock 86 ms apart, each inside the margin, outran it together, and the overlap was reported as a violation | Jumps within one TTL add up, with the most a node can drift over it |
| A kill in a settling cluster | chaos 28,596 | `failoverWithin` checked a kill 3 ms after a partition ended, while nodes it had made restart were still rejoining | A fault that ended within a bound before a kill counts as near it |

The million, on the fixed code:

Each row is `npm run rehearse -- --seeds <seeds> --mode <mode> --mix <mix> --determinism-every 1000 --json <file>`, on the commit that adds this record:

| Mix | Mode | Seeds | Runs | Faults | Violations | Overlaps past the margin | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `all` | contract | 1..300000 | 300,300 | 1,086,999 | 0 | 0 | 1,001 s |
| `all` | chaos | 1..300000 | 300,300 | 1,089,074 | 0 | 0 | 946 s |
| `nodes` | contract | 1..50000 | 50,050 | 179,749 | 0 | 0 | 176 s |
| `nodes` | chaos | 1..50000 | 50,050 | 179,749 | 0 | 0 | 178 s |
| `network` | contract | 1..50000 | 50,050 | 180,452 | 0 | 0 | 163 s |
| `network` | chaos | 1..50000 | 50,050 | 180,888 | 0 | 0 | 151 s |
| `clocks` | contract | 1..50000 | 50,050 | 182,308 | 0 | 0 | 168 s |
| `clocks` | chaos | 1..50000 | 50,050 | 182,308 | 0 | 0 | 158 s |
| `heavy` | contract | 1..50000 | 50,050 | 374,941 | 0 | 1 | 189 s |
| `heavy` | chaos | 1..50000 | 50,050 | 376,323 | 0 | 0 | 176 s |
| **Total** | | **1,000,000** | **1,001,000** | **4,012,791** | **0** | **1** | **55 min** |

The one overlap past the margin is expected, as [0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md) says: the heavy mix drew clock faults that together outran the lease's 1,000 ms margin, and `oneLiveInstance` reports such an overlap as expected rather than as a violation. The `nodes` and `clocks` mixes draw no network faults, so they drew the same plans in both modes.

- Fencing: the journal's sequence check refused 15,052 appends from a second writer, in 7,753 seeds, and 4,769 of those seeds paused a node. By mix, contract then chaos: `all` 3,835 and 3,255; `heavy` 2,337 and 2,149; `nodes` 1,187 in each; `clocks` 551 in each, none with a pause, since that mix draws none; `network` none. Every one was refused, and no stale read or lost write got past: `acknowledgedWritesKept` and `noStaleReads` never failed. The one stale read the hunt ever saw, contract seed 37,436 on the nodes mix, was the lease given back too soon above, and it was a bug in the give-back, not a gap in the sequence check.
- Determinism: every 1,000th seed, 1,000 in all, was run twice, and every pair of histories was identical.
- The planted bugs, hunted again on the fixed code ([raw data](data/0043-planted-2026-11-27.json), 2026-11-27): each was found within 10,000 seeds by the invariant its row names, and shrunk to three faults or fewer: `late-deadline` at seed 165 (`oneLiveInstance`, 19 faults shrunk to 3), `early-release` at 51 (`oneLiveInstance`, 4 to 1), `grants-held` at 3 (`oneLiveInstance`, 6 to none), `greets-once` at 2,244 (`recovers`, 12 to 3), `routes-unreachable` at 66 (`failoverWithin`, 3 to 1) and `early-reply` at 1 (`acknowledgedWritesKept`, 3 to 1). `gossip-backwards` was found in none of 10,000 seeds, and its test shows statuses still go backwards with it planted while no invariant breaks.
- Breaking each fix fails a test: the give-back fails two `leases.test.ts` tests and the lease-renewed-for-good plan; the acquire's wait fails the race test and the lease-given-back-twice plan; giving back at once fails the TTL-after test and the late-renewal test; taking a lease again under an unanswered release's token fails its test and the release-that-landed-late plan; not retrying a failed remember fails the remembering test and the show-forgotten plan; the hello timeout fails its remoting test and the lost-hello plan; the stop check fails the lost-shard leave test; the hand-on fails its test and the two leave plans; routing past waiting messages fails the message-overtaken plan; bounced messages at the back fail theirs; jumps one at a time fail the margin test; and only overlapping faults counting as near fails the settling test. [0042](0042-keep-the-majority.md) lists its own.

## Consequences

- CI's Rehearsal job fails on every invariant now: `--ignore` is gone.
- Festival night is a regression suite of twenty plans, and each new bug the site's `/rehearsal/` page shows (T8) comes from this table.
- The journal stays a plain journal, with no knowledge of leases. If a later backend can't promise the sequence check, fencing is the fallback, and this record is where to start.
- The hunt is repeatable from its commands: a fresh range of seeds is the way to look further, as there's no nightly run.
