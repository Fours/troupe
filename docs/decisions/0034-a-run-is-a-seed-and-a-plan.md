# 0034. A run is a seed and a fault plan, the plan is data, and each concern draws from its own stream

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

Rehearsal runs thousands of seeded simulations of a cluster, and a failing one has to be printed, replayed exactly and shrunk to the smallest run that still fails. That needs a run to be a pure function of something small and editable. A seed alone is small but can't be edited: change one fault and every draw after it shifts. Drawing faults on the fly from the cluster's own random would tie them to what the cluster happened to do, so taking one out would change the next. And a workload driven by what the cluster answers would change whenever a fault did, so shrinking couldn't tell a fault that mattered from one that only moved the workload.

## Decision

- **A scenario is a value,** made by `scenario(opts)` in `/rehearsal`: nodes (hosts, spares that start only when a plan joins them, and clients that route and run the workload), a `setup` each node incarnation runs, a `workload`, which faults to draw, and which invariants to check. Its options are checked when it's made. An invariant that rests on the `Transport` contract can't be checked in chaos mode, and saying so throws there ([0035](0035-safety-under-any-network-ordering-under-the-contract.md)).
- **A run is a seed and a plan.** `scenario.run({ seed, plan })` builds a fresh world: a simulation clock, a `NodeClock` per incarnation, the simulated network and database, and the run loop ([0033](0033-one-simulation-clock-and-a-clock-per-node.md)). It carries out the plan, drives the workload, records the history and checks the invariants. Without a plan, the seed draws one. A plan given to `run` is checked first, and a bad one throws before anything starts.
- **A plan is plain JSON:** a list of faults in order of simulation time, each with `at` and a key that names its kind, such as `{ "at": 30500, "kill": "node-1", "restartAfterMs": 2000 }`. The kinds are `kill`, `pause`, `leave`, `join`, `partition`, `reset`, `delay`, `reorder`, `lose`, `duplicate`, `disk` (`slow`, `hang`, `error`, `lostReplies`), `cut`, `jump` and `drift`. Each maps onto a fault of the simulated network, the simulated database or a node's clock, or onto a node's process. A checked plan is copied with its keys in one order, so it prints the same however it was written.
- **Every fault ends,** by the time the quiet tail begins (`quietMs`, default a third of the run, at most 20 s). A kill ends in a restart, a leave in a rejoin, a pause in a resume, and a spell or partition when it heals. A join ends at once and the node stays.
- **Drawing.** `faults: { nodes, clocks, network, disks }` turns on groups of kinds, `only` names kinds instead, and the plan stream draws starts about `perMinute` a minute (default 6), at most `concurrent` at once (default 2), each lasting a draw from `lastingMs` (default 1 to 8 s), cut short at the quiet tail. A node fault never lands on a node already under one, and always leaves a host free of one. Clients are never killed, paused or drifted, only partitioned, so the workload's draws never depend on whether its node is up.
- **One seed, separate streams.** Each stream is `seededRandom` of the FNV-1a hash of its name and the seed: `plan`, `workload <client>`, `node <name> <n>` and `clock <name> <n>` for incarnation `n` of a node, `network` and `database`. An incarnation's streams are keyed by its node's name and its own count, so a kill of one node shifts nothing on another.
- **The workload runs on simulation time,** not on a node's clock and not on replies: each client's `workload` is called every draw of `everyMs` (default 50 to 250 ms) from its own stream, and starts operations with `op(name, entity, run)`. What an operation sends through the ref it's given, and how it ends, go into the history, but nothing the cluster does feeds back into what the workload draws.
- **A process manager restarts nodes.** A node whose process ends on its own, because it was downed or never got in, exits and starts again as a new incarnation after `restartAfterMs` (default 2,000), as a supervisor or Compose would restart it. What's left of an ended process in this one is paused for good and unwatched by the run loop, so none of its tasks or timers run again.
- **A failure shrinks to the smallest plan that still fails the same invariant** (settled in T6). Every attempt is a whole run from the same seed with an edited plan, so each is deterministic, and the streams keep the workload and every node's draws the same whatever is taken out. In three steps, keeping only edits that still fail:
  1. Remove faults in chunks that halve down to one: half the plan, then quarters, and so on, then one at a time until none can go. That's the spec's "one at a time and in halves" in the cheaper order, since a long plan usually loses most of its faults in the first few runs.
  2. Halve each remaining fault's length, then move its start later by half of what's left before the quiet tail, for as long as it still fails. A moved fault re-sorts the plan, so each is found again by identity.
  3. Cut the run to 1 ms past the violation, or past its end for one that lasted. `recovers` and `failoverWithin` don't judge a window that a cut run ends before, so a cut can't fail them on its own.

  At most `maxShrinkRuns` attempts (default 500). A stall is a violation called `stall`, so a stalled run fails, shrinks and replays like any other.
