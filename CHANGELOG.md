# Changelog

This project follows [Semantic Versioning](https://semver.org/). Under 0.x, a minor version can break the API, and it will in milestone 4. Each design choice behind these entries has a record in [docs/decisions](https://github.com/Fours/troupe/tree/main/docs/decisions).

## Unreleased (0.2.0)

Milestone 4: multi-node. Entries are added as its tasks land.

- `deadLetter`'s `reason` gains `unreachable`, `unserializable` and `invalid`, for messages that can't reach another node, can't be sent as JSON plus refs, or fail an entity type's schema. A `switch` over the reasons that has no `default` needs the new cases ([0025](https://github.com/Fours/troupe/blob/main/docs/decisions/0025-messages-on-the-wire-are-json-plus-refs.md)).
- `@kylewillett/troupe/cluster/tcp`: `tcpTransport({ port, host, advertise, secret })`, a transport for nodes in separate processes, on `node:net` with length-prefixed JSON frames. Peers prove a shared secret by challenge and response before anything else, and it never crosses the wire. It listens on `127.0.0.1` by default, and doesn't encrypt, so keep cluster traffic on a private network ([0027](https://github.com/Fours/troupe/blob/main/docs/decisions/0027-nodes-talk-tcp-with-a-shared-secret.md)).
- `@kylewillett/troupe/cluster`, for any runtime: `joinCluster(system, { name, transport, seeds })` joins a cluster through its seeds, and returns a `Cluster` with `self`, `members()`, `whenUp` and `leave()`. Membership is gossiped with no leader. Nodes heartbeat each other, a member unheard for `unreachableAfterMs` is unreachable, and one unreachable for `downAfterMs` more is downed, which ends watches on it. Only the first seed forms a cluster alone. It also exports `inMemoryNetwork({ scheduler, latencyMs })`, nodes in one process on one scheduler, and the `Transport` and `Connection` interfaces ([0028](https://github.com/Fours/troupe/blob/main/docs/decisions/0028-membership-is-gossiped-with-automatic-downing.md)).
- `SystemEvent` gains `memberUp`, `memberLeaving`, `memberDown`, `memberRemoved` and `reachability`, published only by a system in a cluster. A `switch` over event types that has no `default` needs the new cases ([0028](https://github.com/Fours/troupe/blob/main/docs/decisions/0028-membership-is-gossiped-with-automatic-downing.md)).
- `ctx.watch` and a probe's `watch` accept refs to actors on other nodes, and signal `terminated` when the actor stops or its node goes. Watching a ref that isn't an actor still throws `TypeError` ([0026](https://github.com/Fours/troupe/blob/main/docs/decisions/0026-remoting-is-at-most-once-behind-a-transport.md)).

## 0.1.1 (2026-11-23)

- The package's `homepage` is the demo site, <https://troupe.kylewillett.com/>, and the README links to the demo and to the design write-up, "How Troupe works", there. No code changed.

## 0.1.0 (2026-11-22)

The first published version. ESM only, for Node 22.18 or later, with no runtime dependencies. Everything but the SQLite backend and the Backstage server runs on any JavaScript runtime.

### Actors (`@kylewillett/troupe`)

- `actor({ initial, receive, onSignal })`: an actor is a plain-value state and a reducer, with one message type that its refs are checked against. It handles one message at a time, async `receive` included.
- `createActorSystem()`: a hierarchy under `/user`, with `spawn`, `stop`, death watch with `terminated` signals, and `terminate()`, which stops children before their parents.
- `ref.tell` never throws: a message that can't be delivered, to a stopped actor or a full bounded mailbox, becomes a `deadLetter` event. `ref.ask` replies through a temporary ref under `/temp`, and rejects with `AskTimeoutError` after `timeoutMs`.
- Supervision, chosen by the parent at spawn: `supervise.stop()`, `resume()`, `restart({ maxRestarts, withinMs })` and `restartWithBackoff({ minMs, maxMs, randomFactor, resetAfterMs })`. A restart is a new incarnation, with `preRestart` first.
- Keyed single and periodic timers that belong to one incarnation, and `pipeToSelf` for promises.
- A shared dispatcher that gives each actor a turn of `throughput` messages and yields to the host every `yieldAfter`.
- The event stream: `failed`, `restarted`, `deadLetter`, and, for persistent actors, `persisted` and `recovered`. `delivered` and `processed` events, with mailbox depth and a best-effort sender, go only to listeners that pass `{ messages: true }`.
- Time, scheduling and chance are injected: `scheduler` and `random` options, and `realScheduler()`, whose `now()` is whole milliseconds.

### The testkit (`/testkit`)

- `createTestKit({ seed })`: a system on virtual time (`ManualScheduler`) and seeded chance (`seededRandom`), with `settle()`, `advance(ms)`, and every event and log line recorded.
- `kit.probe()`: a `TestProbe` whose ref records what it's sent, with `expectMessage`, `expectNoMessage`, `watch` and `expectTerminated`.

### Persistence (`/persistence`, `/persistence/sqlite`, `/persistence/postgres`)

- `persistentActor`: commands return effects (`persist`, `reply` and `none`, with `thenReply`, `thenRun` and `thenStop` chained after a persist), and the mailbox waits while a write is in flight. On start and restart it recovers from its latest snapshot and the events after it, then gets `recoveryCompleted`.
- Snapshots (`snapshots: { every, version }`), tags on events, schemas through Standard Schema, and versioned events with upcasters. Events and state are checked as JSON when they're written.
- A sequence check on every append, so a second writer to the same stream fails with `JournalConflictError` instead of forking it.
- `projection`: reads events by tag and keeps its offset, at least once.
- Three backends that pass one contract suite: `inMemoryPersistence()`, `sqlitePersistence()` on Node's `node:sqlite`, and `postgresPersistence()` on a `pg`-compatible pool it never imports. Each ships its table SQL in `dist/`.

### Backstage (`/backstage`, `/backstage/server`)

- `backstage(system)`: an in-process source of the inspector protocol, which is JSON frames with refs as paths: a `hello` with the actor tree and recent history, then events, plus requests for an actor's state, a persistent actor's timeline, and its state at any sequence number. `encode()` is the wire encoding for messages and state. Backstage only watches.
- `serveBackstage(system)`: serves the Backstage UI, which ships built in the package, on `127.0.0.1:7070`, and streams the system to it with server-sent events. It refuses requests whose `Host` header doesn't name the address it serves.
