# 0010. `pipeToSelf` of an ask is delivered by the system, not through a promise

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

`settle()` waits for every pending `pipeToSelf` promise, because a piped promise is usually real async work that finishes on its own. An ask isn't like that. It completes only through a reply, which is system work, or through its timeout, which is a virtual timer. So while an actor had piped an ask that would time out, `settle` waited for something that couldn't happen without time passing. It threw `SettleTimeoutError`, and so did `advance`, which settles between due times. T6's determinism scenario hit this the first time it ran. Piping an ask is the pattern the spec recommends over awaiting one, so the testkit has to support it.

## Decision

- The asker remembers each promise it returns. When `pipeToSelf` is given one of them, it registers a listener with the asker instead of waiting on the promise. The asker calls the listener synchronously when the ask settles: on the reply, the timeout, a `build` that throws, or `terminate()`. A piped ask therefore runs entirely on the scheduler and doesn't count as busy for `settle`.
- The result is queued in the mailbox the moment the reply is told, ahead of anything the replier sends next. Before this decision, it was queued one promise hop later. The mapper still runs inside the actor, when the envelope is dequeued.
- The pipe still attaches a rejection handler to the ask's promise, so a timed-out piped ask isn't an unhandled rejection.
- Anything else passed to `pipeToSelf`, including a promise derived from an ask (such as `ask(...).then(f)`), is waited on as before and counts as busy.
- An async `receive` that awaits an ask still blocks its mailbox and counts as busy (decision 0002). If that ask can complete only by timing out, `settle` throws `SettleTimeoutError`. When asks are pending, the error message suggests piping the ask instead. This is the deadlock pitfall the README warns about, and the testkit now reports it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Let `settle` return when it makes no progress for a tick while an ask is pending | It's a heuristic. Any other busy work, such as real I/O, would be cut short whenever an unrelated ask happened to be pending, and tests would become flaky. |
| Stop counting `pipeToSelf` as busy at all | `settle` would no longer wait for piped real promises, which the T6 spec requires. |
| Make `advance` ignore `SettleTimeoutError` between due times | It would hide real hangs, and plain `settle` would still fail on a piped ask. |
| Have tests drive `scheduler.advanceTo` by hand around piped asks | It makes the recommended pattern the hardest one to test. |

## Evidence

**T6 (2026-11-20):** `test/pipe.test.ts`, "pipeToSelf of an ask":

- `settle` returns while a piped ask is pending. Its `AskTimeoutError` arrives at exactly `timeoutMs` under `advance`, and not 1 ms earlier.
- A reply is queued ahead of a message told right after it.
- An ask that settled before it was piped is delivered, and so is one whose `build` threw.
- `terminate()` delivers the rejection. The actor is stopping by then, so the result is a dead letter.

`test/determinism.test.ts` pipes an ask that times out during a backoff delay, under `advance`.

`test/testkit/kit.test.ts` checks that `SettleTimeoutError` suggests `pipeToSelf` when a busy actor may be awaiting an ask.

Making the asker report every promise as unknown, so piped asks go back through the promise, fails three of the piped-ask tests.

## Consequences

- The recommended pattern for request and reply between actors works under `settle` and `advance` with no extra steps.
- The asker keeps a `WeakMap` from each ask's promise to its outcome, so an ask that nobody pipes costs one small object.
- With a real scheduler, a piped ask's result now reaches the mailbox a microtask earlier than before. Nothing depended on the old timing.
- A remote ref in milestone 4 has to settle its asks through the same asker, or piped remote asks will count as busy again.
