# 0018. Event schemas use Standard Schema, with one upcaster per version step

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 2

## Context

A persistent actor's events outlive the code that wrote them. Recovery may replay an event years later, under a deployment whose event type has changed since. Two things can go wrong. A bug can write an event that `onEvent` can't fold, which then fails every recovery after it. Or an old event's shape no longer matches what `onEvent` expects. TypeScript's types don't exist at runtime, so neither is caught. The core has no runtime dependencies, so it can't pick a validation library for its users ([0004](0004-runtime-agnostic-core.md)).

## Decision

**Schemas are Standard Schema.** `events.schema` takes any `StandardSchemaV1<unknown, E>`, the interface that Zod, Valibot, ArkType and others implement. The interface is copied into `src/persistence/standard-schema.ts`, as its authors intend, so there's no dependency. Zod 4 is a devDependency, and the tests use it to prove the copy works with a real library.

- **On write**, every event a command persists is checked first. JSON comes first ([0014](0014-events-are-json.md)), then the schema, one event at a time, before the append. A failure is `EventValidationError` with the schema's issues. Nothing is written, because the batch is all or none.
- **On read**, an event stored at version *v* runs through `upcasters[v]`, `upcasters[v + 1]`, and so on up to the current `version`, and is then checked. A stored version above the current one is `EventVersionError`, which usually means an older deployment is reading a newer one's events.
- **The event is stored as `persist` got it, and `onEvent` gets the schema's output**, both on write and on recovery. The stored form is always a schema input, so it can be checked again on every read. A write and its replay fold the same value, even when the schema fills in defaults or strips fields.
- **Schemas may be async.** A validation is awaited only when there is a schema, so an actor without one starts its append in the same turn as the command, as before.
- **Upcasters are a record keyed by the version they upgrade from.** `persistentActor()` throws `TypeError` unless they cover exactly 1 to `version - 1`. A gap would leave some stored events unreadable. A key outside that range usually means `version` wasn't bumped along with a new upcaster.
- **Events are never rewritten.** An old event keeps its stored version, and the upcasters run on every read.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Depend on Zod or Valibot | A runtime dependency in the core, and it picks a library for every user. |
| A validator function of our own, `(e: unknown) => E` | Works, but every user writes an adapter, and libraries that already speak Standard Schema get nothing for free. |
| Store the schema's output instead of the input | The output may not be a valid input. A transform could turn a string into a `Date`, or strip a field the next schema needs, so the stored event couldn't be checked again on read. |
| One upcaster from any old version straight to the current one | Each new version would mean rewriting every old upcaster. A chain of single steps means each version adds one function and changes nothing before it. |
| Migrate events in place when the version changes | Breaks the append-only journal, races with other readers, and can't be undone. Rewriting is a later idea at best (retention and compaction are out of scope). |
| Upcast lazily, without a schema check after | `onEvent` would get unchecked old data, which is exactly the case the schema is there for. |

## Evidence

**T4 (2026-11-22):** `test/persistence/schemas.test.ts`
- A Zod schema rejects a bad event in a two-event batch with `EventValidationError`. The error carries Zod's issue at `['amount']`, no append reaches the journal, and the restarted actor carries on.
- A bad stored event fails recovery with `EventValidationError`, carrying its `seq`.
- A schema with a default stores `{ type, amount }` as given, and folds the output, with the default currency, both on write and after recovery in a fresh system.
- A hand-written async schema and Zod with an async refinement both return a promise from `validate`. Each accepts and rejects on write and on recovery.
- Version-1 events seeded in the journal are upcast to version 2 and pass the version-2 schema. A new event is stored at version 2, and the old ones keep version 1. A version-3 actor runs `1→2` then `2→3` for a version-1 event, and only `2→3` for version-2 ones.
- A stored version 3 under a version-2 actor fails recovery with `EventVersionError`, carrying the `seq` and `version`.
- Upcasters with a gap, an extra key, a key of 0, a non-integer key or a non-function, a version above 1 with none, and a schema without `~standard.validate` all throw `TypeError` from `persistentActor()`.
- `test/persistence/types.test.ts`: `E` is inferred from a schema's output, and a schema for other events is a type error.
- Each of these, removed in turn, fails a test: write validation, upcasting, the version check, the gap check, and folding the output rather than the input. The `actor.test.ts` mailbox test, which expects the append in the command's own turn, failed when the write path awaited without a schema.

## Consequences

- Any Standard Schema library works, and none is required. Without a schema, upcasters still run, and the types are the only claim about an event's shape.
- A schema runs on every replayed event, so a slow or async schema slows recovery. Snapshots ([T3](../milestone-2.md)) bound how many events that is.
- A transforming schema must be deterministic, or a replay could fold a different value than the write did.
- Snapshots don't get schemas or upcasters. A version mismatch throws the snapshot away, and recovery replays everything (milestone 2, open question 4).
