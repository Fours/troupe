# 0038. A pipe with a signal ends when the signal aborts, so it isn't busy work for `settle`

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

`settle` waits for every piped promise except an ask, because a piped promise is usually real async work that finishes on its own ([0010](0010-piped-asks-stay-on-the-scheduler.md)). Some piped work only ends when the actor ends it. Steadfast runs each tool call in a child actor that pipes `tool.run(input, ctx)` and starts a timer that aborts the tool's `AbortSignal` after `timeoutMs`. A tool that finishes only when it's aborted leaves the child busy until time passes, and time can't pass while it's busy, so `advance` threw `SettleTimeoutError`. It's 0010's deadlock again, for a promise bounded by the actor's own timer rather than by an ask's timeout. Steadfast's tests worked around it by driving `runReady` and `advanceTo` by hand, which is the alternative 0010 rejected.

## Decision

`pipeToSelf` takes a third argument, `{ signal }`.

- When the signal aborts, the pipe queues `map({ ok: false, error: signal.reason })` at once, without waiting for the promise. Abort listeners run synchronously inside `abort()`, so the result is in the mailbox before `abort()` returns. Whichever of the promise and the abort comes first wins, and the other is ignored. A rejection that comes later is still handled. A signal that has already aborted delivers its reason at once.
- A pipe with a signal isn't busy work. The signal is what bounds it, and the actor aborts it from one of its timers or from `postStop`, which run on the scheduler. So `settle` doesn't wait for it, `advance` lets time move on to the timer that ends it, and Rehearsal's run loop doesn't count it toward a stall.
- `settle` still gives pending pipes with a signal one event-loop turn when nothing else is busy, and loops again if that turn ran anything. A stub tool that has already settled, or settles after a chain of microtasks, is delivered before `settle` returns, as an unsignalled pipe would be.
- The signal is a structural `PipeSignal`: `aborted`, `reason`, and `addEventListener` and `removeEventListener` for `'abort'`. Every runtime's `AbortSignal` fits it, and the core needs no DOM or Node types ([0004](0004-runtime-agnostic-core.md)). Options are checked where they're passed in.
- A piped ask with a signal ends at whichever comes first: the reply, its timeout, or the abort.
- `pipeToSelf` without a signal is unchanged. It's still busy work, as 0010 decided.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A flag, `{ busy: false }`, with no signal | It states that something will end the pipe but doesn't make it so. A tool that ignores its signal would leave the actor waiting for a result forever. With the signal, the pipe ends at the abort whatever the promise does. |
| An `advance` that lets time pass while pipes are pending | It's the no-progress heuristic 0010 rejected. Real I/O would be cut short whenever time was advanced, for every actor, not only those that opted in. |
| Waiting for no pipe at all, without the one turn | A test whose stub tool resolves at once would see `settle` return before the result arrived, and would have to settle twice. |
| Having the system abort the signal when the actor stops | The actor owns the controller, and may not want a stop to cancel the work. `postStop` can abort it in one line. |
| Driving `runReady` and `advanceTo` by hand around such pipes | It makes the recommended pattern, a timeout on the actor's own timer, the hardest one to test. |

## Evidence

`test/pipe.test.ts`, "pipeToSelf with a signal":

- A child pipes a tool that ends only when aborted and aborts it from a 50 ms timer. Under `advance`, nothing arrives at 49 ms, and the signal's reason arrives at 50 ms, ahead of the tool's own rejection.
- A tool that ignores its signal and never settles is ended at the abort.
- A stub tool that has already resolved, and one that resolves after 1,000 microtasks, both arrive within one `settle`, at 0 ms.
- A promise that settles first is delivered, its abort listener is removed, and a later abort does nothing. After an abort, a late rejection is handled and delivers nothing, not even a dead letter.
- A signal that has already aborted delivers its reason at once.
- `shutdown` finishes with a pipe still pending, and one aborted in `postStop` becomes a dead letter, since the actor has stopped.
- A piped ask with a signal ends at the abort, well before its timeout, and is answered normally when the reply comes first.
- Unknown options, and a `signal` that isn't an abort signal, throw `TypeError` at the call.

`test/rehearsal/loop.test.ts`: a pipe with a signal pending for 5 s, well past `stallAfterMs`, isn't a stall, and its abort at 5,000 ms is delivered. `test/types.test.ts` checks that `AbortSignal` fits `PipeSignal`.

Counting a pipe with a signal as busy fails eight of these tests. Taking away `settle`'s one turn fails the stub tool test. Not ending the pipe at the abort fails six. Not dropping the second outcome fails the late rejection test, and not delivering an already aborted signal fails its test.

## Consequences

- An actor that bounds its own work with a timer can be tested with `settle` and `advance` and nothing else. Steadfast's tool calls, run deadlines and backoff are the first users.
- A signal nobody aborts, on a promise that is real I/O, lets `settle` return while the I/O is still running. That's what the actor asked for by passing a signal, and the TSDoc says to abort it from a timer or `postStop`.
- An abort listener stays on the signal until the pipe ends. A pipe that never ends keeps it until the controller is collected.
