# 0040. A planted bug is found by what it breaks, and failover means answering again

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

Milestone 5 plants bugs back in the code, one at a time, to prove each invariant catches what it's there for ([milestone 5](../milestone-5.md), "Planted bugs"). Festival night doesn't pass every invariant yet, though. Over 10,000 seeds with no bug planted, `recovers` fails about 7% of them and `orderPerPair` 0.04%, which is T7's hunt. A bug whose row names `recovers` would be "found" on the first seed that was failing already, which proves nothing. Two rows also didn't show up at all on festival's own fault mix and timings. And `failoverWithin`, as [0035](0035-safety-under-any-network-ordering-under-the-contract.md) wrote it, asks only that a killed node's entities *run* again elsewhere, where the spec asks that they *answer* again.

## Decision

- **A planted bug is found by what it breaks.** A seed counts only if its run with the bug breaks an invariant on the bug's row, and the same seed, plan and end without the bug doesn't break that invariant. Shrinking keeps an edit only under the same rule, so a hunt never shrinks towards a failure the code had already. Both scenarios are built from the same options, and the baseline runs only for seeds the planted run fails.
- **Each bug is planted through one internal name,** set on a node's system by the scenario's internals and read by the line it changes: the lease keeper, the region, gossip's merge and the persistent actor. The store that grants held leases is a wrapper on each node's shard store. Nothing public can set one, and the replay line of a planted run names its bug, so it won't run on a scenario without it.
- **A row can bring its own hunt,** in place of the scenario's, when only a rare mix of faults or other timings shows the bug. The change is recorded with the row. Two rows use this:
  - `late-deadline` draws slow disks, cuts and partitions, 30 a minute, up to three at once. The bug stretches a holder's deadline by however long the renewal's reply took. That only costs anything if the holder also can't renew and can't be reached, so another node takes the lease while the holder still thinks it has it. On festival's own mix, that didn't happen in 10,000 seeds. A pause doesn't show it either: when a paused node wakes, the deadline timer that fell due fires before the renewal's late reply is handled, as Node runs due timers before I/O.
  - `routes-unreachable` uses `joinCluster`'s own membership timings, which down a node about 15 s after it goes quiet. Festival downs one in 4.5 s, sooner than its leases fail over, so a region that routes to a holder it can't reach costs nothing there. That's the case [0031](0031-failover-waits-for-the-lease-not-for-downing.md) was written for.
- **`failoverWithin` checks that entities answer,** superseding that line of 0035. After a kill with no other fault near it, each entity that was on the dead node and is asked for must run on another incarnation within the bound, as before. Now operations begun on it once it's back, within the bound, must also include one that answers. An entity that runs again where nobody's asks can reach it hasn't failed over.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Count any seed that breaks the row's invariant | `recovers` already fails about 7% of festival's seeds, so two rows would be "found" by the first seed that was failing anyway |
| A list of the seeds known to fail, excluded from hunts | Any change to timing reshuffles which seeds fail, so the list would churn on every commit. Running the same seed and plan without the bug answers the question directly |
| Fix T7's failures before planting bugs | The planted bugs prove the checkers T7 relies on. Hunting with checkers nobody has seen fail would be the wrong order |
| Leave `failoverWithin` checking only that entities run | `routes-unreachable` can't be caught that way: with `remember`, a new owner starts the entities unasked, and every ask still goes to the dead holder |
| A new invariant that checks answers, beside `failoverWithin` | Two invariants for one claim. The spec's table already says "answer again", so it's the old check that was short of the claim |
| Raise every row's fault mix | Festival's own mix finds five of the seven, which is the stronger result. Only rows that need it get their own |

## Evidence

**T6 (2026-11-24),** Apple M5 Pro, darwin 25.4.0, Node 26.12.1, 17 worker processes: `npm run rehearse -- --seeds 1..10000 --plant <bug>` for each row ([raw data](data/0040-planted-2026-11-24.json)). Every bug was found within 10,000 seeds, by an invariant on its row, and shrunk to three faults or fewer:

| Bug | Found at seed | By | Faults, then shrunk | Shrink runs | Its hunt |
| --- | --- | --- | --- | --- | --- |
| The holder notes its deadline after the renewal returns | 9,105 | `oneLiveInstance` | 17, then 2: a slow disk on one node and a partition | 144 | Slow disks, cuts and partitions, 30 a minute |
| A handoff releases the lease before its entities stop | 28 | `oneLiveInstance` | 3, then 1: database errors | 61 | Festival's |
| The store grants a lease that's still held | 1 | `oneLiveInstance` | 3, then 0 | 8 | Festival's |
| A region greets each member only once | 1,626 | `recovers` | 6, then 3 | 140 | Festival's |
| A region routes to a holder it can't reach | 66 | `failoverWithin` | 3, then 1: a kill | 34 | `joinCluster`'s default downing |
| Gossip merge lets a status go backwards | 310 | `recovers` | 3, then 3 | 166 | Festival's |
| A persistent actor replies before its append settles | 1 | `acknowledgedWritesKept` | 3, then 1: database errors | 35 | Festival's |

- `test/rehearsal/plants.test.ts` replays each row's line and checks it reproduces, by an invariant on its row, with five faults or fewer. It runs the same seed and plan without the bug and checks that invariant passes, and it checks the line won't run on a scenario without the bug. `rehearse` in-process finds `early-release` at the same seed as the script and shrinks it to the same line.
- Taking each plant out fails its row's test. So does ignoring the baseline, which `test/rehearsal/rehearse.test.ts` checks with a baseline that has the same bug.
- **`failoverWithin`:** `test/rehearsal/invariants.test.ts` fails when a killed node's ledgers start again on a new owner but the crowd's asks still go to the dead holder, and passes with the region routing around it. Checking only that they run fails that test. On festival night with no bug, over 10,000 seeds in each mode, the stricter check fails 23 seeds in contract mode and 23 in chaos mode, where the old one failed none. In each, a show runs again after a kill, often on the restarted incarnation of the same node, and none of the asks begun on it in the next few seconds answers. That's real behaviour, and T7's hunt.

## Consequences

- Each planted bug is a regression test: its line has to keep reproducing, so a change that hides a bug from its invariant fails `npm test`. A change to what runs draw, or when, changes the seeds and the lines, and they're recorded again from the hunt, never edited by hand.
- A hunt runs up to twice as many runs as a plain range, though the baseline only runs where the planted run fails.
- Until T7 fixes the 23-in-10,000, CI counts `failoverWithin` failures without failing on them, as it does for `recovers` and `orderPerPair`.
- The two rows with their own hunts say something about festival as well as the bugs: its downing is quick enough to hide a routing bug, and a deadline bug needs three faults at once to show.
