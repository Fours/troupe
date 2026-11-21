# 0003. All time, scheduling and chance go through an injected scheduler and random

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

Timers, ask timeouts and backoff all depend on time, and backoff jitter depends on chance. Tests that use real time are slow and flaky. Milestone 5's simulation testing must replay a whole run from a seed, which is only possible if nothing reads the real clock or `Math.random` behind the framework's back.

## Decision

The system takes a `Scheduler` (`now`, `runSoon`, `setTimer`) and a `random()` function. The core uses nothing else for time, scheduling or chance, and lint enforces this in `src/`. The testkit provides `ManualScheduler` (virtual time) and `seededRandom(seed)`. System events are published synchronously, as they happen, so the order they're recorded in is the order they happened in.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Vitest fake timers | Tied to one test runner. They patch globals instead of injecting, can't drive a simulated cluster, and miss `performance.now` unless configured. |
| Injecting only a clock (`now()`) | Timers would still use real `setTimeout`, so tests would still wait in real time. |

## Evidence

T1's scheduler tests, and T6's determinism test: the same scenario run twice with the same seed must give identical event logs.

**T1 (2026-11-20):** `ManualScheduler` and `seededRandom` are built and tested.
- `test/testkit/manual-scheduler.test.ts` pins the ordering rules that replay depends on: due time then creation order, queued tasks before timers, `now()` reading each timer's due time, and cancelling a timer that's due but hasn't run.
- Reversing the tie-break, ignoring the cancel flag, or running timers before tasks each fails a test.
- `test/testkit/random.test.ts` pins `seededRandom(1)`'s first three values, so a change to the generator can't silently change recorded seeds.

The record stays Proposed until T6 shows a whole actor system replaying identically.

**T6 (2026-11-20):** `test/determinism.test.ts` runs one scenario under the testkit. It has a periodic timer, two piped asks (one of which times out during a backoff delay, so its late reply is a dead letter), two crashes under `restartWithBackoff` with `randomFactor: 0.5`, a stop and a shutdown.
- Run twice with seed 1, it gives identical `kit.events`.
- The test also checks that the events include every kind it claims: `spawned`, `failed`, `restarted`, `deadLetter` and `stopped`.
- Seed 2 gives different `restarted.delayMs` values.
- Swapping the kit's `seededRandom` for `Math.random` fails the same-seed check. Making `seededRandom` ignore its seed fails the different-seed check.

## Consequences

- Every test runs on virtual time, and runs instantly.
- Async `receive` uses real promises, so virtual time isn't fully closed. `settle` has to wait real macrotask ticks while actors are busy. Milestone 5 will need simulated I/O to close that gap.
- Adding a new time-based feature means routing it through the scheduler. Lint catches `Date.now`, but not every slip.
