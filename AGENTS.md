# AGENTS.md

Guidance for coding agents working in this repo.

## Project

Troupe is an actor framework for TypeScript, in the spirit of Akka. It has typed actors with supervision, event-sourced persistent actors, and later cluster sharding and deterministic simulation testing. It's a portfolio project meant to show systems depth, made visible through a browser inspector and a demo site.

- Package: `@kylewillett/troupe`, one package with subpath exports ([0005](docs/decisions/0005-one-package-with-subpaths.md)). It's on npm from 0.1.0. Releases publish from CI when a `v*` tag is pushed, and only after you approve the tag in chat ([0024](docs/decisions/0024-publish-from-ci-with-provenance.md)). Never `npm publish` by hand.
- Full plan: [docs/roadmap.md](docs/roadmap.md)
- Milestone specs: `docs/milestone-N.md`. **Work only on the current milestone.** Don't build features from later milestones early, but don't block them either.
- Task status lives in the table at the top of each spec's "Tasks" section. When a task's "Done when" passes, mark it Done there and tick its `- [ ]` boxes in the same commit as the code. Fill in the Commit column with the short hash of the task's commit in the next commit, since a commit can't contain its own hash. When every task is done, update the milestone's row below and tick the spec's "Definition of done".

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Local typed actors: hierarchy, supervision, ask, timers, testkit with virtual time | Done — [spec](docs/milestone-1.md) |
| 2 | Event-sourced persistent actors: journals, snapshots, recovery | Done — [spec](docs/milestone-2.md) |
| 3 | Backstage inspector, demo app and site, first npm release | Done — [spec](docs/milestone-3.md) |
| 4 | Multi-node: remoting, membership, cluster sharding | In progress — [spec](docs/milestone-4.md) |
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
npm run bench       # the benchmark, against dist/ (build first); --quick for a smoke run
npm run postgres:down
npm run demo:dev    # the demo site on Vite's dev server; demo:build builds it into demo/dist/
npm run example:backstage  # opening night in Node with serveBackstage; prints the URL
npm run test:e2e    # builds the package and the demo, then Playwright in Chromium
                    # (npx playwright install chromium)
npm run check:package  # after build, from a clean dist/: the tarball, publint and attw
scripts/smoke-published.sh [version|tgz]  # the README quick start from npm, in Docker
npm run deploy      # the demo site to troupe.kylewillett.com; needs AWS, see DEPLOY.md
```

Before you say a task is done, run lint, typecheck, test, test:integration, coverage, build and check:package, and make sure they all pass. When `demo/`, `backstage/`, `e2e/` or the server changed, run test:e2e too. The integration tests fail rather than skip when they can't reach Postgres, and in CI they need `TROUPE_POSTGRES_URL` set.

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
  internal.ts       hooks for the other entry points, never exported: the start hook, ctx internals,
                    the inspection hook, and the cluster's (/system, lookup by path, makeRef) (0025)
  json.ts           what a JSON value is, once: the check events use (0014), with a ref hook for
                    the wire (0025)
  actor.ts, names.ts, events.ts, logger.ts, errors.ts, queue.ts
  scheduler.ts      Scheduler and realScheduler (0003)
  globals.d.ts      the runtime globals src/ may use (0004); in the build config only
  node/             Node-only entry points, built by tsconfig.build.node.json with Node types, and
                    the only place lint allows Node built-ins: sqlite/ is /persistence/sqlite (0017),
                    backstage/ is /backstage/server, serveBackstage() on node:http (0023)
  backstage/        the /backstage entry point (any runtime): backstage() the in-process source,
                    the protocol types, encode() the wire encoding, and the read-only requests (0021)
  testkit/          the /testkit entry point: ManualScheduler, seededRandom, createTestKit, TestProbe
  cluster/          milestone 4's cluster, not yet an entry point: wire.ts, the wire format (0025)
  persistence/      the /persistence entry point: the store interfaces,
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
                    demo/ tests the demo's domain on the testkit and its driven clock, and the
                    write-up's data and record links
                    backstage-ui/ tests the Backstage UI's store and diff, with no browser
backstage/          the Backstage UI (React, plain CSS), with its own tsconfig for the browser.
                    Ships only as built files: npm run build puts index.html and src/standalone/,
                    the page serveBackstage serves, in dist/backstage-ui/. src/store/ turns frames
                    into a view model with no React and no clock of its own; src/ui/ draws it
                    against a BackstageClient: the demo's in-process one, or src/http-client.ts
demo/               the demo site (Vite, React, plain CSS), with its own tsconfig for the browser
  src/domain/       opening night, with no React: shows, the crowd, the sales board, the faulty
                    journal, the driven clock (0022), the log's narration, and the Backstage client
                    that follows a restart. No Date.now or Math.random: it runs on virtual time
                    and seeded chance
  src/writeup/      the write-up, "How Troupe works", the site's second page (how-it-works/):
                    the prose in TSX, citing records with <Record id>, and the SVG charts
  src/site/         what both pages share: the base styles, the site bar, the links, and
                    PostHog, which loads on idle and never under automation
  build/            writeup-data.ts reads the charts' numbers from docs/decisions/data/ when the
                    site builds, and fails the build if a source is missing
e2e/                Playwright tests of the built demo, run by test:e2e, with its own tsconfig for
                    the DOM. frames.spec.ts runs in its own project, after the others, and
                    server.spec.ts in its own, against examples/backstage on port 7071
examples/           runnable examples, run by Node with type stripping, against dist/: box-office/
                    (npm run example) and backstage/ (npm run example:backstage)
scripts/            run by Node with type stripping: write-sql.ts ships table SQL in dist/,
                    check-pack.ts checks the tarball, check-release-tag.ts the release tag,
                    smoke-published.sh runs the quick start against the published package,
                    deploy.sh deploys the demo site (DEPLOY.md)
deploy/             the deployer's IAM policy
bench/              the benchmark (0019), run by Node with type stripping against dist/; results
                    go in bench/results/ (ignored) or, for a recorded run, docs/decisions/data/
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

`docs/decisions/` holds one numbered record per design choice: the context, the decision, the alternatives, the evidence and the consequences. They're also the public write-up, the demo site's "How Troupe works", which must cite every record: a new record needs a place in it. See `docs/decisions/README.md` for the format and the index.

- Read the related records before changing anything they cover.
- When you make or change a decision, add or update its record in the same commit as the code. Never rewrite an Accepted record. Supersede it with a new one instead.
- When a test proves a Proposed record, fill in its Evidence section and change its status to Accepted.
