# 0033. A run has one simulation clock, each node a clock of its own on it, and every I/O call resolves on it

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

Until now every node in a test cluster has shared one `ManualScheduler`, so every node reads the same time. That can't test what [0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md) depends on: that a holder's clock and the store's run at about the same rate, and that a node whose process stops past its deadline is caught by the journal's sequence check ([0013](0013-sequence-check-is-the-single-writer-backstop.md)). [0003](0003-injected-scheduler-and-random.md) also left a gap: an async `receive` awaits real promises, so the testkit's `settle` waits real event-loop turns while actors are busy, and a journal call takes no virtual time at all. Rehearsal has to close both, and it has to run in the browser as well as in Node ([0004](0004-runtime-agnostic-core.md)).

## Decision

- **Simulation time** is one `ManualScheduler`'s time. Nothing in the cluster reads it. The history (T5) stamps every entry with it, so entries from different nodes compare.
- **Each node gets a `NodeClock`,** a `Scheduler` that views simulation time at its own rate, `1 + driftPpm / 1,000,000`, fixed for each incarnation. Its `now()` is whole milliseconds and never goes back. A timer fires at the first whole millisecond of simulation time when the node's own clock reaches it.
- **A node clock keeps no queue of its own.** Every task and timer goes onto the simulation's heap, converted to simulation time, so one heap orders everything every node does, by due time and then creation. That's what makes a run repeat exactly.
- **A pause** stops the node's process: what falls due while it's paused waits in a backlog, and its clock keeps going. On resume, the backlog runs in the order it fell due, before anything newer. Every transport callback a node gets goes through its clock (`throughClock`), so a paused node's frames wait at its sockets, and frames that come before it has accepted a connection are kept, as a socket buffers them.
- **Every I/O call resolves on simulation time,** its request and its reply each a timer, and the reply reaches the caller through its node's clock. T3's simulated database does this, so a slow disk takes simulation time, a hung one answers only once it lets go, and a paused caller gets its answer only when it wakes.
- **The run loop** runs everything that's ready, yields one macrotask so the promise continuations that work started can finish, and repeats until a round starts nothing new. Then it moves simulation time to the next timer. It never waits for a busy actor: one awaiting a simulated call is waiting on a timer, and time will reach it.
- **A stall is an error,** `StallError`, naming the busy actors by node and path. A run stalls when an actor is busy and no timer is set, so nothing could ever finish it. It also stalls when an actor stays busy on one message for `stallAfterMs` of its own clock (default 30,000). In a cluster, heartbeats mean a timer is always set, so the first rule alone would never fire there.
- **The yield is a `MessageChannel`,** one channel per loop call, closed when the call ends, since an open port keeps a Node process alive. Every runtime 0004 lists has it, so it's declared in `src/globals.d.ts`, with only the members the loop uses.
- The testkit's `settle` and `advance` don't change. Rehearsal's loop is its own.

## Alternatives considered

| Option | Why not |
| --- | --- |
| One shared clock for every node, as the test cluster has | Can't drift or pause one node, which is what 0029's safety argument is about. |
| A timer queue per node, with the loop picking the earliest across nodes | Two heaps to keep in step, and ties between nodes would need their own rule. One heap orders them already. |
| Fractional simulation time, so drift below a millisecond isn't lost | Simulation time would stop being whole milliseconds. Drift that small is inside the lease margin anyway (see Consequences). |
| Yield on `setTimeout(0)` | At least 1.1 ms a yield in Node and 4.5 ms in Chromium. A run takes tens of thousands of yields. |
| Yield on `setImmediate`, as the test cluster does | Node-only (0004), and 35 times slower than a channel in Node. |
| A new `MessageChannel` for every yield | Eight times slower than one shared channel. |
| Stall only when no timer is set | Never fires in a cluster, whose heartbeats always have a timer set. |

## Evidence

**T1 (2026-11-24):**

The macrotask probe, `scripts/probe-macrotask.ts`, on an Apple M5 Pro. It reports the median of five chains of yields, after a warm-up. Raw data: [0033-macrotask-2026-11-24.json](data/0033-macrotask-2026-11-24.json).

| Runtime | `setTimeout(0)` (µs a yield) | `setImmediate` (µs) | One shared `MessageChannel` (µs) | A `MessageChannel` per yield (µs) |
| --- | --- | --- | --- | --- |
| Node 22.23.5 | 1,144 | 13.4 | 0.39 | 3.4 |
| Node 24.22.3 | 1,144 | 13.3 | 0.38 | 3.2 |
| Node 26.12.1 | 1,139 | 13.4 | 0.35 | 3.0 |
| Chromium 159 | 4,505 | none | 1.24 | 5.0 |

- Every way of yielding let a 1,000-deep chain of microtasks finish first, in every runtime, which is what the loop relies on. `test/rehearsal/loop.test.ts` pins it with a 10,000-deep chain.
- On Node 22, 24 and 26, a process whose `MessageChannel` is closed exits by itself.

