# 0017. Backends add no dependencies: `node:sqlite`, and a structurally typed `pg` pool

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 2

## Context

The core has no runtime dependencies, and decision 0005 says drivers are optional peer dependencies that only their own entry point imports. Persistence needs two real databases: SQLite for a single process with nothing to install, and Postgres for several. A driver dependency would weigh on every install, and a peer dependency still asks users to manage a version range we have to keep compatible.

## Decision

Neither backend adds a dependency of any kind.

- **SQLite** uses `node:sqlite`, which ships with Node. Node 22.13 and later load it without a flag, and the package's `engines` already require 22.18. It lives in `src/node/sqlite/`, the `./persistence/sqlite` entry point, built by `tsconfig.build.node.json` with Node types.
- **Postgres** takes the caller's own pool, typed structurally as `PgPool` (`query`, and `connect` returning a client with `query` and `release`), so the entry point never imports `pg`. `pg` is a devDependency for the tests only. The backend uses nothing but SQL, so it lives in `src/persistence/postgres/`, the `./persistence/postgres` entry point, and builds with no Node types: it runs wherever a pg-compatible pool does.

How the SQLite backend keeps the journal's promises:

- An append runs in `BEGIN IMMEDIATE`, which takes the database's write lock before it reads the stream's last sequence number. No other connection, in this process or another, can append between the check and the inserts. The check also rejects an `expectedSeq` ahead of the stream, which no unique key could. The unique key on `(persistence_id, seq)` stays as an integrity guard, and a violation would still surface as `JournalConflictError`.
- Offsets are an `AUTOINCREMENT` key, which SQLite never reuses. Appends hold the write lock, so offsets commit in order. SQLite has no equivalent of Postgres's problem in 0016.
- File databases use WAL mode, so readers don't block the writer. A connection waits up to 5 s for another's write lock.
- The table SQL is a TypeScript constant, the one source. The build writes it to `dist/node/sqlite/schema.sql` for people who manage migrations themselves.

How the Postgres backend keeps the journal's promises:

- An append takes a journal-wide advisory lock, then checks the stream's last sequence number, so offsets commit in order and two writers can't both win (0016).
- Events and snapshot states are stored as `json`, not `jsonb`. `jsonb` rejects strings that `JSON.stringify` produces and the other backends accept: `\u0000` and lone surrogates. `json` keeps the text as written, so every backend accepts the same values. Querying inside an event takes a `::jsonb` cast.
- Reads select the JSON columns as `::text` and parse them, and accept a `bigint` column as a string, number or `BigInt`. So the result doesn't depend on the type parsers the caller's pool is configured with.
- Ids and tags are checked, in every backend, for U+0000, which Postgres `text` can't hold, and for lone surrogates, which neither database's UTF-8 can hold. Either rejects with `TypeError` rather than being stored as something else.
- The table SQL is a TypeScript function of the schema name, the one source. The build writes the default schema's to `dist/persistence/postgres/schema.sql`, and `setup()` runs the same statements.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `better-sqlite3` | Fast and mature, but a native addon: a compile step or prebuilt binaries for every platform and Node version, as a dependency or peer. |
| `jsonb` for events and states | Indexable and queryable without a cast, but it rejects `\u0000` and lone surrogates, so Postgres would refuse events the other backends store. Key order isn't promised either way (0014). |
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

**T7 (2026-11-22), Postgres:**

- The journal contract suite passes against Postgres 18.3 through a `pg` `Pool`, in `npm run test:integration`, locally and in CI. The contract now round-trips `\u0000`, a lone surrogate and an astral character in an event, and rejects ids and tags with U+0000 or a lone surrogate, on every backend.
- A type test shows `pg.Pool` and `pg.PoolClient` fit `PgPool` and `PgPoolClient`. A pool whose type parsers return `BigInt` and parsed JSON gives the same results as the default one.
- Package tests show that `/persistence/postgres` loads only files from `dist/`, with no `pg` and no Node built-in, that neither the core nor `/persistence` loads anything from `node_modules`, and that the shipped `schema.sql` is the default schema's SQL.
- `package.json` still has no `dependencies` or `peerDependencies`. `pg` and `@types/pg` are devDependencies.

## Consequences

- No install step, native build or version range for either database.
- `node:sqlite` is synchronous. Each call does its work before its promise returns, and a writer waiting on another connection's lock blocks the thread for up to 5 s. That suits one process and a few, not heavy contention.
- Node 22 prints an experimental warning the first time `node:sqlite` loads. Node 24 and later don't. The README says so.
- `node:sqlite`'s API is still marked as in development on Node 22, so a Node upgrade could change it. CI runs every supported line.
- A structural pool type can't catch a pool that has the right shape but different behaviour, such as one that doesn't support transactions on a checked-out client. Only `pg` is tested.
- Tests need a real Postgres: `npm run postgres:up` starts one from `docker-compose.test.yml` on port 5440, and CI runs the same image as a service.
