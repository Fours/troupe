# 0019. The benchmark is a baseline for later milestones: medians of 10 runs, each in a fresh process

- **Status:** Proposed
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

Milestone 3 adds message events, and milestones 4 and 5 add remoting and simulation, all on the hot path of every message. Each needs a number to be measured against, taken before it lands, or "it didn't slow things down" can't be checked. Milestone 2 also left a question open: what the Postgres journal's journal-wide lock ([0016](0016-postgres-appends-take-a-journal-lock.md)) costs. The numbers come from one laptop, where run-to-run noise can be as large as the change being looked for, so the method has to say how big that noise is.

## Decision

- **A baseline, not a comparison.** The benchmark measures Troupe against earlier Troupe. It never compares with other actor libraries: their delivery, supervision and mailbox semantics differ too much for one number to mean anything.
- **In Node, on real time, against `dist/`.** `npm run bench` runs `bench/run.ts` with Node's type stripping and imports the package by its own name, so it measures what npm users get. Systems run on `realScheduler`. Timings come from `performance.now()` in the bench, never from the library.
- **Each run times only the work.** It builds a fresh system or backend, starts the clock just before the work, stops it when the work is confirmed done, then tears down. Every scenario checks afterwards that it did all its work (every reply arrived, every stream has every event), so a bug that skips work fails the run instead of posting a better number.
- **Ten runs, each in a fresh process.** `bench/run.ts` starts `bench/child.ts` once per timed run. The child does 3 untimed warm-up runs, which let V8 optimise and open Postgres connections, then times one run and prints it as JSON. So the spread includes how much V8's optimisation varies between processes, which turned out to be the biggest noise there is (see Evidence), and no scenario's type feedback leaks into another's. Every run, warm-ups included, starts after a full GC (`--expose-gc`), so it doesn't pay for the previous run's garbage.
- **Medians and spread.** Each metric's median is taken over the 10 runs on its own (with an even count, the mean of the middle two). The spread is `(max − min) / median`. Latency percentiles are nearest rank, so a p99 is a latency some ask actually had. `bench/stats.ts` and `bench/report.ts` hold these definitions, and `test/bench/` pins them.
- **A change is real only outside the recorded range.** `npm run bench -- --compare <dir>` puts each new median next to the recorded min and max. A median inside that range is a tie.
- **Every recorded run says where it came from.** Its folder in `data/` has `setup.json` (date, exact command, commit, the last commit that changed `src/`, whether there were uncommitted changes outside the results folders, OS, CPU, cores, memory, and the Node, V8, SQLite and Postgres versions), `results.json` with every run, and `summary.md`. The hostname is left out.
- **The Postgres lock is measured by taking it away.** `journal-postgres-100-nolock` runs the real backend through a pool wrapper that drops the `pg_advisory_xact_lock` query, and nothing else. It's only for measuring: without the lock, tag offsets can commit out of order. The 100 streams never share a persistence id, so the appends themselves stay correct. Both Postgres variants go through the same wrapper.
- **CI runs `--quick` and keeps nothing.** One small run of each in-memory scenario on every Node line, with a one-minute timeout, so the benchmark can't rot. Shared runners vary too much for their numbers to mean anything.

| Scenario | What it measures |
| --- | --- |
| `ping-pong` | Two actors, 1,000,000 tells back and forth: messages per second |
| `ask` | 100,000 sequential asks: round trips per second, with p50 and p99 |
| `fan-out` | One parent and 10,000 children, one message to each and a reply back, 100 rounds: messages per second |
| `spawn-stop` | 10,000 top-level actors spawned, then stopped, until the last `postStop`: actors per second |
| `events-none`, `events-plain` | Ping-pong with no event subscriber, and with one that does nothing. T2 adds `{ messages: true }` |
| `journal-<backend>-1`, `-100` | One stream appended to one event at a time, then 100 streams in parallel, on in-memory, SQLite (a file) and Postgres (pool of 10): appends per second |

## Alternatives considered

