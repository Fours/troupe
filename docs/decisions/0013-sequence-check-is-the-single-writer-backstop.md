# 0013. The journal's sequence check is the single-writer backstop, and a failed write is settled by recovery

- **Status:** Accepted
- **Date:** 2026-11-21
- **Milestone:** 2

## Context

An entity's events must form one ordered stream. Two actors with the same persistence id can each believe they're the only writer: a supervisor's bug in one process, or, from milestone 4, two nodes that both think they own a shard. If both append, the stream forks. Separately, an append can fail in a way that leaves the actor unsure whether its events landed.

## Decision

Every append says which sequence number it follows, and the journal rejects it with `JournalConflictError` if the stream has moved on. A persistent actor appends at its own `lastSeq`, never at whatever the journal currently holds.

- The loser of a race fails like any other failure: its command is dropped, and its supervisor decides. After a restart it recovers, sees the winner's events, and carries on after them.
- **A failed append applies nothing.** The actor doesn't know what the journal holds, so it never guesses: it doesn't fold the events, publish `persisted` or run the steps. A restart recovers from the journal, which settles it. A stop leaves the journal as it is.
- Recovery checks that each event has the next sequence number, and fails with `JournalSequenceError` if a backend returns one out of order.
- Nothing assumes one process owns a persistence id. The check holds when two processes share a journal.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A registry of live persistence ids in the system | It only covers one process, and milestone 4 needs more. The journal check covers both, and a registry could still be added on top. |
| Retry the append at the journal's new sequence number | The events were decided from a state that's now out of date. Retrying would write a decision the actor never made. |
| Apply the events before the append, and undo them on failure | The actor can't know whether a timed-out write landed, so it can't know what to undo. |
| Akka's distributed single-writer guarantee | That needs cluster sharding and leases. It's milestone 4's job, and the sequence check stays as its backstop. |

## Evidence

**T2 (2026-11-21):** `test/persistence/actor.test.ts`:
- "two writers": `a` and `b` share a persistence id. `b` recovered before `a`'s write, so its append at 0 fails with `JournalConflictError` and its ask times out. After a restart, `b` reads balance 10 and appends at 1. The stream holds sequence numbers 1 and 2, with no gaps or duplicates.
- "a rejected append, which applies nothing": the restarted actor still has the balance from before, and the journal has only the earlier event.
- "an event out of sequence during recovery" fails with `JournalSequenceError` carrying `expected: 1, got: 2`.
- `test/persistence/determinism.test.ts` replays a conflict and restarts under jittered backoff to identical events.
- Appending at the journal's current length instead of the actor's `lastSeq` fails the two-writers test, the determinism test and the ordering test. Dropping the sequence check in recovery fails the out-of-sequence test.

## Consequences

- Two writers under a restart strategy take turns failing until one stops. That's noisy, but correct. Milestone 4's shard leases make it rare.
- A failed append costs a full recovery. Snapshots (T3) keep that cheap.
- Every backend must implement the check atomically. The journal contract suite tests each one.
