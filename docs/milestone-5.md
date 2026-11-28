# Milestone 5: Rehearsal: deterministic simulation testing

Source: [roadmap](roadmap.md), Milestones → 5. Carries milestone 2's open question 2 (journal timeouts), milestone 3's deferred "replaying a run from its seed", milestone 4's open question 2 (fencing the journal with the lease token) and T7's note on handoffs that never finish, and the notes in [0003](decisions/0003-injected-scheduler-and-random.md), [0029](decisions/0029-a-shard-is-owned-by-whoever-holds-its-lease.md) and [0030](decisions/0030-shards-are-placed-by-rendezvous-hashing.md) that point here. [0032](decisions/0032-1-0-comes-after-rehearsal.md) asks this spec to list the public API changes before the work starts: see "Public API changes". Open questions answered in spec review on 2026-11-24.

## Outcome

One command runs thousands of seeded simulations of a whole cluster in one process: nodes, network, journal, shard store and clocks. Each run injects faults from a plan drawn from its seed: kills, restarts, pauses, partitions, lost and delayed frames, slow and hanging disks, and clocks that drift. After each run, invariants are checked against its history: at most one live instance per entity, no acknowledged write lost, no stale read, and a cluster that recovers once the faults heal. A run that breaks one is shrunk to the smallest plan that still breaks it, and replays exactly from one printed line.

Rehearsal is public, as `@kylewillett/troupe/rehearsal`, so you can rehearse your own entity types, not only Troupe's.

**Demo at the end:**

```bash
npm run rehearse -- --seeds 1..10000
```

runs festival night's shows on three nodes and a crowd, 10,000 times, under faults, and prints a line per thousand seeds and a summary. Then a planted bug, such as a holder that notes its lease deadline after the renewal returns instead of before it's sent:

```bash
npm run rehearse -- --seeds 1..10000 --plant late-deadline
```

finds a violation, shrinks it, and prints the replay line:

```
✗ seed 4217: one live instance: show/hamlet ran on node-1 and node-3 from 31,204 to 31,388
  shrunk from 23 faults to 2 in 41 runs: [{"at":28000,"disk":"slow","ms":2500},{"at":30500,"kill":"node-1"}]
  replay: npm run rehearse -- --replay 'eyJzZWVkIjo0MjE3LC...'
```

Then open `troupe.kylewillett.com/rehearsal/`, run seeds in the browser, and scrub through a recorded failing run: one lane per node, faults drawn across them, each entity's instances as bars, and the moment two overlap marked.

## Scope

In scope:

- **One simulated clock, and a clock per node derived from it,** with drift and pauses. Every timer and every I/O call resolves on it, so virtual time is closed: nothing a run does waits on real time
- **A simulated network** that implements `Transport`, with partitions (both ways and one way), connection resets, delay, and reordering across connections. A second mode breaks the transport's contract too: single lost frames, reordering within a connection, and duplicates
- **A simulated database:** a journal, snapshot store, offset store and shard store on one endpoint, with latency, slow spells, hangs, errors, replies lost after a commit, a node cut off from it, and its wall clock jumping. It passes the journal's and the shard stores' contract suites
- **Timeouts** on every journal and shard store call the framework makes, on the scheduler. A timeout is an unknown outcome, settled by recovery
- **Fault plans:** data drawn from a seed, so a plan can be printed, edited and shrunk
- **A history recorder** and **invariant checkers**, built in and your own
- **`rehearse()`:** many seeds, shrinking, and a replay line. `npm run rehearse` runs it across worker processes
- **Planted bugs:** the bugs milestone 4 found by hand, and others, put back one at a time to prove each checker catches what it's for
- **The hunt:** running at scale, fixing what Rehearsal finds, a record for each fix, and a regression seed for each
- **CI:** a fixed range of seeds on every push
- **The demo site** gains a fourth page, `/rehearsal/`, and the write-up a section on Rehearsal and the bugs it found
- **Release 1.0.0**, after an API review, as [0032](decisions/0032-1-0-comes-after-rehearsal.md) planned

Out of scope:

| Item | Where |
| --- | --- |
| Testing TCP and Postgres themselves | Not Rehearsal's job. The multi-process test, the contract suites and the Docker smoke test keep doing it. Rehearsal's fidelity rests on its simulated pieces passing the same suites |
| Shrinking the workload as well as the faults | Stretch, below |
| Checking a full linearizability model of each entity (Knossos-style) | Stretch. The stale-read checker covers the case that matters here |
| Understudy, phi-accrual | Still milestone 4's stretch goals. Rehearsal can measure them if they're built later. The split-brain strategy, keep the majority, came in with T7, since the hunt showed `recovers` can't pass without one ([0042](decisions/0042-keep-the-majority.md)) |
| Removing the Postgres journal lock ([0016](decisions/0016-postgres-appends-take-a-journal-lock.md)) | Later |
| Simulating actors that do their own real I/O, such as a `fetch` in `receive` | Not planned. Rehearsal says which actor stalled the run |
| A browser-to-server transport, worker-thread dispatcher, OpenTelemetry | Roadmap, later ideas |

## Design

### The shape of a rehearsal

```ts
import { rehearse, scenario, invariants } from '@kylewillett/troupe/rehearsal';

const festival = scenario({
  nodes: ['node-1', 'node-2', 'node-3'],
  clients: ['crowd'], // nodes that route but host no shard
  durationMs: 60_000,
  cluster: { leases: { ttlMs: 4_000, renewMs: 1_000, marginMs: 1_000 } },
  // Runs on every incarnation of every node, with the run's database and the node's cluster.
  setup: ({ cluster, db, client }) => {
    const persistence = db.persistence();
    return cluster.sharding.init({ type: 'show', host: !client, remember: true,
      entity: (id) => show(id, persistence) });
  },
  // Each client's operations, drawn from the run's workload stream and recorded in the history.
  workload: ({ op, chance, entity }) =>
    op('buy', entity('show', chance.pick(SHOWS)), (ref) =>
      ref.ask<Receipt>((replyTo) => ({ type: 'buy', seats: 1, replyTo }), { timeoutMs: 3_000 })),
  faults: { nodes: true, clocks: true, network: 'contract', disks: true },
  invariants: [
    invariants.oneLiveInstance(),
    invariants.acknowledgedWritesKept(),
    invariants.noStaleReads({ read: 'status', write: 'buy' }),
    invariants.recovers({ withinMs: 20_000 }),
  ],
});

const report = await rehearse(festival, { seeds: { from: 1, count: 1_000 } });
// report.failures: each with its seed, its shrunk plan, the violations and the replay line
const run = await festival.run({ seed: 4217, plan }); // one run, with its history
```

