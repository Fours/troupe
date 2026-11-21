# 0014. Events and snapshot states are JSON values, checked before they're written

- **Status:** Accepted
- **Date:** 2026-11-21
- **Milestone:** 2

## Context

A persistent actor's events are replayed on every recovery, possibly years later, by another deployment, from SQLite or Postgres. Whatever goes in must come back the same, from every backend. `JSON.stringify` quietly changes many values: `undefined` disappears, a `Date` becomes a string, a `Map` becomes `{}`, `NaN` becomes `null`, and a class instance loses its prototype. If that happens at write time, the actor sees one state now and a different one after its next restart. Decision 0001 already says state is plain data, but nothing enforced it.

## Decision

Events and snapshot states must be **JSON values**: what `JSON.parse` could have produced. That means `null`, booleans, strings, finite numbers, arrays without holes, and plain objects (prototype `Object.prototype` or `null`) with string keys, whose values are JSON values too, and with no cycles.

- `src/persistence/json.ts` checks this. `jsonProblem(value)` names the first part that fails, as a path like `$.items[2]`, so the error says where the problem is.
- Backends check every event and snapshot state before writing anything. A failure rejects with `TypeError`, and because the whole batch is checked first, nothing is written.
- The persistent actor runs the same check before it appends (T2), and before it saves a snapshot (T3), so the failure lands in the command that produced the value.
- Every backend stores JSON text and parses it again on read, the in-memory one included. A test on the in-memory backend sees what Postgres would give back, and no reference the caller kept can change a stored value.
- Object key order isn't kept, because Postgres's `jsonb` reorders keys.
- `-0` passes, because `JSON.parse('-0')` gives `-0`, but it comes back as `0`. Rejecting it would fail commands that compute a negative zero, and no reasonable fold tells the two apart.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Store whatever `JSON.stringify` makes of the value | The silent changes above. A bug that shows only after a restart is the worst kind to find. |
| `structuredClone` and a binary encoding | Keeps `Date` and `Map`, but `structuredClone` isn't in every runtime's standard library (0004), Postgres would need `bytea`, and milestone 3's inspector couldn't read events. |
| A codec per event type | More flexible, but it makes the simple case heavy. Schemas and upcasters (0018) already cover evolution. |
| Check only in development | The cost is one walk of the value, which is small next to a database write. |

## Evidence

**T1 (2026-11-21):**
- `test/persistence/json.test.ts` covers what passes (including `-0`, null-prototype objects and a shared, non-cyclic reference) and what fails, with the path it names for each.
- The journal contract in `test/persistence/contract.ts` checks that events and snapshot states come back deep-equal, that a batch with one non-JSON event writes nothing, and that changing the input or a result afterwards doesn't change what's stored. The in-memory backend passes it.
- Letting a half-checked batch commit, or handing out stored tags by reference, fails the contract.

**T2 (2026-11-21):** `test/persistence/actor.test.ts`, "an event that isn't JSON": a command that persists an event with `amount: NaN` fails with a `TypeError` naming `$.amount is NaN`, before any append reaches the journal. Supervision restarts the actor, and its state is unchanged.

## Consequences

- Users can't keep a `Date` in an event. They store `at: date.getTime()` or an ISO string instead. The README says so.
- Every write walks the value once more. Cheap, but milestone 3's benchmark will show the cost.
- Milestone 4's wire format can reuse the same check for messages.
