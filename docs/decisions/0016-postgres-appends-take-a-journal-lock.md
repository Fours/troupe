# 0016. Postgres appends take a journal-wide lock, so tag offsets commit in order

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 2

## Context

A projection stores one number, the highest offset it has handled, and next time reads only what comes after it. That works only if the journal keeps a promise: once a reader has seen offset *n*, no event with a lower offset can appear later.

Postgres doesn't keep that promise by itself. An identity column (or any sequence) hands out values when a row is inserted, not when its transaction commits, and sequences aren't transactional. Transaction A can draw offset 10, transaction B draw 11 and commit, a projection read 11 and store it, and then A commit 10. The projection never sees event 10. SQLite has no such gap, because an append holds the database's write lock from before it draws an offset until it commits (0017).

## Decision

Every append runs in one transaction, in this order:

1. `BEGIN ISOLATION LEVEL READ COMMITTED`
2. `pg_advisory_xact_lock(class, key)`: a transaction-scoped advisory lock for the whole journal
3. the stream's `MAX(seq)`, which must equal `expectedSeq`, or the append rejects with `JournalConflictError`
4. one statement that inserts the batch's events and their tags, drawing offsets in batch order
5. `COMMIT`, which releases the lock

Only one append in a journal can be between steps 2 and 5, so offsets are drawn and committed in the same order. Postgres makes a commit visible before it releases the transaction's locks, so the next writer's offsets are always higher than everything already visible.

- **The key.** The first key is a constant ("TRUP"), and the second is a 32-bit FNV-1a hash of the schema name, computed in TypeScript. Each journal (schema) in a database gets its own lock. The hash isn't Postgres's undocumented `hashtext`, so every process computes the same key whatever the server version. A collision makes two journals share a lock, which costs throughput, never correctness.
- **Read committed, always.** Under repeatable read or serializable, a transaction's snapshot is taken at its first statement, before it waits for the lock, so step 3 would miss what committed while it waited and fail an append that should win. The backend asks for read committed, whatever the database's default.
- **The sequence check runs under the lock**, so it settles every race between writers, and it also rejects an `expectedSeq` ahead of the stream. The unique key on `(persistence_id, seq)` stays as a backstop, and a violation (SQLSTATE 23505) also becomes `JournalConflictError`.
- **`setup()` takes the same lock**, because two concurrent `CREATE TABLE IF NOT EXISTS` can still race in Postgres and one fails.
- The clock is read before the transaction, so no user code runs while the lock is held.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Gap detection in the reader, as Akka Persistence JDBC does | A reader that sees a gap below the highest offset has to wait and re-read until the gap fills or a timeout says it never will, because a rolled-back transaction leaves a permanent gap. Correct but intricate, with a timeout to tune. Open question 3 keeps it as the fallback if the lock proves too slow. |
| Read only up to the oldest open transaction's position (`pg_snapshot_xmin`, as some event stores do) | Needs a transaction-id column on every event and a snapshot query on every read. More moving parts than a lock, for a reader-side guarantee the lock gives directly. |
| A table-level `LOCK TABLE ... IN EXCLUSIVE MODE` | The same serialization, but it also blocks other sessions' reads of the table in some modes and lives in the catalog. An advisory lock touches nothing but itself. |
| A per-stream lock | Keeps two writers to one stream apart, which the sequence check already does, but doesn't order offsets across streams, which is the whole problem. |
| `SERIALIZABLE` transactions | Serializable doesn't order commits by sequence values. It also turns contention into serialization failures that callers would have to retry. |

## Evidence

**T7 (2026-11-22), Postgres 18.3, `npm run test:integration`:**

- **Exact interleaving.** A pool wrapper holds the first append's `COMMIT` after it has drawn its offset. A second append, on another stream and another pool, waits for the lock instead of committing (the test watches `pg_locks`), a follower reading the tag sees nothing, and once the first commits, both appear in offset order. Removing the lock from `append` fails this test: the second commits first, at a higher offset.
- **Under load.** Eight writers on two pools append to eight streams with one shared tag, while a follower re-reads the whole tag in a loop. No offset ever appears below one the follower had already seen. Removing the lock fails this test too.
- **Read committed.** With a pool whose default isolation is serializable, an append that waits for the lock behind an uncommitted one still sees that event after the wait and wins. Changing `BEGIN ISOLATION LEVEL READ COMMITTED` to `BEGIN` fails it.
- **Concurrent writers.** Six writers on two pools, 25 attempts each, on one stream: every attempt succeeds or rejects with `JournalConflictError`, and the stream is exactly 1..n, with one event per success. Skipping the sequence check fails the contract's "ahead of the stream" test.
- **`setup()`** run twice at once, on two pools, succeeds. Removing its lock fails that test.
- The journal contract suite passes against Postgres.

## Consequences

- Offsets commit in order, so a projection's single stored number is always enough, on Postgres as on the other backends.
- Every append in a journal is serialized: one at a time, for the length of the transaction, including its round trips. The insert is one statement for the whole batch to keep the lock short. This caps write throughput per journal. Milestone 3's benchmark should measure it (open question 3). Two journals in separate schemas don't contend.
- Reads take no lock and never wait.
- A writer that dies holding the lock releases it when Postgres ends its session or transaction. A connection that hangs mid-append holds up every other writer until Postgres or the pool times it out, which is the journal-timeout question deferred to milestone 5.
