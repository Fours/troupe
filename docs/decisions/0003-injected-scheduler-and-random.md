# 0003. All time, scheduling and chance go through an injected scheduler and random

- **Status:** Proposed
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

## Consequences

- Every test runs on virtual time, and runs instantly.
- Async `receive` uses real promises, so virtual time isn't fully closed. `settle` has to wait real macrotask ticks while actors are busy. Milestone 5 will need simulated I/O to close that gap.
- Adding a new time-based feature means routing it through the scheduler. Lint catches `Date.now`, but not every slip.