- A **scenario** is a value: nodes, a setup, a workload, which faults, which invariants. It checks its options when it's made, and throws there, never later.
- A **run** is a seed and a fault plan. The seed alone draws a plan. A plan given explicitly replaces the drawn one, which is how shrinking and replay work.
- `rehearse` runs seeds one after another in this process. `npm run rehearse` splits a range across worker processes, which is a script, not part of the public API.

Sketch of the public types, settled in the tasks:

```ts
export interface Scenario {
  run(opts: { seed: number; plan?: FaultPlan }): Promise<Run>;
}

export interface Run {
  readonly seed: number;
  readonly plan: FaultPlan;
  readonly history: History;
  readonly violations: readonly Violation[];
  /** One line that replays this run exactly: the seed and the plan, encoded. */
  readonly replay: string;
}

/** Faults, in order of simulation time. Plain JSON, so it prints, edits and shrinks. */
export type FaultPlan = readonly Fault[];

export interface Invariant {
  readonly name: string;
  check(history: History): readonly Violation[];
}
```

### Time: one clock for the world, and one for each node

Today every node in a test cluster shares one `ManualScheduler`, so every node reads the same time. That can't test what 0029 depends on: that a holder's clock and the store's run at about the same rate, and that a node whose process stops past its deadline is caught by the journal ([0033](#decision-records)).

- **Simulation time** is one `ManualScheduler`'s time. Nothing in the cluster reads it. The history stamps every entry with it, so entries from different nodes can be compared.
- **Each node gets its own `Scheduler`,** a view onto simulation time. Its `now()` runs at its own rate, drawn per incarnation within `driftPpm` (default ±200 ppm, and up to ±20,000 when the plan says so). Its timers fire when its own clock reaches them. It never goes backwards, since `Scheduler.now()` is monotonic.
- **A pause** stops a node's process, as a long GC or a suspended VM does: none of its tasks or timers run, and its frames wait at its sockets. Its clock keeps going. When the pause ends, everything that fell due runs at once, in order. That's the case 0029 leaves to the journal's sequence check.
- **The database has its own wall clock,** which is what the store judges lease expiry by and the journal stamps events with ([0015](decisions/0015-journal-timestamps-come-from-an-injected-clock.md)). A plan can jump it forward, which 0029 names as the way a lease can expire before its holder's deadline.

### Closing virtual time

[0003](decisions/0003-injected-scheduler-and-random.md) left a gap: an async `receive` awaits real promises, so `settle` waits real event-loop turns while actors are busy, and a journal call takes no virtual time at all. Rehearsal closes it.

- **Every I/O call resolves on the scheduler.** A journal append is a request that reaches the database after a latency, is applied there, and answers after another, each a timer. So a slow disk takes simulation time, a hung one never answers, and a paused node's answers wait for it.
- **The run loop** runs every ready task on every node, then lets the real promise continuations they started finish, then does it again until nothing is ready. Then it moves simulation time to the next timer. It doesn't wait for busy actors to finish: an actor awaiting a simulated call is waiting on a timer, and time will reach it.
- **A stall is an error.** If nothing is ready, no timer is set, and an actor is still busy, it's awaiting something outside the simulation. The run fails with the actor's path, as `settle`'s hint does. A cluster's heartbeats always have a timer set, so a run also stalls when one actor stays busy on one message for `stallAfterMs` of its own clock (default 30,000), as T1 settled.
- **Letting promise continuations finish** needs one macrotask, and it has to be cheap and work in every runtime, since the site runs seeds in the browser. `setTimeout(0)` is at least 1 ms in Node and 4 ms in nested browser calls, which is too slow for a run of tens of thousands of steps. T1 probes `setTimeout`, `MessageChannel` and `setImmediate` on Node 22, 24 and 26 and in Chromium, and records the choice. A new global goes in [globals.d.ts](../src/globals.d.ts) only if every runtime 0004 lists has it.
- The testkit's `settle` and `advance` don't change. Rehearsal's loop is its own.

### Seeds and streams

One seed draws everything, through separate streams, so changing one part of a run doesn't change the others ([0034](#decision-records)).

- **The plan stream** draws the fault plan, before the run starts.
- **The workload stream** draws each client's operations.
- **Each node incarnation's `random`**, as the test cluster does today, so a restart draws a new uid.
- **The network's and the database's streams** draw latencies, losses and reorderings.

Each stream is `seededRandom` of a hash of the seed and the stream's name. Removing a fault from a plan changes what happens after it, but not the draws of the workload or of any node, so shrinking stays meaningful.

### The simulated network

