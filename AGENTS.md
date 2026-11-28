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
| 4 | Multi-node: remoting, membership, cluster sharding | Done — [spec](docs/milestone-4.md) |
| 5 | Rehearsal: deterministic simulation testing | In progress — [spec](docs/milestone-5.md) |

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
npm run test:cluster  # builds, then real processes from examples/cluster/ on TCP and Postgres
                      # (needs postgres:up): kill -9, restarts and graceful leaves, a few minutes
npm run cluster:up  # festival night in Docker Compose (docker-compose.cluster.yml): Postgres,
                    # three nodes and a crowd, built from this checkout; follows the narrated log
npm run cluster:down
npm run cluster:smoke  # the same in Docker: kills node-2, checks its shows fail over with their
                       # sales, starts it again, and removes it all. CI runs it
npm run build       # tsc → dist/
npm run bench       # the benchmark, against dist/ (build first); --quick for a smoke run
npm run rehearse    # builds, then festival night rehearsed on seeds across worker processes:
                    # --seeds a..b, --mode contract|chaos, --plant <bug>, --replay '<line>',
                    # --mix all|nodes|network|clocks|heavy, --ignore, --determinism-every n
                    # (scripts/rehearse.ts has them all)
npm run postgres:down
npm run demo:dev    # the demo site on Vite's dev server; demo:build builds it into demo/dist/
npm run example:backstage  # opening night in Node with serveBackstage; prints the URL
npm run test:e2e    # builds the package and the demo, then Playwright in Chromium
                    # (npx playwright install chromium)
npm run check:package  # after build, from a clean dist/: the tarball, publint and attw
scripts/smoke-published.sh [version|tgz]  # the README's quick start and Rehearsal example from npm,
                                          # in Docker, on Node 22, 24 and 26
