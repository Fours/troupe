# 0034. A run is a seed and a fault plan, the plan is data, and each concern draws from its own stream

- **Status:** Proposed
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

T6 proves the rest: that a failing run shrinks to a smaller plan from the same seed, and replays from its line. The record is accepted then.

## Consequences

- A failure is a seed and a list of faults, which prints, edits and replays. Shrinking is a series of runs with edited plans, each deterministic.
- Scenarios mustn't read `Date.now`, `Math.random` or real timers, or let a workload depend on what the cluster answers beyond one operation. Rehearsal can't stop them, and a run that doesn't replay says it may have.
- The workload is the same whatever the faults, which is what makes removal meaningful. It's also why a run under heavy faults keeps asking a cluster that can't answer: timed-out operations are part of the history, not a sign the workload went wrong.
- A node exiting when it's downed is part of the scenario's world, not Troupe's: a real deployment needs its own process manager to do the same.
- Message events are kept only for entities, so an invariant over other actors' messages needs the history to grow.
