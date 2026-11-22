# AGENTS.md

Guidance for coding agents working in this repo.

## Project

Troupe is an actor framework for TypeScript, in the spirit of Akka. It has typed actors with supervision, event-sourced persistent actors, and later cluster sharding and deterministic simulation testing. It's a portfolio project meant to show systems depth, made visible through a browser inspector and a demo site.

- Package: `@kylewillett/troupe`, one package with subpath exports ([0005](docs/decisions/0005-one-package-with-subpaths.md)). It stays `"private": true` until the milestone 3 release, which publishes from CI. Never `npm publish` by hand.
- Full plan: [docs/roadmap.md](docs/roadmap.md)
- Milestone specs: `docs/milestone-N.md`. **Work only on the current milestone.** Don't build features from later milestones early, but don't block them either.
- Task status lives in the table at the top of each spec's "Tasks" section. When a task's "Done when" passes, mark it Done there and tick its `- [ ]` boxes in the same commit as the code. Fill in the Commit column with the short hash of the task's commit in the next commit, since a commit can't contain its own hash. When every task is done, update the milestone's row below and tick the spec's "Definition of done".

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Local typed actors: hierarchy, supervision, ask, timers, testkit with virtual time | Done — [spec](docs/milestone-1.md) |
| 2 | Event-sourced persistent actors: journals, snapshots, recovery | Done — [spec](docs/milestone-2.md) |
| 3 | Backstage inspector, demo app and site, first npm release | In progress — [spec](docs/milestone-3.md) |
| 4 | Multi-node: remoting, membership, cluster sharding | Not started |
| 5 | Rehearsal: deterministic simulation testing | Not started |

## Stack

- Node 22.18 or later (CI runs 22, 24 and 26), TypeScript in strict mode, ESM
- No runtime dependencies in the core
- Vitest for tests, ESLint and Prettier

## Commands

```bash
npm install
npm run lint
npm run typecheck   # editor config, then the build config with no Node types
npm test            # unit tests, no database needed
npm run postgres:up # the test Postgres from docker-compose.test.yml, on port 5440
npm run test:integration  # the Postgres backend; needs postgres:up or TROUPE_POSTGRES_URL
npm run coverage    # unit and integration together, enforces 90% lines on src/
npm run build       # tsc → dist/
npm run postgres:down
```

Before you say a task is done, run lint, typecheck, test, test:integration, coverage and build, and make sure they all pass. The integration tests fail rather than skip when they can't reach Postgres, and in CI they need `TROUPE_POSTGRES_URL` set.

## Layout

```
src/
  index.ts          public API: export only from here and testkit/index.ts
  types.ts          public types: ActorDef, ActorRef, ActorContext, ActorSystem, SystemEvent, options
  system.ts         createActorSystem (option checks, spawn) and createSystem (adds testkit internals)
  cell.ts           one actor: state, mailbox and system queue, children, stop and death watch (0002)
  dispatcher.ts     the shared ready queue, throughput turns, and yielding (0007)
  supervision.ts    supervise, option checks, and the strategy decision (0006, 0008)
  ask.ts            refs, ask and its temporary refs under /temp (0009)
  timers.ts         keyed timers, checked by generation when their messages are dequeued
  internal.ts       hooks for the other entry points, never exported: the start hook and ctx internals
  actor.ts, names.ts, events.ts, logger.ts, errors.ts, queue.ts
  scheduler.ts      Scheduler and realScheduler (0003)
  globals.d.ts      the runtime globals src/ may use (0004); in the build config only
  node/             Node-only entry points, built by tsconfig.build.node.json with Node types, and
                    the only place lint allows Node built-ins: sqlite/ is /persistence/sqlite (0017)
  testkit/          the /testkit entry point: ManualScheduler, seededRandom, createTestKit, TestProbe
  persistence/      the /persistence entry point: the store interfaces, the JSON-value check (0014),
                    backend.ts (the argument checks every backend shares), the in-memory backend,
                    persistentActor (actor.ts: effects, recovery, schemas, upcasters and tags),
                    projection (projection.ts), and the copied Standard Schema interface (0018)
    postgres/       the /persistence/postgres entry point: any runtime, on a structurally typed
                    pg pool it never imports (0016, 0017)
test/               mirrors src/; helpers/ holds deferred() and test actors (tree, watcher, idle),
                    the persistent account, faultyJournal() and faultySnapshots() for holding
                    and failing calls, and postgres.ts (the test database, fresh schemas, and a
                    pool that holds a COMMIT)
                    persistence/contract.ts is the journal contract every backend runs;
                    node/ tests the Node-only backends, lint.test.ts the lint config's boundaries
                    integration/ needs Postgres: its own Vitest project, run by test:integration
examples/           runnable examples, run by Node with type stripping
scripts/            build steps run by Node with type stripping: write-sql.ts ships table SQL in dist/
docs/               roadmap, milestone specs, decision records
```