The in-process invariant scenario from milestone 4, over 1,000 seeds, on one shared clock with the test cluster's `setImmediate` settle, against a clock per node (±200 ppm) on the run loop. Raw data: [0033-run-loop-2026-11-24.json](data/0033-run-loop-2026-11-24.json).

| Node | One shared clock (ms a seed) | A clock per node, on the loop (ms a seed) |
| --- | --- | --- |
| 22.23.5 | 10.5 | 7.6 |
| 24.22.3 | 10.5 | 7.2 |
| 26.12.1 | 9.4 | 6.5 |

The tests:

- `test/rehearsal/clock.test.ts`:
  - A node's timers fire at its own rate (991 and 1,011 ms for a 1,000 ms timer at ±10,000 ppm).
  - A property test over 200 random clocks: `now()` is always a whole number, never goes back, and matches a reference model, and a timer fires at the first millisecond its clock reaches.
  - A paused node runs nothing while the others carry on, then runs its backlog in the order it fell due, and skips a timer cancelled meanwhile.
  - A paused node gets its connection, frames and close only once it wakes, in order, with none lost.
- `test/rehearsal/loop.test.ts`:
  - An actor awaiting 100 chained calls of 1,000 ms each finishes at 100,000 ms of simulation time, in well under a second of real time.
  - An actor awaiting a promise outside the simulation stalls the run, with `node-1 /user/stuck` in the error. It does so both when nothing else is set, and past `stallAfterMs` while a heartbeat keeps firing.
- `test/rehearsal/cluster.test.ts`: three nodes on the in-memory network converge and shard the same way on one shared clock, on clocks 200 ppm apart and on clocks 20,000 ppm apart. Two runs of one seed give identical events, message events included, at identical simulation times.
- `test/cluster/invariant.test.ts` runs the milestone 4 invariant on a clock per node too, over 200 seeds in `npm test`.

Breaking each behaviour fails a test: ignoring the rate, running timers while paused, yielding a microtask instead of a macrotask, turning off the stall check, and handing frames to a node without its clock.

**T3 (2026-11-24):**

`simulatedDatabase` serves a journal, snapshot store, offset store and shard store on one endpoint, on the in-memory backends. Each call's request and reply is a timer of simulation time, and the reply reaches the caller through its node's clock.

- `test/rehearsal/database.test.ts`:
  - With no faults, the journal's contract suite and the shard stores' contract suite pass on it, driven by the run loop.
  - An append made at 0, with 5 ms each way, is applied at 5 and answered at 10. Latencies are drawn from the database's own stream, so calls overtake each other, and one seed repeats them exactly.
  - A paused caller's append is applied while it's paused, and its reply waits until it resumes, at 1,000 ms, while another node's call is answered at 10.
  - A hang holds calls unapplied and unanswered, for good if it never ends. A lost reply leaves the events in the journal, the caller never hears, and its retry at the same sequence number conflicts.
- `test/cluster/invariant.test.ts` runs the milestone 4 invariant on the simulated database too, with a clock per node, over 200 seeds in `npm test`. It holds, and two runs of one seed tell the same story. Over 1,000 seeds it costs about a millisecond a seed more than on instant stores. Raw data: [0033-database-2026-11-24.json](data/0033-database-2026-11-24.json).

| Node | One shared clock (ms a seed) | A clock per node (ms a seed) | A clock per node, on the database (ms a seed) |
| --- | --- | --- | --- |
| 22.23.5 | 10.8 | 7.7 | 8.6 |
| 24.22.3 | 10.0 | 7.1 | 8.1 |
| 26.12.1 | 9.3 | 6.3 | 7.2 |

Breaking each behaviour fails a test: handing replies to the caller without its clock, applying calls during a hang, answering a lost reply, ignoring a cut, leaving jumps out of the lease clock, giving replies no latency, and closing a client without failing its waiting calls.

## Consequences

- A node can now be slower or faster than the store, or stop for a while, which is what T5's fault plans need.
- Simulation time stays whole milliseconds, so drift below a millisecond per timer is lost. On a clock 200 ppm fast, chained 1 s timers fire on the same milliseconds as on a perfect one, and on a clock 200 ppm slow, each fires up to a millisecond late, as real timers do. `now()` shows the drift exactly. Drift that small is far inside 0029's margin, and drift large enough to matter (thousands of ppm) is modelled to within a millisecond a timer.
- The run loop is faster than the test cluster's `settle`, so Rehearsal can afford more seeds.
- An actor that stays busy on one message for longer than `stallAfterMs` fails the run, even if it would have finished. A scenario with a legitimately long turn raises the limit.
- Scenario code mustn't wait on anything outside the simulation. A stall names the actor that did.
