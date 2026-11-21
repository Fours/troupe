# 0002. An async `receive` holds the mailbox until it settles

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

TypeScript developers will write `async receive` and `await` inside it. If the next message ran while an `await` was pending, two messages would interleave inside one actor. That breaks the actor model's main promise: one message at a time, with no locks.

## Decision

When `receive` (or `onSignal`) returns a promise, the actor is busy until the promise settles. Its next message waits, while other actors keep running. For work that shouldn't block the mailbox, `ctx.pipeToSelf(promise, map)` turns the result into a later message.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A synchronous `receive` only, with `pipeToSelf` for all async work (Akka's way) | Correct, but awkward for simple cases. Users would write `async` anyway, and lose ordering without noticing. |
| Running the next message while an `await` is pending | Interleaving inside one actor brings back the race conditions that actors exist to remove. |

## Evidence

T2 will prove it: a test where an actor's next message waits for its pending promise, while a second actor's messages run in the meantime.

**T2 (2026-11-20):** `test/dispatcher.test.ts`, "holds the mailbox until the promise settles, while other actors run", settles each promise by hand with a deferred, so the order is exact rather than timed:
- While `slow-1` is pending, `slow-2` waits, and a second actor handles two messages.
- Once the gates open, `slow-1` finishes before `slow-2` starts.
- Letting `run()` ignore the busy flag fails this test and two others.

## Implementation notes

- The cell counts busy actors for the testkit, and `settle()` waits until there are none. So a test that holds a promise open on purpose must drive `kit.scheduler.runReady()` itself until it releases the promise.

## Consequences

- An actor that awaits `ask` to an actor that asks it back deadlocks until the ask times out. The README warns about this, and recommends `pipeToSelf`.
- An async `receive` that never settles leaves its actor stuck (milestone 1's open question 3). The testkit's `settle` throws in that case.
- Milestone 2's persist-then-reply flow gets the ordering it needs for free.
