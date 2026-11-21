# 0012. Commands return effects, and state changes only through events

- **Status:** Accepted
- **Date:** 2026-11-21
- **Milestone:** 2

## Context

In event sourcing, the journal is the truth and the state is a fold over it. If a command handler can change the state directly, the state after a restart can differ from the state before it, and nothing warns you. The handler also needs to reply, but only once its events are safe, or a client could be told "done" about a write that never happened.

## Decision

`onCommand` is synchronous and returns an **effect**: an immutable value that lists the events to persist and the steps to run afterwards. It can't return a state. `onEvent` folds one event into the state, and is the only thing that changes it.

- The builders live on the context: `persist(...events)`, `reply(to, message)` and `none()`. An effect chains `thenReply(to, (state) => message)`, `thenRun((state) => ...)` and `thenStop()`. They're on `ctx` because a standalone `persist` couldn't infer the state type inside a chained `thenReply`, and they're arrow properties so `{ persist, reply }` destructures safely.
- Steps run in the order they were chained, after the events are applied, and get the new state. `thenStop()` is a step that calls `ctx.stop()`, so like `ctx.stop()` it takes effect after the current command: steps chained after it still run.
- An effect is an instance of a private class. A value that no builder made is a failure with `TypeError`, which also catches an `onCommand` that returns a state despite the types.
- `Effect.events` is public and read-only, so a test can check what a command decided without a journal.
- With no events, the steps run at once (0011).
- `onSignal` returns nothing, since state changes only through events. To change state in response to a signal, the actor sends itself a command.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `onCommand` returns `{ state, events }` | Two sources of truth: the returned state and the fold of the events can disagree, and only a restart shows it. |
| Akka classic's `persist(event)(callback)` inside an imperative `receive` | Callbacks capture mutable actor state, and nothing stops a handler from changing state outside them. |
| Standalone builder functions | `persist(e).thenReply(to, (s) => ...)` can't infer `S` there without type arguments on every call. |
| An async `onCommand` | It would hold the mailbox for arbitrary work, and its decision could depend on things that change while it waits. Async work goes through `pipeToSelf`, and comes back as a command. |

## Evidence

**T2 (2026-11-21):**
- `test/persistence/types.test.ts`: `C`, `E` and `S` are inferred from the definition. `persist` takes only `E`, `thenReply`'s callback gets `S`, `reply` checks the message against the ref's type, and an `onCommand` that returns a state doesn't compile.
- `test/persistence/actor.test.ts`, "runs thenReply, thenRun and thenStop in chained order": with the append held open, no step has run. Once it's released, the first step sees `closed: true`, the steps run in order, including the one chained after `thenStop`, and `stopped` comes after `persisted`.
- "a value from onCommand that no builder made" fails with `TypeError` and goes to supervision.
- Running the steps before the append fails 9 tests.

## Consequences

- A handler that needs to look something up must do it before the command, or with `pipeToSelf`. That's deliberate: decisions are replayable.
- Testing `onCommand` alone needs a context. Milestone 2's open question 5 decides in T8 whether the testkit should help.