- **A run can end early,** with `run({ seed, plan, untilMs })`: everything up to then happens as in the whole run, and the history's run entry records `untilMs`.
- **One line replays a run:** `Run.replay`, base64url JSON of the seed, the network mode, the plan, `untilMs` when the run was cut, and the first violation's invariant and message, seed first. It's written with no runtime global, escaped to ASCII, so it reads the same everywhere ([0004](0004-runtime-agnostic-core.md)). `scenario.run({ replay })` runs it, and throws for a line from another mode. `replay(scenario, line)` runs it and checks that it finds that violation again, or that it passes if the line recorded none. A line that doesn't reproduce says so, and why that matters: a run is a pure function of its seed and plan, so something in it isn't deterministic.
- **`rehearse(scenario, { seeds: { from, count } })`** runs seeds one after another in this process, shrinks each that fails, and reports the failures with their lines, how many seeds each invariant failed, the `expected` overlaps, and the seeds whose two runs differed when `determinismEvery` asks for a second run. `ignore` names invariants to count but not fail on, `maxFailures` stops early, and `onSeed` sees each seed's result. `npm run rehearse` splits a range across worker processes, with the same pieces, as a script.
- **The history is JSON.** Every entry has its simulation `time`: the run, each incarnation's start and stop, every system event (refs as `ref <address>#<uid><path>`, errors as `{ error, message }`, and message events only for entities), each fault's begin and end, each operation's invocation, sends and completion (`ok`, `failed`, or `unknown` for a timeout), journal appends and lease calls with what became of their replies, and the journal as the run ended.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A run is its seed alone | Can't be edited, so it can't be shrunk: removing one fault shifts every draw after it |
| Faults drawn during the run, from the cluster's random | Ties the plan to what the cluster did, so taking one fault out changes the ones after it, and a plan can't be printed before the run |
| One stream for everything | Any change anywhere shifts every later draw, so shrinking compares runs that differ everywhere |
| A workload that reacts to replies, such as buying again after a refusal | Then a fault changes the workload, and shrinking can't tell which mattered. A scenario can still react inside one operation, whose sends and outcome are recorded |
| A plan as calls in TypeScript | Can't be printed, edited, stored with a failure or replayed from a line |
| Killed nodes stay dead unless the plan restarts them | A downed node stays out for good, so `recovers` could never pass after a partition that downs one |
| Remove faults one at a time first, then in halves, as the spec first had it | A plan of 20 faults takes 20 runs before anything bigger is tried. Halving first usually takes most of them out in a few runs, and ends one at a time anyway |
| A replay line of the seed alone, or of the seed and the whole history | A shrunk plan isn't the one the seed draws, so the seed alone can't replay it, and a history is tens of thousands of entries. The seed and the plan are enough, since the rest follows from them |
| Replay that only runs the line | Can't tell a run that reproduced from one that didn't, which is the one thing a replay that diverges needs to say |
| Record every message event | The festival's histories would be several times larger, for heartbeats and region traffic no checker reads, and byte-for-byte comparison would cost more than the run |

## Evidence

**T5 (2026-11-24):**

- `test/rehearsal/plan.test.ts`:
  - A seed draws the same plan every time, and from a scenario made again, and another seed draws another plan.
  - Over 300 seeds in each mode at 30 faults a minute, every fault ends by the quiet tail, faults are in order, no more than two are under way at once, and a spare joins at most once. Node faults never land on the crowd, and contract mode draws no chaos-only fault. All 17 kinds turned up. `only` draws just the kinds it names, and with no faults asked for, a plan is empty.
  - 23 kinds of bad plan throw before the run starts, each with a message that names the fault and what's wrong with it. Unknown and misplaced nodes, missing and unknown keys, faults out of order, one that runs into the quiet tail, and a chaos fault in contract mode are among them. So do 16 kinds of bad scenario option.
  - **Removal.** Seed 3 of a three-node scenario draws a plan of several faults. Taking out each fault in turn, the workload's operations stay identical for the whole run, with the same names, entities and times, and every history entry before that fault's time is the same. What comes after it does change.
- `test/rehearsal/history.test.ts`:
  - A history is JSON, in order of simulation time. It starts with the run, ends with the journal, and holds every kind of entry.
  - A crowd's `replyTo` reads the same in the message it sent and in the one its entity got.
  - Over three seeds in each mode, two runs of a seed, and a run of its drawn plan given explicitly, give byte-identical histories.
  - A kill and a pause show up as begin, stop, start and end at their times. A downed node exits and is back as a new incarnation `restartAfterMs` later.
