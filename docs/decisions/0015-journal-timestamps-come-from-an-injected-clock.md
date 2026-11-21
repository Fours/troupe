# 0015. Journal timestamps come from an injected wall clock, and never order anything

- **Status:** Accepted
- **Date:** 2026-11-21
- **Milestone:** 2

## Context

People and projections want to know when an event happened. But decision 0003 says the core never reads real time behind the scheduler's back, and `scheduler.now()` can't serve: it's monotonic, it starts anywhere, and it means nothing outside one process or across a restart. Two processes sharing a journal would stamp incomparable times.

## Decision

Each backend takes a `clock` option, a function that returns wall-clock time in integer milliseconds. It defaults to `Date.now`. The backend stamps every appended event, and every saved snapshot, from that clock. Callers never pass a timestamp in, so `SnapshotStore.save` takes a `NewSnapshot` (`seq`, `version`, `state`), and `load` returns a `Snapshot` with the backend's `timestamp`.

Timestamps are for people and for projections that care about wall time. Nothing orders by them. Streams are ordered by `seq`, and the journal by `offset`.

- Lint still bans `Date.now` in `src/`. Each backend's default clock is the one allowed exception, with a comment naming this record.
- A clock that returns anything but a non-negative safe integer makes the call reject with `TypeError`, and nothing is written.
- One append calls the clock once, so all the events in a batch share a timestamp.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `scheduler.now()` | Monotonic and process-local, so it's meaningless in a database another process reads. |
| The database's own clock (`now()` in Postgres) | Tests couldn't control it, and the in-memory and SQLite backends would need a different answer. |
| No timestamps | Projections and the inspector's timeline want them, and every event store has them. |
| Let the caller pass a snapshot's timestamp | The actor has only `scheduler.now()` to pass, which is the problem above. |

## Evidence

**T1 (2026-11-21):** The journal contract's "timestamps come from the given clock" test moves a hand-driven clock between appends and a snapshot save, and checks each stamp. A batch's events share one stamp. Making the in-memory backend read `Date.now()` instead of its clock fails that test. A separate test checks the `Date.now` default, and another that a fractional clock reading rejects the append and writes nothing.

## Consequences

- Tests get exact, repeatable timestamps by passing a clock.
- Wall clocks jump, so a later event can carry an earlier timestamp. That's harmless, because nothing orders by it, but projections that bucket by time should know.
- Milestone 5's simulated journal can pass a clock derived from virtual time.