npm run deploy      # the demo site to troupe.kylewillett.com; needs AWS, see DEPLOY.md
```

Before you say a task is done, run lint, typecheck, test, test:integration, coverage, build and check:package, and make sure they all pass. When `demo/`, `backstage/`, `e2e/` or the server changed, run test:e2e too. When `src/cluster/`, `src/node/cluster/` or `examples/cluster/` changed, run test:cluster too, and cluster:smoke when `examples/cluster/` or the compose file changed. The integration tests fail rather than skip when they can't reach Postgres, and in CI they need `TROUPE_POSTGRES_URL` set.

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
                    the inspection hook with the cluster's view for Backstage, and the cluster's
                    hooks (/system and children under it, lookup
                    by path, makeRef (0025), stopWhenIdle, and onTerminate, which runs the
                    cluster's leave between /user stopping and /system stopping (0030)), and the
                    bug Rehearsal plants on a system (T6, 0040)
  json.ts           what a JSON value is, once: the check events use (0014), with a ref hook for
                    the wire (0025)
  hash.ts           FNV-1a, the one string hash: Postgres lock keys (0016) and shard placement (0030)
  timeout.ts        withTimeout, the one timeout on a store call, on the caller's scheduler (0036)
  actor.ts, names.ts, events.ts, logger.ts, errors.ts, queue.ts
  scheduler.ts      Scheduler and realScheduler (0003)
  version.ts        the package's version, which a replay line carries (0039): change it with
                    package.json's on a release, which test/version.test.ts checks
  globals.d.ts      the runtime globals src/ may use (0004); in the build config only
  node/             Node-only entry points, built by tsconfig.build.node.json with Node types, and
                    the only place lint allows Node built-ins: sqlite/ is /persistence/sqlite (0017),
                    backstage/ is /backstage/server, serveBackstage() on node:http (0023), and
                    cluster/ is /cluster/tcp, tcpTransport() on node:net and node:crypto (0027)
  backstage/        the /backstage entry point (any runtime): backstage() the in-process source,
                    the protocol types, encode() the wire encoding, and the read-only requests
                    (0021). Protocol version 2: on a cluster node, hello.cluster and a `cluster`
                    frame whenever the node's view changes, read through internal.ts's cluster
                    view, so /backstage still loads nothing from /cluster
  testkit/          the /testkit entry point: ManualScheduler, seededRandom, createTestKit, TestProbe
  cluster/          the /cluster entry point (any runtime): wire.ts, the wire format (0025);
                    transport.ts, memory.ts (the in-memory network) and remoting.ts (0026);
                    table.ts, the member table, and membership.ts, joinCluster (0028), with
                    downing.ts, keep the majority (0042);
                    shard-store.ts (ShardStore and its checks), shard-memory.ts (the in-memory
                    store) and leases.ts, the holder's side of a lease (0029); placement.ts
                    (entity to shard, rendezvous owners), sharding.ts (init, entity refs),
                    region.ts (routing, finding shards a home, rebalancing and handoff) and shard.ts
                    (entities, passivation, draining and remembering) (0030); timed-store.ts, every
                    shard store call timed out after storeTimeoutMs (0036)
    postgres/       the /cluster/postgres entry point: postgresShardStore, any runtime, on the
                    journal's structurally typed pool (0029)
  persistence/      the /persistence entry point: the store interfaces,
                    backend.ts (the argument checks every backend shares), the in-memory backend,
                    persistentActor (actor.ts: effects, recovery, schemas, upcasters and tags),
                    projection (projection.ts), and the copied Standard Schema interface (0018)
    postgres/       the /persistence/postgres entry point: any runtime, on a structurally typed
                    pg pool it never imports (0016, 0017); pool.ts holds what it shares with
                    /cluster/postgres
  rehearsal/        the /rehearsal entry point, milestone 5 (any runtime): scenario.ts, scenario()
                    and a run's world: nodes on their clocks, the plan carried out, the workload
                    on simulation time, a process manager that restarts nodes that exit, and the
                    history recorded; plan.ts, faults as JSON, their checks, and drawing from the
                    plan stream; streams.ts, a stream per concern from one seed (0034);
                    history.ts, the history's entries and refs as JSON; invariants.ts, the seven
                    built-in invariants and what's expected past the lease's margin (0035);
                    clock.ts, a NodeClock per node on one simulation clock, with drift (setDrift)
                    and pauses, and
                    throughClock, which hands a node its frames through its clock; loop.ts, the
                    run loop that closes virtual time, and StallError; yield.ts, the one macrotask
                    it yields, on a MessageChannel (0033); network.ts, simulatedNetwork, a
                    Transport on simulation time with partitions, resets, delay and reordering,
                    and in chaos mode lost, reordered and repeated frames (0035); database.ts,
                    simulatedDatabase, a Persistence and a ShardStore on one endpoint, the
                    in-memory backends behind request and reply latencies, with slow spells,
                    hangs, errors, lost replies, cut-off nodes and clock jumps, and an observer
                    for the history; ranges.ts, the range and rate checks the network and the
                    database share; shrink.ts, shrinking a failing plan; replay.ts, the replay
                    line; rehearse.ts, rehearse() and replay(), with the per-seed pieces the
                    script's workers use; plants.ts, the planted bugs and each one's hunt (0040)
test/               mirrors src/; helpers/ holds deferred() and test actors (tree, watcher, idle),
                    the persistent account, faultyJournal() and faultySnapshots() for holding
                    and failing calls, postgres.ts (the test database, fresh schemas, and a
                    pool that holds a COMMIT or any statement), and cluster.ts (N nodes on one ManualScheduler and
                    one network, in memory, simulated, or TCP on loopback through tcp-network.ts,
                    with settle,
                    advance, start, kill, restart, terminate (which advances while the node hands
                    off) and hold (a promise settle should wait past), membership when asked for,
                    and with sharding one shard store every node shares, which a kill cuts the node
                    off from. With clocks, each incarnation gets a NodeClock that drifts, and
                    settle and advance go through Rehearsal's run loop. With database, the nodes
                    share a simulated database instead, each incarnation a client of it on its
                    own clock, which a kill closes; shutdown waits only for nodes not killed).
                    cluster/remoting-suite.ts is remoting's suite, run on all three networks,
                    and cluster/handoff.test.ts T7's passivation, rebalancing, handoff and
                    remembering
                    rehearsal/ tests Rehearsal's clocks, run loop and stalls, the simulated
                    network: on its own, as a property over random faults, and under clusters
                    (chaos.test.ts), the simulated database, its faults and both contract
                    suites on it (database.test.ts), plans and streams (plan.test.ts), the
                    history (history.test.ts), each invariant passing and failing
                    (invariants.test.ts), and milestone 4's in-process invariant scenario on
                    Rehearsal over 1,000 seeds, with the store that grants held leases it catches
                    (invariant.test.ts), shrinking, the replay line and rehearse
                    (rehearse.test.ts), and each planted bug's recorded hunt replayed
                    (plants.test.ts, with the hunts in planted.ts)
                    persistence/contract.ts is the journal contract every backend runs, and
                    cluster/shard-store-contract.ts the shard stores';
                    node/ tests the Node-only backends, lint.test.ts the lint config's boundaries,
                    readme.test.ts typechecks and runs the README's Rehearsal section against src/,
                    and package.test.ts the export lists that 1.0 promises (0039)
                    integration/ needs Postgres: its own Vitest project, run by test:integration
                    demo/ tests the demo's domain on the testkit and its driven clock, festival
                    night's on its in-memory cluster, festival night rehearsed (rehearsal.test.ts,
                    FESTIVAL_SEEDS seeds a mode, 100 by default), the bugs T7's hunt found, each
                    a regression plan (found.test.ts, with the plans in found.ts), the
                    write-up's data and record links, and the /rehearsal/ page's drawing, log,
                    runner (rehearsal-drawing.test.ts) and recorded runs (rehearsal-data.test.ts)
                    multiprocess/ runs examples/cluster/ as real processes on TCP and Postgres,
                    against dist/: its own Vitest project, run by test:cluster. harness.ts starts,
                    kills and restarts them and reads their JSON lines, and journal.ts checks the
                    journal afterwards: every acknowledged sale there, no two incarnations of a
                    show writing at once. rehearse.test.ts runs scripts/rehearse.ts
                    backstage-ui/ tests the Backstage UI's store and diff, with no browser
backstage/          the Backstage UI (React, plain CSS), with its own tsconfig for the browser.
                    Ships only as built files. npm run build puts index.html and src/standalone/,
                    the page serveBackstage serves, in dist/backstage-ui/, and src/mount.tsx, the
                    /backstage/ui entry point, in dist/backstage/ui/ with vite.ui.config.ts: one
                    file with React inside, and src/ui-api.ts, its API with no React type, as its
                    index.d.ts (0045). src/store/ turns frames into a view model with no React
                    and no clock of its own; src/ui/ draws it against a BackstageClient: the
                    demo's in-process ones, or src/http-client.ts. A cluster node gets a Cluster
                    panel, and the sharding tree above /user
demo/               the demo site (Vite, React, plain CSS), with its own tsconfig for the browser
  src/Backstage.tsx Backstage on the live pages, through /backstage/ui by name, as a page would (0045)
  src/domain/       opening night, with no React: shows, the crowd, the sales board, the faulty
                    journal, the driven clock (0022), the log's narration, and the Backstage client
                    that follows a restart. No Date.now or Math.random: it runs on virtual time
                    and seeded chance
  src/festival/     festival night, the site's third page (cluster/): domain/ has no React, and
                    runs opening night's shows as entities on three in-memory nodes and a crowd's
                    node, one ManualScheduler, journal and shard store (festival-night.ts), with
                    the log's narration, the cluster map (stage.ts) and the Backstage client for
                    the picked node. It loads none of opening night's page
  src/rehearsal/    Rehearsal, the site's fourth page (rehearsal/, 0044). domain/ has no React:
                    festival.ts, festival night as a Rehearsal scenario, festival({ mode, mix }),
                    which the tests, npm run rehearse and the page share; drawing.ts, a run's
                    history as lanes, bars, faults and the moment it broke, and trim(), what a
                    recorded run keeps; narrate.ts, its log in plain words; runner.ts, seeds and
                    drawings for the page's worker (worker.ts), which runs them off the main
                    thread. RunView.tsx draws a run with a scrubber
  src/writeup/      the write-up, "How Troupe works", the site's second page (how-it-works/):
                    the prose in TSX, citing records with <Record id>, and the SVG charts
  src/site/         what every page shares: the base styles, the site bar, the links, and
                    PostHog, which loads on idle and never under automation
  build/            writeup-data.ts reads the charts' numbers from docs/decisions/data/ when the
                    site builds, and rehearsal-data.ts the planted bugs' recorded runs, drawn
                    there, and the hunt's numbers. Either fails the build if a source is missing
e2e/                Playwright tests of the built demo, run by test:e2e, with its own tsconfig for
                    the DOM. cluster.spec.ts is festival night's, rehearsal.spec.ts Rehearsal's,
                    embed.spec.ts the built /backstage/ui on a plain page with dist/ alone,
                    and each *-phone.spec.ts runs at 375 px. frames.spec.ts runs in its own
                    project, after the others, and server.spec.ts in its own, against
                    examples/backstage on port 7071
examples/           runnable examples, run by Node with type stripping, against dist/: box-office/
                    (npm run example), backstage/ (npm run example:backstage), and cluster/,
                    festival night's node and crowd on TCP and Postgres, configured by environment
                    (env.ts), each writing one JSON line per event. story.ts tells those lines
                    in plain words, narrate.ts from `docker compose logs`, and the Dockerfile
                    builds the image docker-compose.cluster.yml runs
scripts/            run by Node with type stripping: write-sql.ts ships table SQL in dist/,
                    check-pack.ts checks the tarball, check-release-tag.ts the release tag,
                    cluster-smoke.ts the Docker Compose demo,
                    rehearse.ts npm run rehearse, across worker processes,
                    record-runs.ts the planted bugs' failing runs for /rehearsal/ (0044),
                    smoke-published.sh runs the quick start and the Rehearsal example against
                    the published package,
                    probe-macrotask.ts times the ways to yield a macrotask, in Node or Chromium
                    (0033),
                    deploy.sh deploys the demo site (DEPLOY.md)
deploy/             the deployer's IAM policy
bench/              the benchmark (0019), run by Node with type stripping against dist/; results
                    go in bench/results/ (ignored) or, for a recorded run, docs/decisions/data/.
                    cluster.ts has the cluster rows: the bench joins bench/peer.ts, or three
                    examples/cluster/ nodes, as a node that only routes
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

- Use the testkit (`createTestKit`, `ManualScheduler`) for anything time-based. Never use real sleeps or timers in tests. The only exceptions are tests of `realScheduler` itself, the dispatcher's yield test, the TCP transport's proof timeout, which is the socket's own timer, Rehearsal's run loop, which yields real macrotasks as `settle` does but never waits on a timer, and `test/multiprocess/`, whose processes run on real time. They must use real time, and should stay fast. The multi-process tests wait for the lines their processes write, and their only timers are deadlines. Tests on real sockets wait for events, never for a fixed time.
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