- `test/rehearsal/invariant.test.ts`:
  - Milestone 4's invariant scenario moved onto Rehearsal: three nodes, a spare and a crowd, with kills, partitions, cuts, leaves and joins, one at a time, on a clock per node and the simulated database. It passes 1,000 seeds in about 10 s in `npm test`. Over them it drew 1,026 kills, 991 partitions, 1,042 cuts, 1,024 leaves and 667 joins, with 6,258 handoffs, 72,792 entity incarnations and 134,416 acknowledged deposits.
  - With a store that grants held leases, it finds an overlap at seed 12, as the old test did. The old `test/cluster/invariant.test.ts` is gone.
- Breaking each of these fails a test:
  - not cutting a fault's length short at the quiet tail fails the plan tests
  - skipping the check that a given plan ends before the tail fails the bad-plan test
  - drawing the workload from the network's stream fails the removal test
  - not restarting a node that exits, or not exiting a downed one, fails the restart test

**T6 (2026-11-24):**

- `test/rehearsal/rehearse.test.ts`:
  - **Shrinking.** For a failure that needs two of six faults at any length, shrinking keeps just those two, each 1 ms long and as late as the quiet tail lets it, in order, and cuts the run 1 ms past the violation, in under 100 runs. It keeps every fault when each is needed, and stops at `maxShrinkRuns` with a plan that still fails. On festival night with `early-release` planted, seed 28's plan of 3 faults shrinks to 1, and its line replays it.
  - **The line** round-trips a seed, a mode, a plan, an end, a plant and a violation with non-ASCII text in it, starts with the seed, and 12 kinds of bad line throw with a message that says what's wrong.
  - **Replay.** A run cut short ends where it was cut, replays byte for byte from `scenario.run({ replay })`, and `replay` says it reproduced. A line whose violation the run doesn't find, a failing run's line replayed where the run passes, and a passing run's line replayed where an invariant fails each say they didn't reproduce, and why that matters. A line from another mode or with a bug planted throws before anything starts, as do a bad end and a bad plan in a line.
  - **rehearse** reports each seed in order, shrinks each failure within `maxShrinkRuns`, counts ignored invariants without failing on them, stops at `maxFailures`, finds a seed whose two runs differ when the workload reads state outside the run, and fails, shrinks and replays a stall. 10 kinds of bad option throw.
- `test/rehearsal/plants.test.ts` and [0040](0040-planted-bugs-are-found-by-what-they-break.md): each of the seven planted bugs found within 10,000 seeds and shrunk to at most three faults, each line still reproducing.
- `test/multiprocess/rehearse.test.ts`, against `dist/`: `npm run rehearse` over 40 seeds on 2 workers prints its summary, with 4 seeds run twice and every history identical. It replays each planted bug's line, says so and exits 1 for a line that doesn't reproduce, and rejects 7 kinds of bad argument.
- **Runs per second** of `npm run rehearse -- --seeds 1..10000` on all cores but one, Apple M5 Pro, 17 workers, shrinking every failure ([Node 22](data/0034-rehearse-node22-2026-11-24.json), [24](data/0034-rehearse-node24-2026-11-24.json), [26](data/0034-rehearse-node26-2026-11-24.json)). The three found the same 732 failing seeds and took the same 37,446 runs, shrinking included, so a run is the same function of its seed and plan on every Node line:

  | Node | Wall time, s | Runs a second |
  | --- | --- | --- |
  | 22.23.5 | 147.8 | 253 |
  | 24.22.3 | 158.6 | 236 |
  | 26.12.1 | 138.2 | 271 |

- **CI** runs seeds 1 to 1,000 in each mode on every push, every hundredth run twice and compared, on the runner's cores. Locally on 3 workers that takes 21 s for both modes.
- Breaking each of these fails a test:
  - never removing a fault, and never cutting the run, fail the shrinking tests
  - `replay` always saying it reproduced fails the replay test
  - never comparing the two runs of a seed fails the determinism test
  - ignoring `untilMs` fails the replay test
  - letting `recovers` or `failoverWithin` judge a window a cut run ended before fails the invariant test for cut runs

## Consequences

- A failure is a seed and a list of faults, which prints, edits and replays. Shrinking is a series of runs with edited plans, each deterministic.
- Scenarios mustn't read `Date.now`, `Math.random` or real timers, or let a workload depend on what the cluster answers beyond one operation. Rehearsal can't stop them, and a run that doesn't replay says it may have.
- The workload is the same whatever the faults, which is what makes removal meaningful. It's also why a run under heavy faults keeps asking a cluster that can't answer: timed-out operations are part of the history, not a sign the workload went wrong.
- A node exiting when it's downed is part of the scenario's world, not Troupe's: a real deployment needs its own process manager to do the same.
- Message events are kept only for entities, so an invariant over other actors' messages needs the history to grow.
