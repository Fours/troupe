# Troupe: roadmap

Troupe is an actor framework for TypeScript, in the spirit of Akka. It has typed actors with supervision, event-sourced persistent actors for aggregates and entities, and later a distributed version with cluster sharding. It's a learning project and a portfolio piece, so each milestone should end in something a reviewer can run and see.

Each milestone gets a full spec in `docs/milestone-N.md` when it starts. This page is the plan those specs are written from, so it describes outcomes and scope, not detailed design.

## Why it exists

The space is crowded, so Troupe aims to stand out rather than win on features. As of mid-2026:

| Project | What it is | Why Troupe is different |
| --- | --- | --- |
| Nact | Akka-inspired Node actors with persistence and a Postgres journal | Mostly dormant for years |
| Comedy | Node actors that can spread across processes and hosts | Dormant |
| `@effect/cluster` | Sharding, entities and durable workflows on Effect | You have to adopt Effect across the whole codebase |
| XState v5 | Actors built around statecharts, mostly for front ends | No cluster or event-sourced persistence |
| Dapr actors (JS SDK) | Virtual actors through a sidecar | Needs the Dapr runtime |
| Cloudflare Durable Objects, Rivet Actors | One live instance per ID, with storage | Tied to a platform, or an actor model of a different shape |
| Restate, Temporal | Durable execution | A different model aimed at the same "reliable stateful entity" problem |
| Emmett | Event sourcing for Node with the decider pattern | No actors or runtime |

The angles Troupe leans into:

1. **Akka-style typed actors in plain TypeScript.** async/await, discriminated-union protocols, a small API, no effect system.
2. **Deterministic simulation testing.** A whole simulated cluster in one process, with virtual time, injected faults and seed replay, in the style of FoundationDB and TigerBeetle. JavaScript's single thread makes this easier than it is on the JVM.
3. **A visual inspector.** A live actor tree, mailbox depths, message flow, and each entity's event timeline with time-travel replay.
4. **Self-hostable.** Plain Node and Postgres, on any host.

## Decisions so far

- **Actors are state plus a reducer:** `receive(state, msg, ctx)` returns the next state. State is a plain value, which keeps snapshots, the inspector and replay simple ([0001](decisions/0001-state-and-reducer-actors.md)).
- **The core is runtime-agnostic.** No Node built-ins in the core, so the demo and inspector can run the real framework in a browser. Node-only pieces get their own entry points ([0004](decisions/0004-runtime-agnostic-core.md)).
- **One npm package with subpath exports:** `@kylewillett/troupe`, `/testkit`, and later `/persistence`, `/cluster` and so on ([0005](decisions/0005-one-package-with-subpaths.md)).

## Theme names

These names come from the theatre, for parts of the project:

- **Rehearsal:** the deterministic simulation harness (milestone 5).
- **Backstage:** the visual inspector (milestone 3).
- **Understudy:** a standby or failover for sharded entities (milestone 4, if it's built).

## Milestones

| # | Milestone | Shippable? |
| --- | --- | --- |
| 1 | Local typed actors: spawn, tell and ask, a hierarchy, supervision, timers, a testkit with virtual time | Library only |
| 2 | Event-sourced persistent actors: journal interface, SQLite and Postgres journals, snapshots, recovery | Library only |
| 3 | Backstage inspector, a demo app, and a public demo site. First npm release | **Yes: first portfolio point** |
| 4 | Multi-node: serialization, remoting, membership, cluster sharding with Postgres leases | Yes |
| 5 | Rehearsal: deterministic simulation testing with fault injection | Yes |

Stopping after milestone 3 still leaves a complete project. Milestones 4 and 5 are a bonus, not a requirement.

### 1. Local typed actors

**Outcome:** in one process, you define typed actors, spawn them into a hierarchy, send with `tell`, and request and reply with `ask`. Failed actors are stopped, resumed or restarted by their supervision strategy. Timers deliver messages to their actor. A testkit runs all of it on virtual time.

Scope:

- Actor definitions (state plus reducer), `ActorRef<M>`, `ActorContext<M>`, `createActorSystem()`
- One message at a time per actor, including async `receive`
- Parent and child hierarchy, paths and names, stop that recurses, death watch
- Supervision: stop, resume, restart with limits, restart with backoff
- `ask` with timeouts, keyed timers, `pipeToSelf`
- Dead letters, and a system event stream (the basis for the inspector)
- An injected scheduler for all time and task scheduling, with a manual, virtual-time one in the testkit
- Testkit: `TestProbe`, `settle()`, `advance(ms)`
- An example app and a README

Spec: [milestone-1.md](milestone-1.md).

### 2. Event-sourced persistent actors

**Outcome:** an aggregate such as a bank account or a shopping cart is a persistent actor. Commands are validated and turned into events. The events go to a journal, and the actor's state is rebuilt from them on start. Two writers to one entity can't corrupt its event stream.

Scope:

- `persistentActor({ id, initial, onCommand, onEvent })`, the command, event and state shape. `onCommand` returns effects such as `persist(events)`, `reply`, `none` and `stop`, and `onEvent` is a pure fold.
- A `Journal` interface: append with an expected sequence number (optimistic concurrency), and read from a sequence number.
- Journals: in-memory (in the testkit), SQLite, and Postgres, as optional peer dependencies under `/persistence`. These are the first Node-only entry points.
- Snapshots every N events, and recovery from the latest snapshot plus the events after it.
- Commands are stashed while recovery runs and while a persist is in flight.
- Runtime schemas for events, through the Standard Schema interface so any validation library works. Plan for schema evolution (upcasters), even if only one version ships.
- Tagged events and a minimal projection: read by tag from an offset, with the offset stored. Keep this small, since projections can grow into a project of their own.
- A shared journal contract test suite that every journal runs, like the algorithm contract in rate-limiter.

Out of scope: distributed single-writer guarantees, which are milestone 4. The journal's sequence check is the safety net that catches a second writer until then.

Spec: [milestone-2.md](milestone-2.md).

### 3. Backstage inspector, demo app and demo site

**Outcome:** a visitor opens a web page and watches a running Troupe system. It shows the actor tree, mailboxes filling and draining, a supervisor restarting a crashed child, and an entity's event timeline, which can be scrubbed back through time. No backend is needed, because the core runs in the browser.

Scope:

- An inspector protocol: system events plus state snapshots, streamed from a system to a UI. In the browser it's in-process. For a Node system, it's a small WebSocket server under its own entry point.
- Backstage UI (React and Vite): a live tree, per-actor details (state, mailbox depth, recent messages), the failure and restart history, and a per-entity event timeline with time-travel replay.
- A demo app on top: an event-sourced domain with enough moving parts to be worth watching. Choose the domain when this milestone is specced.
- A message throughput benchmark (ping-pong, fan-out), with the setup recorded, as a performance baseline.
- The first npm release (0.x), published from CI with provenance, as in rate-limiter. Remove `private` from package.json.
- A demo site at `troupe.kylewillett.com`, deployed the portfolio's way (S3, CloudFront, `npm run deploy`), with PostHog.
- A design write-up built from `docs/decisions/`.

### 4. Multi-node

**Outcome:** several Node processes form a cluster. Entities are addressed by ID from any node, and each one lives on exactly one node at a time. When a node dies, its entities come back on the others, recovered from the journal.

Scope:

- Serialization: message and event codecs from runtime schemas, with refs that serialize as an address plus a path.
- Remoting: a transport between nodes (WebSocket or TCP) and location-transparent `ActorRef`s.
- Membership, starting with a static seed list and heartbeats. SWIM or gossip with phi-accrual failure detection is an optional stretch.
- Cluster sharding: entity ID to shard to node. **Shard ownership is held by Postgres leases** instead of a consensus protocol, and the journal's sequence check stays as the backstop.
- Passivating idle entities, rebalancing when nodes join or leave, and remembering entities.
- A local multi-node setup (Docker Compose) and a kill-a-node demo.
- Stretch goals: a split-brain strategy, and Understudy standbys.

The key invariant: **at most one live instance per entity ID.** Every design choice here is checked against it.

### 5. Rehearsal: deterministic simulation testing

**Outcome:** a test runs thousands of seeded simulations of a whole cluster in one process: nodes, network, journal and clock. Faults are injected (partitions, crashes, message loss, delay, reordering, slow disks). After each run, invariants are checked, such as one writer per entity and no lost acknowledged events. Any failure replays exactly from its seed.

Scope:

- A simulated network, journal and clock, on the same injected scheduler milestone 1 introduces
- A fault plan, generated from a seed
- An invariant checker and a history recorder
- Seed replay and failure shrinking
- A write-up of the bugs it found

This milestone is why every source of time, randomness and I/O is injected from milestone 1 on.

## Later ideas (unscheduled)

- A worker-threads dispatcher, for actors that are heavy on CPU
- OpenTelemetry tracing across `tell` and `ask`
- Durable timers and reminders for persistent entities
- Routers and pools
- A browser-to-server transport, so the same actors run on both ends