## Rules that must hold

- **The core is runtime-agnostic** ([0004](docs/decisions/0004-runtime-agnostic-core.md)). No `node:*` imports, no `process`, `Buffer` or `setImmediate`, and nothing outside `src/globals.d.ts`. `tsconfig.build.json` has `"types": []` to enforce this. Node-only features get their own entry point.
- **Time, scheduling and chance are injected** ([0003](docs/decisions/0003-injected-scheduler-and-random.md)). The core reads time only through `scheduler.now()`, schedules only through the `Scheduler`, and draws chance only from the system's `random`. Never call `Date.now()`, `setTimeout` or `Math.random()` directly outside `realScheduler` and the default `random`.
- **One message at a time per actor**, async `receive` included ([0002](docs/decisions/0002-async-receive-blocks-the-mailbox.md)).
- **State is a plain value** ([0001](docs/decisions/0001-state-and-reducer-actors.md)). Don't design APIs that need functions or class instances in actor state.
- **Location transparency.** Nothing in the public API may assume that sender and receiver share memory. `ActorRef` stays an interface that a remote ref can implement in milestone 4.
- **`tell` never throws.** Undeliverable messages become dead letters.
- Event listeners and loggers can never break an actor: catch, log, carry on.
- Invalid options and names throw when they're passed in, never later.
- Don't add runtime dependencies. Drivers for later milestones are optional peer dependencies, imported only from their own entry point.

## Tests

- Use the testkit (`createTestKit`, `ManualScheduler`) for anything time-based. Never use real sleeps or timers in tests. The only exceptions are tests of `realScheduler` itself and the dispatcher's yield test, which must use real time, and should stay fast.
- Every behaviour listed in a milestone spec's "Done when" needs a test.
- Use `expectTypeOf` type tests for API typing claims, such as variance and inference.
- Keep line coverage on `src/` at 90% or higher.
- Prove that the important tests can fail. After a task's tests pass, temporarily break each key behaviour, such as message ordering, a timer generation check or a restart limit. Check that a test fails, then restore the code, and say in the commit message what you broke.
- Check runtime behaviour instead of assuming it. Before you design around how promises, microtasks or timers order themselves, run a quick probe on the installed Node, and turn what you find into a test.

## Style

- Strict TypeScript: no `any`, and no non-null `!` unless a comment explains why.
- Integer milliseconds everywhere.
- Keep functions small and pure where possible. I/O and scheduling belong at the edges.
- Write comments that explain why, not what.
- Every public export has a TSDoc comment.

## Commits

- Never add an attribution line for Claude or any other AI to commit messages. That includes `Co-Authored-By: Claude ...` trailers and "Generated with ..." footers.

## Design decisions

`docs/decisions/` holds one numbered record per design choice: the context, the decision, the alternatives, the evidence and the consequences. These records become the public write-up in milestone 3. See `docs/decisions/README.md` for the format and the index.

- Read the related records before changing anything they cover.
- When you make or change a decision, add or update its record in the same commit as the code. Never rewrite an Accepted record. Supersede it with a new one instead.
- When a test proves a Proposed record, fill in its Evidence section and change its status to Accepted.
