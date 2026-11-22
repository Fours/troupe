# 0017. Backends add no dependencies: `node:sqlite`, and a structurally typed `pg` pool

- **Status:** Proposed
- **Date:** 2026-11-22
- **Milestone:** 2

## Context

The core has no runtime dependencies, and decision 0005 says drivers are optional peer dependencies that only their own entry point imports. Persistence needs two real databases: SQLite for a single process with nothing to install, and Postgres for several. A driver dependency would weigh on every install, and a peer dependency still asks users to manage a version range we have to keep compatible.

## Decision

Neither backend adds a dependency of any kind.

- **SQLite** uses `node:sqlite`, which ships with Node. Node 22.13 and later load it without a flag, and the package's `engines` already require 22.18. It lives in `src/node/sqlite/`, the `./persistence/sqlite` entry point, built by `tsconfig.build.node.json` with Node types.
- **Postgres** takes the caller's own pool, typed structurally as `PgPool` (`query` and `connect`), so the entry point never imports `pg`. `pg` is a devDependency for the tests only. (T7)

How the SQLite backend keeps the journal's promises:

- An append runs in `BEGIN IMMEDIATE`, which takes the database's write lock before it reads the stream's last sequence number. No other connection, in this process or another, can append between the check and the inserts. The check also rejects an `expectedSeq` ahead of the stream, which no unique key could. The unique key on `(persistence_id, seq)` stays as an integrity guard, and a violation would still surface as `JournalConflictError`.
- Offsets are an `AUTOINCREMENT` key, which SQLite never reuses. Appends hold the write lock, so offsets commit in order. SQLite has no equivalent of Postgres's problem in 0016.
- File databases use WAL mode, so readers don't block the writer. A connection waits up to 5 s for another's write lock.
- The table SQL is a TypeScript constant, the one source. The build writes it to `dist/node/sqlite/schema.sql` for people who manage migrations themselves.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `better-sqlite3` | Fast and mature, but a native addon: a compile step or prebuilt binaries for every platform and Node version, as a dependency or peer. |
| `pg` as a peer dependency | Users already have `pg`. Typing the pool structurally gets the same result with no version range to maintain, and lets pg-compatible pools work. |
| A unique key alone as the SQLite sequence check | It catches two writers at the same `expectedSeq`, but not an append whose `expectedSeq` is ahead of the stream, which would leave a gap. |
| Read the SQL from a `.sql` file at runtime | Ties the module to a file beside it, which bundlers and the Postgres entry point (any runtime, no `fs`) can't rely on. |

## Evidence

**T6 (2026-11-22), SQLite:**

- The journal contract suite passes on `:memory:` and on a temp file, in `npm test`, on Node 22, 24 and 26 in CI.
- Two instances on one file, used in turn, keep one stream 1..n. The stale one gets `JournalConflictError`, then recovers by reading. Skipping the sequence check under the lock fails that test and the contract's conflict tests.
- Reopening a file finds every event, tag, snapshot and projection offset, and new offsets continue past the old ones. Opening `:memory:` regardless of `path` fails those tests.
- Package tests show that `/persistence/sqlite` loads only `dist/` and `node:sqlite`, that neither the core nor `/persistence` loads `node:sqlite`, and that `dist/node/sqlite/schema.sql` creates a database the backend can use.
- `package.json` still has no `dependencies` or `peerDependencies`.

**Still to prove (T7):** the Postgres half, once the contract passes against a real pool with `pg` only in devDependencies, and a package test shows the entry point never imports `pg`.

## Consequences

- No install step, native build or version range for either database.
- `node:sqlite` is synchronous. Each call does its work before its promise returns, and a writer waiting on another connection's lock blocks the thread for up to 5 s. That suits one process and a few, not heavy contention.
- Node 22 prints an experimental warning the first time `node:sqlite` loads. Node 24 and later don't. The README says so.
- `node:sqlite`'s API is still marked as in development on Node 22, so a Node upgrade could change it. CI runs every supported line.