| Option | Why not |
| --- | --- |
| A benchmark library such as `tinybench` or `mitata` | A dependency for what's about 50 lines of arithmetic. Their per-iteration timing suits microbenchmarks, while these scenarios are whole workloads that each need setup, teardown and a completion check |
| Timing many short iterations and reporting ops/s with a confidence interval | The workloads are seconds long and their noise is mostly between runs (GC, thermal state, other processes), which a min-to-max over 10 whole runs shows directly |
| Every run in one process, one after another | Faster, but it hides the biggest source of noise. In T1's first runs, runs within one process agreed to a few percent while two processes on the same Node differed by up to 5×, and the scenarios that ran earlier changed how V8 optimised the later ones (see Evidence) |
| Three runs, as rate-limiter's benchmark does | Message throughput on a laptop moves by several percent from run to run. Ten runs make the range a fair test for T2's "within the spread" |
| Benchmarks in CI with a regression threshold | Shared runners differ from run to run and from month to month, so a threshold would flake and the numbers would follow GitHub's hardware rather than the code |
| Measuring the Postgres lock by timing it inside the backend | Needs instrumentation in `src/`. Taking the lock away measures what it costs end to end, with the shipped code |

## Evidence

### The baseline

- **Setup:** Apple M5 Pro (18 cores, 24 GiB), macOS (Darwin 25.4.0), on mains power with nothing else running. Node 22.23.5, 24.22.3 and 26.12.1. Postgres 18.7 in Docker 29.4.1 (`docker-compose.test.yml`), pool of 10. SQLite 3.54 (Node's bundled `node:sqlite`), a file in WAL mode. Commit `4003682`, whose `src/` is milestone 2's last (`dbf9ad9`): T1 changes nothing in `src/`. Command: `npm run bench -- --out docs/decisions/data/0019-baseline-node<N>-2026-11-22`, under `nvm exec <N>`.
- **Raw data:** [Node 22](data/0019-baseline-node22-2026-11-22/), [Node 24](data/0019-baseline-node24-2026-11-22/), [Node 26](data/0019-baseline-node26-2026-11-22/). Each folder has `setup.json`, `results.json` with all 10 runs, and `summary.md`.
- **Results:** medians of 10 runs, with the lowest and highest run. Ask latency medians were 0.42 to 0.46 µs at p50 and 1.15 to 1.46 µs at p99.

| Scenario | Unit | Node 22 | Node 24 | Node 26 |
| --- | --- | --- | --- | --- |
| `ping-pong` | msg/s | 448,800 (443,760–458,164) | 480,679 (448,638–522,248) | 453,635 (432,245–488,067) |
| `ping-pong-noyield` | msg/s | 4,503,322 (3,726,908–4,665,881) | 4,669,006 (4,240,890–4,799,472) | 4,554,886 (4,173,922–20,551,200) |
| `ask` | asks/s | 1,677,551 (1,610,792–1,694,257) | 1,682,002 (1,663,145–1,702,986) | 1,707,099 (1,672,555–1,814,687) |
| `fan-out` | msg/s | 530,004 (492,278–615,818) | 541,748 (523,352–566,516) | 531,070 (481,619–597,532) |
| `fan-out-noyield` | msg/s | 13,814,294 (11,655,258–16,211,418) | 13,920,975 (13,040,084–14,625,933) | 16,377,058 (12,539,250–18,932,820) |
| `spawn-stop` | actors/s | 224,666 (180,584–233,844) | 221,791 (208,438–260,757) | 201,270 (170,440–221,603) |
| `events-none` | msg/s | 4,534,862 (4,242,669–4,684,046) | 4,692,937 (4,393,376–4,797,594) | 4,642,459 (3,936,162–4,780,642) |
| `events-plain` | msg/s | 4,583,666 (4,191,355–4,726,563) | 4,682,802 (4,533,852–4,784,236) | 4,474,274 (3,513,188–4,636,623) |
| `journal-memory-1` | appends/s | 1,860,271 (1,396,201–1,966,262) | 1,800,283 (1,221,020–1,846,182) | 1,858,769 (1,741,238–1,899,847) |
| `journal-memory-100` | appends/s | 1,656,115 (1,499,044–1,721,899) | 1,725,501 (1,126,459–1,787,456) | 1,896,393 (1,637,041–2,307,316) |
| `journal-sqlite-1` | appends/s | 20,158 (17,872–25,688) | 19,332 (14,126–25,220) | 20,339 (12,725–24,734) |
| `journal-sqlite-100` | appends/s | 24,670 (15,479–25,455) | 24,361 (20,396–24,954) | 24,773 (22,684–25,993) |
| `journal-postgres-1` | appends/s | 1,552 (1,470–1,681) | 1,551 (1,501–1,630) | 1,575 (1,541–1,648) |
| `journal-postgres-100` | appends/s | 2,109 (1,981–2,169) | 2,165 (2,043–2,190) | 2,247 (2,072–2,285) |
| `journal-postgres-100-nolock` | appends/s | 8,551 (7,975–8,764) | 8,781 (8,246–8,914) | 8,747 (7,313–9,165) |

The three Node lines are within each other's ranges on almost every row. None of them is faster across the board.

**Rerunning reproduces most rows, not all.** Straight after the baselines, each command ran again with `--compare` against its own record (not kept, since the record is the baseline). Node 26 put all 15 medians inside the recorded ranges, Node 22 put 12 there, and Node 24 put 8. The rows T2 depends on reproduced on all three: `events-none`, `events-plain` and `ping-pong-noyield` landed within 3% of their recorded medians. The misses were of two kinds:

- **Drift just past the edge.** Postgres came back 3 to 6% faster on Node 22 and 24, and the memory journal 4 to 6% faster on Node 24. A min-to-max over 10 runs from one sitting can't cover the machine changing between sittings.
- **Real jumps.** `fan-out-noyield` came back about 22% faster on Node 22 and 24, and Node 24's default `fan-out` 15% slower. Fan-out churns through 10,000 actors and so depends most on how V8 optimises them, and it's also the most sensitive to the fast mode below.

So a median outside the recorded range is a reason to look, not proof of a change: rerun the baseline in the same sitting before believing it. A change in `events-none` larger than its spread, about 10 to 18%, is one to trust.

### The yield timer sets the pace of busy actors

The first trial gave ping-pong spreads near 50%, with runs clustered at about 760,000 and 490,000 msg/s. A probe that counted the dispatcher's zero-delay timers found exactly 1,000 yields per million messages, as `yieldAfter: 1000` predicts, and `setTimeout(0)` averaging 1.16 ms on this machine (Node clamps it to at least 1 ms). With `yieldAfter` set out of reach, the same ping-pong ran at about 4.4M msg/s, with a spread of a few percent. So with the defaults, a busy pair of actors spends about 90% of its time waiting for the yield's timer, and fan-out about 96%.

That's what [0007](0007-microtask-wake-macrotask-yield.md) chose, and it's working as designed: the yield is what lets I/O and timers run while actors message each other without end. But it makes the default rows measure the timer, not Troupe. So the benchmark keeps the default rows, since that's what users get, and adds `-noyield` rows, and the message-events rows run without yields so that T2 can see a per-message cost. Whether the yield could be cheaper, say after a time budget rather than a step count, is a question for the write-up and a later milestone, not a change here.

### Each run needs its own process

The first full baselines ran every run of every scenario in one process. On Node 24, a rerun on the same commit was 5× faster on every in-process no-yield row (24M against 4.5M msg/s for `events-none`) and 25 to 35% faster on the rest, while runs inside each process agreed to within a few percent. Run alone, in five fresh processes each on Node 24 and 26, `events-none` gave 4.0M to 4.8M msg/s. So the spread within a process understated the real noise by about 20 points, and the scenarios that ran first shaped how V8 optimised the later ones: `fan-out-noyield` went from about 4M msg/s in a shared process to about 14M on its own. Since then, every timed run is its own process.

Fresh processes still sometimes land in the fast mode. Three of Node 26's ten `ping-pong-noyield` runs ran at about 20M msg/s, which is why that row's range is so wide. The median isn't affected, but a range that wide can't detect a change, so T2 should judge per-message cost by `events-none`, whose range is 10 to 18%. Why V8 sometimes optimises the dispatcher loop 4× better is worth knowing. If the fast mode can be made the usual one, it's the biggest speed-up available, and it's a question for a later milestone.

### The Postgres lock (milestone 2, open question 3)

One stream appending one event at a time manages about 1,550 appends/s, one round trip after another. A hundred streams in parallel, with a pool of 10, manage only about 2,100 to 2,250: 1.4× one stream, because every append in the journal waits for the one advisory lock ([0016](0016-postgres-appends-take-a-journal-lock.md)). With the lock taken away and nothing else changed, the same hundred streams manage about 8,550 to 8,800, 4× as many. So the lock is the bottleneck for parallel writers, and it caps one Postgres journal at roughly 2,200 appends/s on this machine, however many entities write. That's ample for one node of the demo, and it's the first thing milestone 4's sharding will run into, since it has many entities writing at once. The alternative is the one milestone 2 named: no lock, and Akka-style gap detection in tag readers. As planned, that's a finding for the write-up and milestone 4, not a change here.

## Consequences

Later milestones have a number to beat, and a rule for when a difference counts. The numbers describe one machine: rerunning on other hardware should keep the shape (which scenarios are slow, what the lock costs relative to no lock), not the values. The benchmark runs against `dist/`, so a stale build measures stale code: build first.
