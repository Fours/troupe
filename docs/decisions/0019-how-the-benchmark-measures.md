# 0019. The benchmark is a baseline for later milestones, measured in-process with medians of 10 runs

- **Status:** Proposed
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

Milestone 3 adds message events, and milestones 4 and 5 add remoting and simulation, all on the hot path of every message. Each needs a number to be measured against, taken before it lands, or "it didn't slow things down" can't be checked. Milestone 2 also left a question open: what the Postgres journal's journal-wide lock ([0016](0016-postgres-appends-take-a-journal-lock.md)) costs. The numbers come from one laptop, where run-to-run noise can be as large as the change being looked for, so the method has to say how big that noise is.

## Decision

- **A baseline, not a comparison.** The benchmark measures Troupe against earlier Troupe. It never compares with other actor libraries: their delivery, supervision and mailbox semantics differ too much for one number to mean anything.
- **In-process, on real time, against `dist/`.** `npm run bench` runs `bench/run.ts` with Node's type stripping and imports the package by its own name, so it measures what npm users get. Systems run on `realScheduler`. Timings come from `performance.now()` in the bench, never from the library.
- **Each run times only the work.** It builds a fresh system or backend, starts the clock just before the work, stops it when the work is confirmed done, then tears down. Every scenario checks afterwards that it did all its work (every reply arrived, every stream has every event), so a bug that skips work fails the run instead of posting a better number.
- **One warm-up run, then 10.** The warm-up lets V8 optimise and Postgres connections open. Runs start after a full GC (`--expose-gc`), so a run doesn't pay for the previous one's garbage.
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
| Three runs, as rate-limiter's benchmark does | Message throughput on a laptop moves by several percent from run to run. Ten runs make the range a fair test for T2's "within the spread" |
| Benchmarks in CI with a regression threshold | Shared runners differ from run to run and from month to month, so a threshold would flake and the numbers would follow GitHub's hardware rather than the code |
| Measuring the Postgres lock by timing it inside the backend | Needs instrumentation in `src/`. Taking the lock away measures what it costs end to end, with the shipped code |

## Evidence

To be filled in with the baseline runs.

## Consequences

Later milestones have a number to beat, and a rule for when a difference counts. The numbers describe one machine: rerunning on other hardware should keep the shape (which scenarios are slow, what the lock costs relative to no lock), not the values. The benchmark runs against `dist/`, so a stale build measures stale code: build first.
