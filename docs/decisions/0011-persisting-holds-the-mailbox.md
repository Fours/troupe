# 0011. Persisting and recovery hold the mailbox, so the mailbox is the stash

- **Status:** Accepted
- **Date:** 2026-11-21
- **Milestone:** 2

## Context

A persistent actor's state is whatever its journal says. While an append is in flight, the actor doesn't know yet whether its events will land. While it recovers, it doesn't have a state at all. A command that runs in either window decides from a state that may be wrong. Akka Persistence handles this with a stash: commands that arrive during a persist or recovery are moved aside and replayed afterwards. Decision 0002 already gives troupe a simpler tool: an async `receive` holds the mailbox until it settles.

## Decision

Persisting and recovery hold the mailbox, and the mailbox itself is the stash.

- **Persisting.** When `onCommand` returns events, the persistent actor's `receive` returns a promise that settles once the append succeeds, the events are applied, and the steps have run. The cell holds the mailbox until then (0002), so later commands wait in order, and each one sees the state after the one before.
- **No events, no wait.** `reply` and `none` effects run their steps synchronously, and `receive` returns the state directly. Reads don't pay for a promise hop.
- **Recovery.** The cell has an internal start hook: an async step that runs after `initial` and before any message, holding the mailbox, with its failures treated as `initial`'s. A persistent actor recovers there, so commands sent right after `spawn` wait for it. The hook is keyed by a symbol in `src/internal.ts` that no entry point exports, so it's not public API.
- While the mailbox is held, the system queue is held too, as for any async `receive`. A stop during a persist or recovery takes effect once it settles.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A separate stash buffer, as Akka does | Two queues to keep in order, a second capacity limit, and dead-letter rules for both. The mailbox already queues in order and already has those rules. |
| `persistAsync`: keep taking commands while a write is in flight | Commands would decide from a state that may never be written. It's a throughput option for later, if ever. |
| Reject or dead-letter commands during recovery | Every sender would need to retry after a restart, which is what supervision is meant to hide (0008). |
| Expose the start hook as public `ActorDef` API | Milestone 1 chose a synchronous `initial` so user actors load state through persistent actors. A public async start would bring that back. |

## Evidence

**T2 (2026-11-21):** `test/persistence/actor.test.ts`:
- "holds commands sent during a persist": with the append held open by `test/helpers/faulty-journal.ts`, three more commands get no reply and reach no append. Once it's released they run in order, appending at 1 and then 2, and reply 15 and then 12.
- "holds commands sent right after spawn": commands sent before recovery has had a microtask see the recovered balance of 30, and `recovered` comes before `persisted`.
- "persists nothing for reply and none": four commands are all answered in one synchronous `scheduler.runReady()`, while a persist can't finish in one.
- Returning the state without awaiting the append fails 13 tests. Not holding the mailbox for the start hook fails 16.

## Consequences

- A slow journal slows the entity, one command at a time. That's the price of deciding from a known state, and milestone 3's benchmark will show it.
- A journal call that never settles leaves the actor busy for good. Milestone 2's open question 2 tracks that.
- Milestone 4's sharding spawns a persistent actor like any other actor: the hold is entirely inside the cell.
