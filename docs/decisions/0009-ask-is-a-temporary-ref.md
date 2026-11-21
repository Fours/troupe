# 0009. `ask` goes through a temporary ref and never fails fast

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

Request and reply is the most common thing an actor does, and `tell` alone makes it awkward: every caller has to be an actor, just to have a ref to reply to. `ask` gives code outside the system a promise of the reply. Two questions come with it. What does the target reply *to*? And what happens when no reply can come? Location transparency rules out any answer that only works because sender and receiver share memory.

## Decision

- `ref.ask(build)` creates a **temporary ref** under `/temp` (`/temp/$1`, `/temp/$2` and so on), passes it to `build`, and tells the message `build` returns to the target. The protocol is ordinary messages carrying a `replyTo`, so the target can't tell an ask from a request sent by another actor. A remote ref in milestone 4 can implement the same thing.
- The first reply resolves the promise. Every later reply, and any reply after a timeout, becomes a dead letter with reason `askCompleted`.
- **It never fails fast on a stopped target.** The message becomes a dead letter, and the ask rejects with `AskTimeoutError` (carrying the target path and `timeoutMs`) after `timeoutMs` of the scheduler's time. A remote ref can't know whether its target is alive, so local behaviour doesn't promise more.
- If `build` throws, `ask` rejects with that error, sends nothing and sets no timer. Bad options (`timeoutMs` that isn't a positive integer, or unknown fields) throw `TypeError` synchronously, because invalid options throw where they're passed in.
- **`terminate()` rejects every pending ask at once**, and every later one, with `ActorSystemTerminatedError`. Replies after that are `terminated` dead letters. This is knowledge about the asker's own system, not the target's, so it doesn't conflict with never failing fast.
- A temporary ref isn't an actor. It has no mailbox and publishes no `spawned` or `stopped` events.
- Every ref, whether it belongs to a cell, an ask or a probe, gets its `ask` from the same place, so any ref can be asked.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Fail fast when the local target has stopped | Faster feedback in one process, but code would come to rely on it and then break across a network in milestone 4 (milestone 1's open question 2 keeps this open). |
| Reject pending asks only once `/user` has stopped (the spec's first draft: "stops `/user`, then `/temp`") | Deadlocks. An actor whose async `receive` awaits an ask can't stop until that ask settles, so `/user` would wait for the asks and the asks would wait for `/user`, until each one timed out. |
| Spawn a real actor per ask | A mailbox, dispatcher turns and lifecycle events for every request, to hold one promise. It would also flood the event stream the inspector reads in milestone 3. |
| Infer the reply type from the protocol (for example, a `replyTo` field) | It would tie the API to a field name. TypeScript can't infer `R` from `build`'s return type, so callers write `ask<number>(...)` or annotate `replyTo`. A type test pins this down. |

## Evidence

**T5 (2026-11-20):** `test/ask.test.ts`:
- The first reply wins, later replies are `askCompleted` dead letters, and the timeout timer is cancelled.
- An ask is still pending at `timeoutMs - 1` and rejects at exactly `timeoutMs`, naming the target. The system default (`askTimeoutMs`, 5,000 ms) behaves the same way.
- Asking a stopped actor makes a `stopped` dead letter, stays pending, then times out.
- A `build` that throws rejects with its error, with no message, no timer and no events.
- `terminate()` rejects pending and later asks. An actor whose async `receive` awaits an ask stops without virtual time passing.
- Letting a second reply resolve, timing out 1 ms early, sending before `build` returns, or not rejecting on terminate each fails a test.

`test/types.test.ts`: `ask<number>` and an annotated `replyTo` infer `R`, and a bare `build` gives `unknown`.

## Consequences

- An actor that awaits `ask` to an actor that asks it back deadlocks until the ask times out (see 0002). `pipeToSelf` is the way out, and the README says so.
- Code that asks a stopped actor finds out only after the timeout, so timeouts should match how long a caller can afford to wait.
- Every pending ask holds a timer. With the real scheduler that keeps a Node process alive until the ask settles or `terminate()` rejects it.