`simulatedNetwork` implements `Transport` on simulation time, as the in-memory network does, with faults ([0035](#decision-records)):

| Fault | What it does |
| --- | --- |
| Partition | Frames between two sets of nodes are lost, both ways or one way only, until it heals. Connections see nothing, as with a dropped cable, and heartbeats stop arriving |
| Reset | A connection closes with an error, and the frames on it are lost, as a TCP reset loses what's in flight |
| Delay | Latency for a node, or for a pair, is drawn from a range until it ends. Frames on one connection stay in order |
| Reorder | Frames on different connections arrive in any order relative to each other |
| Loss, within a connection (beyond the contract) | Single frames are lost while the connection stays open |
| Reorder within a connection (beyond the contract) | Frames on one connection overtake each other |
| Duplicate (beyond the contract) | A frame arrives twice |

- **Contract mode** (the default) only does what TCP can: lose frames by closing the connection, never one in the middle, and never reorder or repeat within one.
- **Chaos mode** adds the last three. The `Transport` contract promises order and no duplicates ([0026](decisions/0026-remoting-is-at-most-once-behind-a-transport.md)), so ordering checks are off in chaos mode. Safety checks stay on: one live instance and no lost acknowledged write rest on the lease and the journal, never on the network, and chaos mode tests that claim.
- With no faults, it passes remoting's suite, as the in-memory and TCP networks do.
- **A partition in contract mode holds frames,** as TCP retransmits across a dropped cable: they arrive in order once it heals, or the connection resets at both ends after `resetAfterMs` (default 10,000) with them lost. A dial across one opens on heal or fails after `resetAfterMs`. In chaos mode a partition loses what it cuts. Settled in T2 ([0035](decisions/0035-safety-under-any-network-ordering-under-the-contract.md)).
- **Latency is drawn per open, frame and close,** from 1 to 3 ms by default, so frames on different connections overtake each other even with no faults.

### The simulated database

`simulatedDatabase` gives a `Persistence` (journal, snapshots, offsets) and a `ShardStore`, which share one endpoint, as Postgres serves both in a real cluster. Its data is in-memory: the existing in-memory backends behind a layer that adds time and faults.

| Fault | What it does |
| --- | --- |
| Latency | Every call takes a request and a reply latency, drawn per call |
| Slow spell | Latency for every call, or one node's calls, rises to a range for a while |
| Hang | Calls are accepted and never answered, for a while or for good |
| Error | Calls fail with an error, without being applied |
| Lost reply | A call is applied, and its answer never arrives: the outcome a caller can't know, which 0013 settles by recovery |
| Cut off | One node can't reach the database, as the test cluster's `setReachesStore(false)` does today |
| Clock jump | The database's wall clock jumps forward |

With no faults, it passes the journal's contract suite and the shard stores' contract suite.

Settled in T3:

- **Calls are independent,** as on a pool of connections: two from one node can overtake each other. Latency is drawn per request and per reply, from 1 to 3 ms by default, from the database's own stream. Arguments are checked and copied when a call is made, and bad ones reject at once, as a driver's do.
- **A hang holds** the calls that arrive, unapplied and unanswered, and applies them in arrival order when it lets go. A hang that never lets go hangs them for good.
- **A cut-off node** has its calls refused, unapplied, and replies already on their way to it arrive as a lost connection, so an applied call can report failure. A cut is by node name, so it reaches every incarnation.
- **A client closes** when its node is killed: what it sent still lands, but its waiting calls and every later one fail at once, so what's left of the node in the process can wind down.
- The database's wall clock is simulation time by default, or a `clock` option, as the in-memory backends take one, plus any jumps.
- On the database, the in-process invariant scenario's cut from the store cuts a node off from its journal too, so a persistent actor whose call fails stops, as 0013 has it. The scenario counts those apart from other failures. A node killed while leaving can't reach the store to hand off its last shard and retries until the run ends, so the test cluster's `shutdown` no longer waits for killed incarnations.

### Timeouts

A call that never answers leaves its caller stuck: a persistent actor awaiting an append holds its mailbox for good ([0011](decisions/0011-persisting-holds-the-mailbox.md)), and a handoff waiting on that actor holds its leave until the lease's deadline (0030). Milestone 2 deferred the fix to here, where the problem first bites ([0036](#decision-records)).

- **Every journal and snapshot call a persistent actor makes times out** after `timeoutMs` (default 10,000), on the actor's scheduler. A timeout fails the actor with `PersistenceTimeoutError`, which its supervision handles. An append that timed out may still have committed, so a restart recovers from the journal and finds out, as 0013 already does for a failed append. A reply is never sent for a write whose outcome is unknown.
- **Every shard store call the cluster makes times out** after `storeTimeoutMs` (default `renewMs`). A renewal that times out counts as failed. The holder's deadline already stops its shards whether or not the store answers (0029), so this only frees the caller to try again sooner. An acquire that times out may have succeeded. The holder doesn't know it has the lease, but `renewAll` still extends it, so it doesn't run out on its own: the region's next acquire finds it held by itself and keeps it. Settled in T4 ([0036](decisions/0036-timeouts-are-unknown-outcomes-settled-by-recovery.md)), which leaves an untracked lease that stays renewed to T7's hunt.
- **Projections** time out the same way, and retry after their backoff.
- With timeouts, a handoff is bounded by `timeoutMs`, which answers T7's note.

### Fault plans

A plan is a list of faults with their simulation times, and it's plain JSON:

```json
[
  { "at": 12000, "pause": "node-2", "ms": 6000 },
  { "at": 15500, "partition": [["node-1"], ["node-2", "node-3", "crowd"]], "ms": 4000 },
  { "at": 21000, "disk": "hang", "node": "node-3", "ms": 3000 },
  { "at": 30500, "kill": "node-1", "restartAfterMs": 2000 }
]
```

- **Drawn from the plan stream**, by the scenario's `faults` options: which kinds, how often, how long, and how many at once (default: up to two, so the cluster sometimes faces a kill during a partition). The defaults are tuned so most runs see several faults and a cluster that should survive them.
- **Every fault ends,** and the last one ends with time to spare before `durationMs`, so `recovers` has a quiet tail to check. A kill ends in a restart, a partition heals, a pause resumes, a hang lets go.
- **Joins and leaves** are faults too, so handoffs happen as often as failovers.
- A plan given to `run` is checked like any option: unknown nodes or kinds throw when it's passed in.

Settled in T5 ([0034](decisions/0034-a-run-is-a-seed-and-a-plan.md)):

- **The kinds:** `kill` with `restartAfterMs`, `pause`, `leave` with `rejoinAfterMs`, `join` of a spare, `partition` (with `oneWay`), `reset`, `delay`, `reorder` (with `within`, chaos only), `lose` and `duplicate` (chaos only), `disk` (`slow`, `hang`, `error`, `lostReplies`, for every node or one), `cut`, `jump` of the database's clock, and `drift` of a node's clock, which `NodeClock.setDrift` carries out, moving its timers to the new rate.
- **Drawing:** `faults: { nodes, clocks, network, disks }` turn on groups, `only` names kinds, and `perMinute` (6), `concurrent` (2) and `lastingMs` (1 to 8 s) shape the draw. Node faults never land on a node already under one, always leave a host free, and never touch a client. Drawn jumps stay within `marginMs`.
- **The workload runs on simulation time,** each client's `workload` every draw of `everyMs` (50 to 250 ms) from its own stream, and operations record what they send and how they end. Nothing the cluster answers changes what the workload draws.
- **A process manager restarts nodes.** A node that exits on its own, downed or never let in, starts again as a new incarnation after `restartAfterMs` (2,000). What's left of an ended process is paused for good and unwatched.
- **Spares** are hosts that start only when a plan joins them: festival night has one, `node-4`, so joins hand shards off as leaves do.

### The history

Every run records one history: a list of entries in simulation time, each a JSON value.

- **Operations:** each client operation's invocation (its name, entity and arguments) and its completion: ok with its reply, failed, or timed out, which means its outcome is unknown.
- **Events:** every system event from every node incarnation, with the node, its incarnation, its own `at` and the simulation time, message events included, since the checkers need `delivered`.
- **Faults:** when each began and ended.
- **Database calls:** each journal append and lease operation, with its caller, its outcome, and whether its reply was delivered.

The history is what a failure prints, what replay reproduces byte for byte, and what the site draws. It's the input to every checker, which never looks at the live system.

### Invariants

Built in, each a function of the history ([0035](#decision-records)):

| Invariant | What it checks |
| --- | --- |
| `oneLiveInstance` | No two instances of one entity process messages in overlapping intervals of simulation time. An instance runs from `spawned` to `stopped`, on its node. While its node is paused it processes nothing, so a pause alone isn't a violation: what it does when it wakes may be |
| `acknowledgedWritesKept` | Every operation that completed ok and was a write has its events in the journal at the end, and every journal stream is 1 to n with no gaps |
| `noStaleReads` | A read never returns a state older than a write that completed before the read began. The scenario names its reads and writes, and says how to read a position from a reply, such as a show's count of seats sold |
| `atMostOnce` | No message is delivered twice. Contract mode only: chaos mode duplicates frames below remoting, which has no sequence numbers to drop them by |
| `orderPerPair` | Messages from one sender to one entity, while its shard stays put, are delivered in send order. Contract mode only |
| `recovers` | Once every fault has ended, within `withinMs`: every member's table agrees, every shard in use is held by its desired owner, and every entity answers |
| `failoverWithin` | After a kill, the dead node's entities answer again elsewhere within a bound, by default `ttlMs` plus one renewal and one rebalance |

- **Your own** are any `Invariant`: a name, and a check over the history.
- **Settled in T5** (decision [0035](decisions/0035-safety-under-any-network-ordering-under-the-contract.md) has them in full): an instance is live until it stops, its process ends, or its node's lease runs out by its own clock, after which the journal fences what it finishes. `acknowledgedWritesKept` takes the scenario's `write`, `kept` and `acknowledged`, and `noStaleReads` a `position` read from both reads' and writes' replies. `orderPerPair` checks only pairs sent a TTL after the shard settled, with no fault under way, since the history can't show when a client heard of a move. `recovers` checks that the shards running nodes hold are on their desired owners, not that every shard is held, since a region takes an empty shard only when it needs it. `atMostOnce` and `orderPerPair` declare `modes: ['contract']`, and a chaos-mode scenario given them throws.
- **The festival scenario** is `festival({ mode })` in `demo/src/rehearsal/domain/festival.ts`, so the tests, T6's script and T8's page share it: opening night's show at a capacity no run sells out, with `buy` a hold then its confirm, whose reply now carries `sold`, and `status` the read.
- **Clock drift beyond the margin is a known limit, not a bug.** If a plan drifts a node's clock by more than `marginMs` over `ttlMs` (0029's assumption), `oneLiveInstance` can fail and the journal must still hold. A run like that reports the overlap as `expected` rather than as a violation, as long as `acknowledgedWritesKept` and `noStaleReads` pass. The report counts them separately, so the write-up can say how often it happens.

### Shrinking and replay

A failing run is shrunk to the smallest plan that still fails the same invariant ([0034](#decision-records)):

1. Remove faults, one at a time and then in halves, keeping each removal that still fails.
2. Shorten the faults that are left: halve each duration, and move each start later, while it still fails.
3. Cut `durationMs` to just past the first violation, plus the time `recovers` needs if that's the one that failed.

Every attempt is a whole run with the same seed and an edited plan, so it's deterministic, and at most `maxShrinkRuns` (default 500). The result is the replay line: the seed and the shrunk plan, encoded as base64url JSON, which `--replay` and `scenario.run` both take. Replay checks it reproduces the same violation, and says so if it doesn't, since that means something in the run isn't deterministic.

### Determinism

A run is a pure function of its seed and plan. Everything that could break that is a bug:

- **Determinism is tested, not assumed.** For a sample of seeds in every CI run, each run happens twice, and the two histories must be identical, byte for byte.
- No `Date.now`, `Math.random` or real timers anywhere a run reaches, including the scenario's own code. Lint already keeps them out of `src/`. Rehearsal can't stop a scenario reading them, so the README says not to, and a run that diverges on replay says it may have.
- Iteration order matters: anything that iterates a `Set` or `Map` of nodes does so in insertion order, which is deterministic as long as insertion is.
- The TCP transport's nonces come from `node:crypto` (0027), but Rehearsal never uses TCP.

### Planted bugs

AGENTS.md asks that tests prove they can fail. For Rehearsal, that means each checker has to catch the bug it's there for, from random seeds, without being told where to look. Each planted bug is a change to `src/`, made by a test through internal options never exported (like the internals the test cluster already passes), and each has a row here:

| Bug | Expected to fail | Found by hand in |
| --- | --- | --- |
| The holder notes its deadline after the renewal returns, not before it's sent | `oneLiveInstance`, with slow disks | Nowhere: today's tests have instant stores |
| A handoff releases the lease before its entities stop | `oneLiveInstance` | T7's in-process test |
| The store grants a lease that's still held | `oneLiveInstance`, `acknowledgedWritesKept` | T6, once partitions were added |
| A region greets each member only once | `recovers` | T8's second CI run |
| A region routes to a holder it can't reach | `failoverWithin` | T8's first failover numbers |
| Gossip merge lets a status go backwards | `recovers` | Nowhere |
| A persistent actor replies before its append settles | `acknowledgedWritesKept` | Nowhere |

Each must be found within 10,000 seeds of the festival scenario, and shrunk to a plan of at most five faults. The table of how many seeds each took goes in the write-up.

### The hunt

Once Rehearsal finds planted bugs, it runs against the real code at scale: at least 1,000,000 seeds of the festival scenario across its fault mixes, contract and chaos mode, and the planted-bug rows.

- **Each bug it finds** gets a fix, a decision record if the fix changes a decision, a regression test that replays its shrunk plan, and a row in the write-up's list of bugs found.
- **Fencing** (milestone 4, open question 2). If a stale write or read gets past the journal's sequence check, the hunt has found the gap 0029 left open, and fencing goes back on the table. If it doesn't, the write-up says how many paused runs the sequence check caught alone.
- **Finding nothing is a result too.** If a million seeds find no bug in the real code, the write-up says so, with the planted-bug table as the evidence that Rehearsal could have.

### The site: `/rehearsal/`

The fourth page, after opening night, the write-up and festival night. Words first, as on the others:

- **Run seeds in the browser.** A button runs festival night's scenario on seed after seed, between animation frames, with a count of runs and runs per second. It's the real code, on the real simulated network and database (0004).
- **One run, drawn.** Simulation time across, one lane per node: up, paused, down, partitioned. Disk faults on a database lane. Each show's instances as bars on the lane of the node they ran on. A scrubber, and the log in plain words, as festival night has.
- **The bugs it found.** For each planted bug, and each real one, its shrunk failing run, drawn the same way, with the moment the invariant broke marked and a sentence on what went wrong. Recorded histories from `docs/decisions/data/`, read when the site builds, as the write-up's charts are, so the page doesn't ship bugs to replay them.
- Its own Vite entry, title, link preview and pageviews, and the phone layout the other pages have.

### CI

- **Every push:** the festival scenario on seeds 1 to 1,000, in contract and chaos mode, with determinism checked on every hundredth seed, and each planted bug's regression plan. The budget is two minutes on CI's runner.
- **No nightly run** (open question 8). New ground comes from running `npm run rehearse` on fresh ranges by hand, as the hunt does in T7.
- `npm run rehearse` takes `--seeds a..b`, `--workers n` (default the number of cores less one), `--mode contract|chaos`, `--plant <bug>` and `--replay <line>`.

### The write-up

A section on Rehearsal, after the cluster's: why a single thread makes simulation possible (0003, 0004), closing virtual time (0033), a run as a seed and a plan (0034), safety under any network (0035), timeouts as unknown outcomes (0036), the public JSON check (0037), the planted bugs (0040), the bugs the hunt found, and what 1.0 promises (0039). "What's next" lists the roadmap's later ideas.

### Layout and build

```
src/
  rehearsal/          the /rehearsal entry point (any runtime): scenario, rehearse, the run loop,
                      node clocks, the simulated network and database, plans, the history,
                      invariants and shrinking
scripts/rehearse.ts   npm run rehearse: seed ranges across worker processes, replay
test/rehearsal/       unit tests of each piece, the planted bugs, the regression plans, and the
                      contract suites run on the simulated network and database
demo/src/rehearsal/   the site's /rehearsal/ page
```

| Entry point | Runtime | Built with |
| --- | --- | --- |
| `@kylewillett/troupe/rehearsal` | any | `tsconfig.build.json`, no Node types |

- `/rehearsal` imports `/cluster` and `/persistence`. A package test checks that nothing else imports `/rehearsal`, and that it loads no Node built-in.
- `test/helpers/cluster.ts` stays for the tests that use it. `test/cluster/invariant.test.ts` moves onto Rehearsal in T5, and the old one goes once the new one catches everything it did.
- `src/`'s 90% line threshold covers the new code.

### Public API changes

As 0032 asks, before the work starts. All are additions except where marked.

| Change | Why | Task |
| --- | --- | --- |
| `@kylewillett/troupe/rehearsal`, a new entry point | The milestone | T1 to T6 |
| `persistentActor` and `projection` take `timeoutMs` | Milestone 2's open question 2 | T4 |
| `PersistenceTimeoutError` in `/persistence` | What a timeout fails an actor with | T4 |
| `joinCluster`'s `leases` takes `storeTimeoutMs` | Store calls that hang | T4 |
| A call that never settled now fails after 10 s. **Breaking** for code that relied on waiting forever | Unbounded waits are what Rehearsal is built to find | T4 |
| Whatever the hunt's fixes change, each listed in the changelog with its record | Unknown until found | T7 |

No change to `Transport`, `Connection`, `ShardStore`, `Journal` or `Scheduler` is planned. The simulated pieces implement them as they are. If one has to change, the change goes in the changelog and its record, and this table gains a row.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T1. Node clocks and the run loop | Done | 3fb3a2a |
| T2. The simulated network | Done | 2f7e1ff |
| T3. The simulated database | Done | 683985d |
| T4. Timeouts | Done | bea8541 |
| T5. Fault plans, the history and the invariants | Done | 825e281 |
| T6. `rehearse()`, shrinking, replay and planted bugs | Done | fb778f5 |
| T7. The hunt | Done | cb6c8cd |
| T8. The site's `/rehearsal/` page and the write-up | Not started | |
| T9. API review, README and 1.0.0 | Not started | |

### T1. Node clocks and the run loop

Write [0033](#decision-records).

- A scheduler per node on one simulation clock, with drift and pauses
- The run loop that closes virtual time, and stall detection
- The probe of how to yield one macrotask cheaply, in every runtime

**Done when** tests cover:

- [x] A node's timers fire when its own clock reaches them, at its own rate, and its `now()` never goes backwards
- [x] A paused node runs nothing until it resumes, then runs everything that fell due, in order, while the other nodes carry on
- [x] An actor awaiting a call that resolves on a timer lets time move on, with no real waiting, and an actor awaiting a promise outside the simulation stalls the run with its path in the error
- [x] Three nodes on the existing in-memory network, each on its own clock, converge and shard as on the shared clock, and two runs with one seed give identical events
- [x] The macrotask probe's results, on Node 22, 24 and 26 and in Chromium, are in 0033's Evidence, and a run of the existing invariant scenario is no slower than today's 10 ms a seed

### T2. The simulated network

Write [0035](#decision-records).

- `simulatedNetwork`, with each fault in its table, contract and chaos mode

**Done when** tests cover:

- [x] With no faults, remoting's suite passes on it, as on the in-memory and TCP networks
- [x] Each fault does what its row says, on simulation time: partitions both ways and one way, resets, delay, reordering across connections
- [x] Contract mode never loses a frame from the middle of a connection, or reorders or repeats one within it: a property test over random faults
- [x] Chaos mode does each of the three, and remoting, membership and sharding never throw on what it does
- [x] Membership converges after a partition heals, with frames lost and reordered on the way

### T3. The simulated database

- `simulatedDatabase`: a `Persistence` and a `ShardStore` on one endpoint, with each fault in its table

**Done when** tests cover:

- [x] With no faults, the journal's contract suite and the shard stores' contract suite pass on it
- [x] Each fault does what its row says: latency, slow spells, hangs, errors, lost replies, a node cut off, and a clock jump
- [x] A lost reply after an append leaves the events in the journal, and the caller never learns of it
- [x] Every call's request and reply take simulation time, so a paused caller gets its reply only when it wakes
- [x] T6's in-process invariant scenario from milestone 4 passes on it, with no faults beyond what it already injects

### T4. Timeouts

Write [0036](#decision-records).

- `timeoutMs` on `persistentActor` and `projection`, `PersistenceTimeoutError`, `storeTimeoutMs` on `joinCluster`'s `leases`

**Done when** tests cover:

- [x] A hung append fails the actor with `PersistenceTimeoutError` after `timeoutMs`, on the testkit's clock, and sends no reply
- [x] After a timed-out append that did commit, the restarted actor recovers with its events. After one that didn't, it recovers without them. Either way the next command sees the right state
- [x] A hung renewal, acquire or release times out after `storeTimeoutMs`, and the holder still stops its shards at its deadline
- [x] A handoff whose entity's append hangs finishes within `timeoutMs`, rather than at the lease's deadline
- [x] A projection whose read or offset save hangs retries after its backoff
- [x] Invalid timeouts throw where they're passed in, and the changelog lists the breaking change

### T5. Fault plans, the history and the invariants

Write [0034](#decision-records).

- `scenario`, plans drawn from the plan stream, the history recorder, the built-in invariants
- The festival scenario: festival night's shows on three nodes and a crowd, with `status` reads and `buy` writes
- `test/cluster/invariant.test.ts` on Rehearsal

**Done when** tests cover:

- [x] A plan drawn from a seed is the same every time, every fault in it ends before the quiet tail, and an invalid plan throws where it's passed in
- [x] Removing a fault from a plan doesn't change the workload's operations or any node's draws before the fault's time
- [x] Each invariant passes on a run built to pass it and fails on one built to fail it, with a violation that says what, where and when
- [x] Drift past the margin is reported as `expected`, not as a violation, while the journal holds
- [x] The milestone 4 invariant scenario, on Rehearsal, passes over 1,000 seeds, and catches the store that grants held leases, as the old test did
- [x] A history is JSON, and two runs of one seed and plan give byte-identical histories

### T6. `rehearse()`, shrinking, replay and planted bugs

- `rehearse`, shrinking, the replay line, `scripts/rehearse.ts` with workers
- The planted bugs, and the CI job

**Done when:**

- [x] Each planted bug in the table is found within 10,000 seeds of the festival scenario, by the invariant its row names, and shrunk to at most five faults. The seeds each took are recorded
- [x] Every shrunk plan replays to the same violation from its line, from `npm run rehearse -- --replay` and from `scenario.run`
- [x] A replay that doesn't reproduce says so
- [x] `npm run rehearse -- --seeds 1..10000` runs on all cores and prints a summary, and its runs per second on Node 22, 24 and 26 are recorded under `docs/decisions/data/`
- [x] CI runs seeds 1 to 1,000 in both modes, with determinism checked, inside its two minutes

Settled in T6 ([0034](decisions/0034-a-run-is-a-seed-and-a-plan.md), [0040](decisions/0040-planted-bugs-are-found-by-what-they-break.md)):

- `rehearse(scenario, { seeds, ignore, maxFailures, maxShrinkRuns, determinismEvery, onSeed })`, `replay(scenario, line)`, `scenario.run({ seed, plan, untilMs })` and `scenario.run({ replay })`, and `Run.replay` and `Run.untilMs`. A stall is a violation called `stall`.
- A planted bug counts only where the same seed, plan and end without it pass the invariant it broke, since festival fails `recovers` on about 7% of seeds today. `late-deadline` and `routes-unreachable` have hunts of their own: slow disks, cuts and partitions for one, and `joinCluster`'s default downing for the other. Festival's own mix found the other five.
- `failoverWithin` checks that the entities answer once they're back, as its row here says, where T5's checked only that they ran. On festival night that fails 23 of 10,000 seeds in each mode with no bug planted, so CI counts `recovers`, `orderPerPair` and `failoverWithin` without failing on them until T7.

### T7. The hunt

- At least 1,000,000 seeds, contract and chaos mode, with the fault mixes varied
- A fix, a record where a decision changes, and a regression plan for each bug found
- Fencing, decided from what the hunt shows

Leads from T5, where the checks found real behaviour on the way (see [0035](decisions/0035-safety-under-any-network-ordering-under-the-contract.md)'s Evidence). Over 1,000 festival seeds, `recovers` fails 63 in contract mode and 91 in chaos mode, and `orderPerPair` fails 1:

- **Split brain after a partition.** When a partition cuts both ways, each side downs the other and then stops trusting it, so the halves never merge, and neither half's downed members ever hear they were downed. A one-way partition can let a client down every host. Milestone 4 left a split-brain strategy as a stretch goal: this is what it costs.
- **A buffer flushed late.** After a database hang, a node got a shard back while a client still held messages for it, waiting on a lookup. Newer messages went straight to the owner and overtook the buffered ones. Seen while building the checks, on accounts under every fault at 20 a minute, and not yet on festival night.
- **A leave that never ends.** A node that starts leaving during a database hang, and is downed while it leaves, stays `leaving` for good (festival contract seed 93).
- **Asks that never answer** 20 s after the faults heal (festival chaos seeds 8 and 51).
- **A message overtaken just after a partition heals** (festival contract seed 777).
- **Asks that don't reach an entity that failed over** (T6, [0040](decisions/0040-planted-bugs-are-found-by-what-they-break.md)). With `failoverWithin` checking answers, 23 of 10,000 festival seeds fail in each mode: a show runs again after a kill, often on the restarted incarnation of the same node, and none of the asks begun on it in the next few seconds answers. Contract seeds 8,959 and 9,025 and chaos seeds 7,159 and 8,044 are among them. At 10,000 seeds, `recovers` fails 726 in contract mode and 860 in chaos mode, and `orderPerPair` 4. When T7 fixes them, CI's `--ignore` goes.
- **A deposed holder's write landing after the new owner recovered** (festival chaos seed 602): the sequence check caught it, as 0013 promises, so it's evidence for the fencing decision, not a bug.

**Done when:**

- [x] The runs are recorded: seeds, modes, mixes, runs, violations found, and the machine, with the exact commands
- [x] Every violation found has a fix, a regression test replaying its shrunk plan, and an entry for the write-up, or a written reason it's expected (such as drift past the margin)
- [x] Fencing is decided, with the hunt's numbers, and the decision recorded
- [x] The full 1,000,000 seeds pass on the fixed code

Settled in T7 ([0042](decisions/0042-keep-the-majority.md), [0043](decisions/0043-the-hunt-and-fencing.md)):

- Keep the majority, which the scope table had left to milestone 4's stretch goals: four in five of the first failures were split brain, and `recovers` can't pass without a split-brain strategy. With it come the rules the hunt showed it needs: no newcomer while a member is unreachable, members greet the seeds they lack, a side of one never keeps the cluster, ties go to the first seed, and two clusters settle it at their hello whenever one has the other down and the other doesn't count it.
- Twenty bugs in the real code and two in Rehearsal's checks, each with a regression plan in `test/demo/found.ts`. Fault mixes, `--mix all|nodes|network|clocks|heavy`, vary the hunt.
- Fencing stays off: no stale write or read got past the sequence check in a million seeds.
- Two planted bugs get hunts of their own. `late-deadline`'s pushes downing past the run, since a cut-off holder now downs itself before its stretched deadline can overlap anyone, and narrows the margin to 250 ms, since the store timeout caps how far the bug stretches a deadline, and festival's margin equals it. `greets-once`'s draws kills, joins, leaves and resets, since members now greet the seeds they lack.
- `gossip-backwards` is tolerated now: statuses still go backwards, and keep the majority downs each ghost again before `recovers` checks, so six hunts of 10,000 seeds found nothing. Its row says so, its test shows the bug fires and breaks nothing, and the Definition of done reads "found and shrunk, or shown harmless since a fix" (answered in review, 2026-11-25).
- CI fails on every invariant: `--ignore` is gone.

### T8. The site's `/rehearsal/` page and the write-up

- `demo/src/rehearsal/`: running seeds, a run drawn, the bugs found
- The write-up's Rehearsal section

**Done when:**

- [ ] `/rehearsal/` runs seeds in the browser, draws a run with a scrubber and a plain-words log, and shows each bug's failing run with the moment it broke marked
- [ ] The recorded histories come from `docs/decisions/data/` at build time, and the build fails if one is missing
- [ ] Playwright covers running seeds, the scrubber, each bug, the phone width, and the frame budget (no frame over 50 ms while seeds run)
- [ ] The site bar links the page, and it has its own title, link preview and pageviews
- [ ] "How Troupe works" has a Rehearsal section citing 0033 to 0040 and every record the hunt added, and the records test passes
- [ ] Someone non-technical can say what the page shows and why it matters (you check this)

### T9. API review, README and 1.0.0

Write [0039](#decision-records).

- An API review: every export, its name, its TSDoc, and whether it's ready to promise
- The README's Rehearsal section, AGENTS.md's layout and commands, the changelog
- 1.0.0 from CI, after your approval of the tag

**Done when:**

- [ ] Every public export has been reviewed, and anything not ready is removed or renamed before 1.0, with the changelog saying so
- [ ] 0039 says what 1.0 promises: which exports, whether a new `SystemEvent` or dead-letter reason is a minor or a major change, and Backstage's protocol
- [ ] The README covers rehearsing your own entity types, writing an invariant, replaying a failure, and what Rehearsal doesn't simulate
- [ ] The export-list test, `publint`, `attw` and `check-pack.ts` cover `/rehearsal`
- [ ] After your approval in chat, `v1.0.0` is tagged and published with provenance, and the smoke script's quick start works from npm on Node 22, 24 and 26

## Stretch goals

Only after T9, and only if the milestone is otherwise done.

- **Shrinking the workload.** Drop operations as well as faults, for shorter replays.
- **Rehearsal in Backstage.** Open any node of a recorded run in Backstage, scrubbing through simulation time.
- **A linearizability checker** for one entity's operations, Knossos-style, in place of `noStaleReads`.
- **Measuring milestone 4's stretch goals:** keep-the-majority and Understudy, if they're built, by how they change failover times and availability under partitions.

## Definition of done

- [ ] T1 to T9 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration`, `coverage`, `build` and `check:package` all pass, locally and in CI, and so do the Playwright, `test:cluster`, `cluster-docker` and Rehearsal jobs.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies, and no peer dependencies.
- [ ] Everything outside `src/node/` builds with no Node types and imports no Node built-ins.
- [ ] Every planted bug is found and shrunk, or shown harmless since a fix, and 1,000,000 seeds pass on the fixed code. (`gossip-backwards` is the one shown harmless: T7, [0043](decisions/0043-the-hunt-and-fencing.md).)
- [ ] `/rehearsal/` is live on the site.
- [ ] `@kylewillett/troupe` 1.0.0 is on npm with provenance.

## Decision records

The tasks add these records, as Proposed, and accept them once their tests pass. Read [0003](decisions/0003-injected-scheduler-and-random.md), [0004](decisions/0004-runtime-agnostic-core.md), [0013](decisions/0013-sequence-check-is-the-single-writer-backstop.md), [0026](decisions/0026-remoting-is-at-most-once-behind-a-transport.md), [0029](decisions/0029-a-shard-is-owned-by-whoever-holds-its-lease.md) and [0032](decisions/0032-1-0-comes-after-rehearsal.md) first, since these build on them.

| # | Decision | Task |
| --- | --- | --- |
| 0033 | A run has one simulation clock, each node a clock of its own derived from it, and every I/O call resolves on it, which closes virtual time | T1 |
| 0034 | A run is a seed and a fault plan, the plan is data, and the plan is what shrinks. Each concern draws from its own stream | T5, T6 |
| 0035 | Safety is checked under any network fault, and ordering only under faults the `Transport` contract allows | T2, T5 |
| 0036 | Journal and shard store calls time out on the scheduler, and a timeout is an unknown outcome, settled by recovery. Answers milestone 2's open question 2 | T4 |
| 0037 | The JSON check is public (written between T4 and T5, for 0.3.0) | — |
| 0038 | A pipe with a signal ends on the scheduler (written after T5, for 0.3.1) | — |
| 0039 | What 1.0 promises. Numbered 0038 until 0038 went to the pipe | T9 |
| 0040 | A planted bug is found by what it breaks, and failover means answering again | T6 |
| 0041 | A failure can raise its backoff delay (written after T6, for 0.3.2) | — |

T7 adds a record for each bug fix that changes a decision, and one for fencing, numbered as they come.

## Open questions

1. **Where Rehearsal lives.** Options: a public entry point, `/rehearsal`, as above; or test-only code in `test/`, with only its results public. Recommendation: public. Rehearsing your own entities is what makes it a feature rather than a test suite, it's the cluster testkit milestone 4 put off, and it's the roadmap's second angle. It costs an API to keep stable from 1.0, which T9's review is for.

   *Answer (spec review, 2026-11-24): public, as `@kylewillett/troupe/rehearsal`.*

2. **Faults beyond the transport's contract.** Options: contract mode only; chaos mode only; or both, with ordering checked only in contract mode, as above. Recommendation: both. Contract mode tests the cluster against the network it'll really get. Chaos mode tests the claim that matters most: that one live instance and no lost writes don't depend on the network at all, only on the lease and the journal.

   *Answer (spec review, 2026-11-24): both modes, with ordering and at-most-once checked in contract mode only.*

3. **Clock drift past the margin.** Options: report it as `expected` when the journal holds, as above; count it as a violation; or never draw drift that large. Recommendation: report it as `expected`. 0029 says safety rests on rates staying close, and the journal is the backstop when they don't. Never drawing it would hide how often the backstop is needed, and failing on it would fail on a limit the design states.

   *Answer (spec review, 2026-11-24): report it as `expected`, counted apart from violations, as long as the journal holds.*

4. **Where timeouts are set, and their defaults.** Options: `timeoutMs` per persistent actor and projection, and `storeTimeoutMs` per cluster, as above; or one timeout per `Persistence` backend. Recommendation: per actor and per cluster. A backend has no scheduler, and the timeout must run on the actor's (0003). 10 s for the journal matches the lease TTL, so a hung append never outlives the shard it's in.

   *Answer (spec review, 2026-11-24): `timeoutMs` per persistent actor and projection, default 10,000, and `storeTimeoutMs` per cluster, default `renewMs`.*

5. **Fencing the journal with the lease token** (milestone 4, open question 2). Options: decide now; or let the hunt decide, as above. Recommendation: let the hunt decide. Milestone 4 said paused clocks would show whether the gap matters, and T1 to T5 build exactly that.

   *Answer (spec review, 2026-11-24): let the hunt decide, in T7.*

6. **The site.** Options: a fourth page, `/rehearsal/`, as above; or a Rehearsal mode on festival night's page. Recommendation: its own page. Festival night tells a story at human speed, and Rehearsal's point is thousands of runs, then one drawn in detail. Each page loads only its own code, as the others do.

   *Answer (spec review, 2026-11-24): its own page, `/rehearsal/`.*

7. **The version.** Options: 1.0.0 at the end of this milestone, after an API review, as above; or 0.3.0 now and 1.0 later. Recommendation: 1.0.0, as 0032 planned. The interfaces 0032 held 1.0 back for are the ones this milestone tests, and the review in T9 is where anything not ready comes out. A record says what 1.0 promises, since the answer for `SystemEvent`, which users `switch` on, isn't obvious.

   *Answer (spec review, 2026-11-24): 1.0.0 at the end of this milestone, after T9's API review, with a record of what 1.0 promises.*

8. **CI's budget.** Options: 1,000 seeds per push and 100,000 nightly; more per push and no nightly; or 1,000 per push and no nightly. Recommendation: 1,000 per push and 100,000 nightly. Two minutes keeps pushes quick, and the nightly's fresh seeds find what fixed seeds can't. A nightly failure doesn't block anyone, and its replay line is all it takes to look.

   *Answer (spec review, 2026-11-24): 1,000 seeds per push, in both modes, and no nightly run.*
