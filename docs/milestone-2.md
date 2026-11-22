# Milestone 2: Event-sourced persistent actors

Source: [roadmap](roadmap.md), Milestones → 2.

## Outcome

In one process, you can:

- define an aggregate, such as a bank account or a show's seat map, as a persistent actor
- validate a command and turn it into events, which go to a journal before the actor replies
- stop or crash the actor, or the whole process, and get the same state back from the journal
- snapshot the state every N events, so recovery doesn't replay the whole history
- tag events and follow a tag with a projection that remembers how far it has read
- run all of this on an in-memory journal in any runtime, or on SQLite or Postgres in Node

Two writers to one entity can't corrupt its event stream. Every append says which sequence number it expects to follow, and the journal rejects the loser. The loser fails, and its supervisor decides what happens next.

**Demo at the end:** `npm run example` runs the box office again, with each show now a persistent actor on a SQLite file. Mallory's malformed request still crashes `hamlet`, which restarts with backoff. This time the show recovers Carol's hold from the journal, so her confirm succeeds. Then the example terminates the system, starts a fresh one on the same file, and shows every show coming back with its sales. Milestone 1's demo ended on the forgetting, and this one ends on the remembering.

## Scope

In scope:

- `persistentActor()`: commands, events, state, and the effects `onCommand` returns
- Recovery on start and on every restart, with commands held in the mailbox until it's done
- Commands held in the mailbox while a persist is in flight
- The `Journal`, `SnapshotStore` and `OffsetStore` interfaces, and a `Persistence` backend that groups them
- Three backends: in-memory (runtime-agnostic), SQLite (`node:sqlite`, Node only) and Postgres
- Snapshots every N events, and recovery from the latest snapshot plus the events after it
- Runtime event schemas through the Standard Schema interface, with versioned upcasters
- Tags, `readByTag` from an offset, and a minimal projection that stores its offset
- A journal contract suite that every backend runs
- `persisted` and `recovered` system events
- The `/persistence`, `/persistence/sqlite` and `/persistence/postgres` entry points, with the build, lint and package-test plumbing for a Node-only entry point
- The persistent box office example, and README sections

Out of scope (later milestones):

| Item | Milestone |
| --- | --- |
| Distributed single-writer guarantees (shard leases). Until then, the journal's sequence check is the backstop | 4 |
| Codecs for messages and refs on the wire | 4 |
| Throughput benchmarks for the journals | 3 |
| Inspector views of an entity's timeline | 3 |
| A simulated journal with injected latency and faults | 5 |
| Durable timers and reminders | Later |
| Deleting events, retention, and compacting the journal | Later |
| Exactly-once projections (storing the offset in the handler's own transaction) | Later |
| `persistAsync` (persisting without holding the mailbox) | Later, if ever |

Design for these without building them. In particular:

- The `Journal` interface is promise-based and knows nothing about Node, so milestone 5 can implement it on the scheduler.
- A persistent actor is an ordinary `ActorDef`, so milestone 4's sharding spawns it like any other actor.
- Nothing assumes one process owns a persistence id. The sequence check holds when two processes share a journal.

## Design

### Defining a persistent actor

A persistent actor is a command handler, an event handler and an initial state. The command handler decides, and the event handler folds ([0001](decisions/0001-state-and-reducer-actors.md)):

```ts
import { createActorSystem, supervise, type ActorRef } from '@kylewillett/troupe';
import { inMemoryPersistence, persistentActor } from '@kylewillett/troupe/persistence';

type Receipt = { ok: true; balance: number } | { ok: false; reason: string };

type AccountCmd =
  | { type: 'deposit'; amount: number; replyTo: ActorRef<Receipt> }
  | { type: 'withdraw'; amount: number; replyTo: ActorRef<Receipt> }
  | { type: 'balance'; replyTo: ActorRef<number> };

type AccountEvent = { type: 'deposited'; amount: number } | { type: 'withdrawn'; amount: number };

interface Account { balance: number }

const persistence = inMemoryPersistence();

const account = (id: string) =>
  persistentActor<AccountCmd, AccountEvent, Account>({
    id: `account-${id}`,
    persistence,
    initial: { balance: 0 },
    onCommand(state, cmd, { persist, reply }) {
      switch (cmd.type) {
        case 'deposit':
          return persist({ type: 'deposited', amount: cmd.amount })
            .thenReply(cmd.replyTo, (s) => ({ ok: true, balance: s.balance }));
        case 'withdraw':
          if (cmd.amount > state.balance) return reply(cmd.replyTo, { ok: false, reason: 'insufficient funds' });
          return persist({ type: 'withdrawn', amount: cmd.amount })
            .thenReply(cmd.replyTo, (s) => ({ ok: true, balance: s.balance }));
        case 'balance':
          return reply(cmd.replyTo, state.balance);
      }
    },
    onEvent(state, event) {
      switch (event.type) {
        case 'deposited':
          return { balance: state.balance + event.amount };
        case 'withdrawn':
          return { balance: state.balance - event.amount };
      }
    },
  });

const system = createActorSystem();
const ref = system.spawn(account('42'), 'account-42', {
  supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }),
});
```

```ts
export function persistentActor<C, E, S>(def: PersistentActorDef<C, E, S>): ActorDef<C, PersistentState<S>>;

export interface PersistentActorDef<C, E, S> {
  /** The event stream's id in the journal. */
  id: string;
  /** Where events, snapshots and offsets are kept. */
  persistence: Persistence;
  /** The state before any event. */
  initial: S;
  /** Decides what a command does. Synchronous, and returns an effect. */
  onCommand(state: S, command: C, ctx: PersistentContext<C, E, S>): Effect<E, S>;
  /** Applies one event. Pure: it runs again for every event on every recovery. */
  onEvent(state: S, event: E): S;
  /** Lifecycle signals, for side effects only. Optional. */
  onSignal?(state: S, signal: PersistentSignal, ctx: PersistentContext<C, E, S>): void;
  /** The tags to store with an event, for projections. Optional. */
  tags?(event: E): readonly string[];
  /** Runtime checks and versions for events. Optional. */
  events?: EventOptions<E>;
  /** Snapshotting. Optional. Needs `persistence.snapshots`. */
  snapshots?: { every: number; version?: number };
}

/** What a persistent actor's cell holds: plain data, so milestone 3 can show it. */
export interface PersistentState<S> { readonly seq: number; readonly state: S }
```

- `persistentActor()` returns an ordinary `ActorDef`. It's spawned with `spawn`, named and supervised like any other actor, and its parent chooses its strategy ([0006](decisions/0006-supervision-chosen-at-spawn.md)). The README recommends backoff for persistent actors, because a journal that's down fails every recovery until it's back.
- **One definition per entity.** The `id` is part of the definition, so a module exports a function from an entity's id to its definition, as `account` does above.
- **State changes only through events** ([0012](decisions/0012-commands-return-effects.md)). `onCommand` can't return a new state, only events to persist. `onEvent` must be pure and must not throw for any event it has accepted before, since it replays on every recovery.
- **`onCommand` is synchronous.** It decides from the state and the command alone. Async work, such as calling a payment service, goes through `ctx.pipeToSelf`, and its result comes back as a command.
- Invalid options throw `TypeError` from `persistentActor()`, not later. That includes an empty `id`, an `id` longer than 255 characters, `snapshots` without `persistence.snapshots`, a non-positive `every`, and upcasters that don't cover every version below the current one.

### Effects

```ts
export interface PersistentContext<C, E, S> extends ActorContext<C> {
  /** The persistence id. */
  readonly persistenceId: string;
  /** The sequence number of the last event applied, 0 before any. */
  readonly lastSeq: number;
  /** Persists these events, in order, then applies them. */
  readonly persist: (...events: E[]) => Effect<E, S>;
  /** Persists nothing, and replies at once. */
  readonly reply: <R>(to: ActorRef<R>, message: R) => Effect<E, S>;
  /** Persists nothing. */
  readonly none: () => Effect<E, S>;
}

/** An immutable value describing what a command does. Each method returns a new effect. */
export interface Effect<E, S> {
  /** The events it persists. Read-only, so a test can check a decision without a journal. */
  readonly events: readonly E[];
  /** After the events are applied, tells `to` the message built from the new state. */
  thenReply<R>(to: ActorRef<R>, message: (state: S) => R): Effect<E, S>;
  /** After the events are applied, runs `fn` with the new state. */
  thenRun(fn: (state: S) => void): Effect<E, S>;
  /** After everything else, stops the actor. */
  thenStop(): Effect<E, S>;
}
```

- The builders live on `ctx` so they're typed by the definition. Standalone functions couldn't infer `S` inside `thenReply` when the call is chained. A type test checks that `persist` takes only `E`, that `thenReply`'s callback gets `S`, and that `reply` checks the message against the ref's type.
- The builders are arrow properties, so `onCommand(state, cmd, { persist, reply })` destructures safely.
- `persist()` with no events is the same as `none()`.
- `ctx.stop()` still works as it does in milestone 1. `thenStop()` is the way to stop after a persist, since it waits for the write. It's a step that calls `ctx.stop()`, so like `ctx.stop()` it takes effect after the current command, and steps chained after it still run.
- `PersistentActorDef` grows task by task, as milestone 1's interfaces did. T2 has `id`, `persistence`, `initial`, `onCommand`, `onEvent` and `onSignal`, and an unknown field, such as `snapshots` before T3, throws `TypeError`.
- If `onCommand` returns anything these builders didn't make, that's a failure with a `TypeError`.

**What a command does, in order:**

1. `onCommand` runs and returns an effect.
2. With no events, the effect's steps run at once with the current state, and the actor takes its next message. Nothing waits.
3. With events, each one is checked: it must be a JSON value ([0014](decisions/0014-events-are-json.md)), and it must pass the schema, if there is one. Then the tags are worked out, and the events are appended at `lastSeq`.
4. While the append is in flight, the actor holds its mailbox, so later commands wait ([0011](decisions/0011-persisting-holds-the-mailbox.md)).
5. Once the append succeeds, `onEvent` folds each event into the state, `lastSeq` moves on, and a `persisted` event is published.
6. The steps run, in the order they were chained, with the new state. Replies are `tell`s.
7. If a snapshot is due, it's saved without holding the mailbox.

**Failures.** Each of these is a failure that supervision handles, like a throw in `receive`. The command is dropped, so its asker times out.

- `onCommand` or a step throws
- an event isn't JSON, or fails its schema
- the append rejects: `JournalConflictError` when another writer got there first, or the backend's own error when the write failed
- `onEvent` throws

When an append fails, the actor doesn't know what the journal holds, so it never guesses. A restart recovers from the journal, which settles it. A stop leaves the journal as it is ([0013](decisions/0013-sequence-check-is-the-single-writer-backstop.md)).

### Recovery

Recovery runs when the actor starts and on every restart, before any command:

1. If the definition has `snapshots`, the latest snapshot is loaded. If its version matches, the state and `lastSeq` start from it. Otherwise they start from `initial` and 0. A snapshot that fails to load is logged at `warn`, and recovery replays every event instead, because a snapshot is only a shortcut.
2. Events after `lastSeq` are read in pages of 256. Each one must have the next sequence number. Its event is upcast to the current version, checked against the schema, and folded with `onEvent`.
3. A `recovered` event is published, and `onSignal` gets `{ type: 'recoveryCompleted', seq }`.
4. The commands that arrived during recovery run, in order.

A failure in step 2 is a failure in the actor's start, the same as a throw in `initial`. Supervision handles it, and a restart tries recovery again.

**The core change.** In milestone 1, `initial` is synchronous, and the first message can arrive before any async work could run. Recovery needs an async step that runs after `initial` and before any message, holding the mailbox, with its failures treated as `initial`'s. The cell gets this as an internal hook, keyed by a symbol that isn't exported. It's not public API: user actors still load state through persistent actors, as milestone 1 intended.

```ts
export type PersistentSignal = Signal | { readonly type: 'recoveryCompleted'; readonly seq: number };
```

- `onSignal` gets `preRestart`, `postStop` and `terminated` as in milestone 1, plus `recoveryCompleted`. It returns nothing, because state changes only through events. To change state in response to a signal, send yourself a command.
- `recoveryCompleted` is where an actor restarts the timers its state implies, since timers don't survive a restart. A throw there is a failure in the start, like a failed recovery.
- While the mailbox is held for a persist or recovery, so is the system queue, as for any async `receive`. A stop takes effect once the write or recovery settles.

### The journal

```ts
export interface Journal {
  /**
   * Appends events after `expectedSeq`, all or none. Rejects with JournalConflictError when the
   * stream's last sequence number isn't `expectedSeq`.
   */
  append(persistenceId: string, expectedSeq: number, events: readonly NewEvent[]): Promise<void>;
  /** The stream's events from `fromSeq` on, in order, at most `limit`. */
  read(persistenceId: string, fromSeq: number, limit: number): Promise<readonly StoredEvent[]>;
  /** Events with `tag`, after `afterOffset`, in offset order, at most `limit`. */
  readByTag(tag: string, afterOffset: number, limit: number): Promise<readonly StoredEvent[]>;
}

export interface NewEvent {
  readonly event: unknown;   // a JSON value
  readonly version: number;
  readonly tags: readonly string[]; // no duplicates
}

export interface StoredEvent extends NewEvent {
  readonly persistenceId: string;
  readonly seq: number;       // 1, 2, 3, ... per stream, with no gaps
  readonly offset: number;    // increasing across the whole journal
  readonly timestamp: number; // wall-clock ms, from the backend's clock
}
```

- **Sequence numbers** start at 1 and have no gaps. `append` with `expectedSeq: 0` creates the stream. A conflict writes nothing.
- **Offsets** increase across the journal, but may skip numbers. Once a reader has seen offset *n*, no event with a lower offset can appear later. That's what lets a projection store one number. Postgres needs work to keep this promise ([0016](decisions/0016-postgres-appends-take-a-journal-lock.md)).
- **Timestamps** come from the backend's `clock` option, which defaults to `Date.now` ([0015](decisions/0015-journal-timestamps-come-from-an-injected-clock.md)). They're for people and projections, never for ordering. `scheduler.now()` can't serve, because it's monotonic and means nothing outside one process. The backend stamps snapshots too, so callers never pass a timestamp in.
- **Invalid arguments** reject with `TypeError` and write nothing: an event or snapshot state that isn't JSON, a repeated tag on one event, an empty id or tag, or a sequence number, offset or limit that isn't a safe integer in range. Checking the tag *pattern* is the persistent actor's job (T5).
- **JSON in, JSON out.** Every backend stores events and snapshot states as JSON, and gives back values that are deep-equal to what went in. Object key order isn't kept, since Postgres's `jsonb` reorders keys. The in-memory backend round-trips through JSON too, so a test on it sees what Postgres would.
- Numbers from the database (`bigint` columns) come back as JavaScript numbers. They're always safe integers.

```ts
export interface SnapshotStore {
  /** Saves a snapshot. Ignored if the stored one has a higher `seq`. */
  save(persistenceId: string, snapshot: NewSnapshot): Promise<void>;
  /** The latest snapshot, if there is one. */
  load(persistenceId: string): Promise<Snapshot | undefined>;
}

export interface NewSnapshot {
  readonly seq: number;
  readonly version: number;
  readonly state: unknown;     // a JSON value
}

export interface Snapshot extends NewSnapshot {
  readonly timestamp: number;  // from the backend's clock
}

export interface OffsetStore {
  /** The stored offset for a projection, 0 if none. */
  load(name: string): Promise<number>;
  save(name: string, offset: number): Promise<void>;
}

/** One backend's stores. */
export interface Persistence {
  readonly journal: Journal;
  readonly snapshots?: SnapshotStore;
  readonly offsets?: OffsetStore;
}
```

- A snapshot store keeps only the latest snapshot per id. Because saves don't hold the mailbox, two can be in flight at once, so `save` keeps whichever has the higher `seq`.
- Each backend returns all three stores from one call, sharing one connection.

### Backends

```ts
// @kylewillett/troupe/persistence: any runtime
export function inMemoryPersistence(opts?: { clock?: () => number }): InMemoryPersistence;
export interface InMemoryPersistence extends Required<Persistence> {
  /** Every stored event, in offset order. For tests and the inspector. */
  events(persistenceId?: string): readonly StoredEvent[];
}

// @kylewillett/troupe/persistence/sqlite: Node only
export function sqlitePersistence(opts: { path: string; clock?: () => number }): SqlitePersistence;
export interface SqlitePersistence extends Required<Persistence> { close(): void }

// @kylewillett/troupe/persistence/postgres: any runtime with a pg-compatible pool
export function postgresPersistence(opts: { pool: PgPool; schema?: string; clock?: () => number }): PostgresPersistence;
export interface PostgresPersistence extends Required<Persistence> {
  /** Creates the schema and tables if they're missing. Safe to run on every start. */
  setup(): Promise<void>;
}
```

- **In-memory** lives in `/persistence`, not the testkit, because milestone 3's browser demo runs on it. It resolves every call on a microtask, and nothing waits on time.
- **SQLite** uses Node's built-in `node:sqlite`, so it adds no dependency ([0017](decisions/0017-backends-add-no-dependencies.md)). `path` can be a file or `":memory:"`. File databases use WAL mode. An append runs in a `BEGIN IMMEDIATE` transaction, and a unique key on `(persistence_id, seq)` turns a lost race into `JournalConflictError`. Node 22 prints an experimental warning the first time `node:sqlite` loads, and Node 24 and later don't. The README says so.
- **Postgres** takes the caller's `pg` pool, typed structurally as `PgPool` (`query` and `connect`), so the entry point never imports `pg` and needs no peer dependency. `pg` is a devDependency for the tests. Tables live in `schema`, default `troupe`. An append runs in a transaction that takes a journal-wide advisory lock before it assigns offsets, so offsets commit in order ([0016](decisions/0016-postgres-appends-take-a-journal-lock.md)). A unique violation on `(persistence_id, seq)` becomes `JournalConflictError`.
- The SQL that creates each backend's tables ships alongside it, for people who manage migrations themselves.

### Schemas and versions

```ts
export interface EventOptions<E> {
  /** Checks events on write, and on read after upcasting. Any Standard Schema library works. */
  schema?: StandardSchemaV1<unknown, E>;
  /** The current event version, stored with every event. Default 1. */
  version?: number;
  /** One function per old version, from version n to n + 1. */
  upcasters?: Readonly<Record<number, (event: unknown) => unknown>>;
}
```

- The Standard Schema interface is copied into `src/persistence/standard-schema.ts`, as its authors intend, so there's no dependency ([0018](decisions/0018-standard-schema-and-upcasters.md)). Zod or Valibot, as a devDependency, proves it works with a real library.
- **On write**, each new event is validated before the append. A failure is `EventValidationError`, with the schema's issues.
- **On read**, an event stored at version *v* runs through upcasters *v*, *v* + 1, and so on, up to the current version, and is then validated. The schema's output is what `onEvent` gets. A stored version above the current one is `EventVersionError`, which usually means an older deployment is reading a newer one's events.
- Only version 1 ships in the example. A test fixture with a version-2 event proves the upcaster path.
- **Snapshots** have their own `version`. A snapshot whose version doesn't match is ignored, and recovery replays every event. That's the whole snapshot evolution story for this milestone.

### Snapshots

- With `snapshots: { every: 100 }`, a snapshot is saved after any persist that takes `lastSeq` across a multiple of 100.
- The snapshot holds `{ seq, version, state, timestamp }`. Its state must be a JSON value. A state that isn't is logged at `error`, and no snapshot is saved. This is where decision 0001's "state is plain data" is enforced for persistent actors.
- A save that fails is logged at `warn`. The actor carries on, since the events are safe.
- Saves don't hold the mailbox, but they count as busy work, so the testkit's `settle()` waits for them.
- Events are never deleted after a snapshot.

### Tags and projections

```ts
export function projection(opts: ProjectionOptions): ActorDef<never, ProjectionState>;

export interface ProjectionOptions {
  /** The offset's key in the offset store. */
  name: string;
  /** Needs `journal` and `offsets`. */
  persistence: Persistence;
  tag: string;
  /** Handles one event. At least once: an event can repeat after a failure. */
  handle(event: StoredEvent): void | Promise<void>;
  /** How long to wait after a batch that wasn't full. Default 1,000 ms. */
  pollMs?: number;
  /** Events per read. Default 100. */
  batchSize?: number;
}

export interface ProjectionState { readonly offset: number }
```

- A projection is an actor, spawned and supervised like any other. On start, it loads its offset. Then it reads a batch by tag, calls `handle` for each event in order, awaiting each one, and saves the offset after the batch. A full batch reads again at once. Otherwise it waits `pollMs` on a timer.
- A failure in `handle` goes to supervision. A restart reloads the stored offset, so the batch runs again from its start. That's the "at least once".
- `handle` gets the raw `StoredEvent`, not a decoded one, because a tag can span entity types with different schemas.
- Tags match the actor name pattern, `^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$`. A bad tag from `tags()` is a failure with a `TypeError`.

### Events and errors

New `SystemEvent` variants:

```ts
| { type: 'persisted'; path: string; persistenceId: string; fromSeq: number; toSeq: number }
| { type: 'recovered'; path: string; persistenceId: string; snapshotSeq: number; lastSeq: number }
```

`snapshotSeq` is 0 when recovery didn't start from a snapshot, so `lastSeq - snapshotSeq` events were replayed. (T2 named it `lastSeq`, not `seq`, because every `SystemEvent` already has a `seq`: its place in the event stream.) These are the only persistence events in this milestone. Milestone 3's timeline reads the journal itself.

New errors, from `/persistence`:

| Error | When | Carries |
| --- | --- | --- |
| `JournalConflictError` | An append's `expectedSeq` isn't the stream's last sequence number | `persistenceId`, `expectedSeq` |
| `EventValidationError` | An event fails its schema, on write or on read | `persistenceId`, `seq` (on read), `issues` |
| `EventVersionError` | A stored version is newer than the actor's | `persistenceId`, `seq`, `version` |
| `JournalSequenceError` | A backend returned an event out of sequence during recovery | `persistenceId`, `expected`, `got` |

### Entry points and build

| Entry point | Runtime | Built with |
| --- | --- | --- |
| `@kylewillett/troupe` | any | `tsconfig.build.json`, no Node types |
| `@kylewillett/troupe/testkit` | any | the same |
| `@kylewillett/troupe/persistence` | any | the same |
| `@kylewillett/troupe/persistence/postgres` | any, with a pg-compatible pool | the same |
| `@kylewillett/troupe/persistence/sqlite` | Node | `tsconfig.build.node.json`, Node types |

- Node-only code lives in `src/node/`. ESLint's runtime rules apply to `src/` except `src/node/`, and `tsconfig.build.json` excludes it ([0004](decisions/0004-runtime-agnostic-core.md)). `npm run build` and `npm run typecheck` run both build configs.
- Lint allows `Date.now` in three more places, each with a comment: the default `clock` of each backend ([0015](decisions/0015-journal-timestamps-come-from-an-injected-clock.md)).
- The persistence code reaches into the core through internal modules, not the public API. They're one package, so they share one copy of the core.
- Package tests check that `@kylewillett/troupe` loads nothing from `/persistence`, and that `/persistence` loads neither `node:sqlite` nor `pg` ([0005](decisions/0005-one-package-with-subpaths.md)).

### Testing

- `test/persistence/contract.ts` exports a suite that takes a backend factory. In-memory and SQLite (`:memory:` and a temp file) run it in `npm test`. Postgres runs it in `npm run test:integration`.
- Postgres for tests comes from `docker-compose.test.yml`, on port 5440 so it can't touch a database you use for anything else. `npm run postgres:up` starts it. CI runs the same image as a service.
- `npm test` needs no database. `npm run coverage` runs unit and integration together, as rate-limiter does, so it needs `npm run postgres:up` first.
- If `TROUPE_POSTGRES_URL` is missing when `CI` is set, the integration run fails instead of skipping.
- Fault injection for persistent actor tests (an append that rejects, a read that fails halfway, a slow snapshot) is a wrapper around a `Journal` in `test/helpers/`, not public API.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T1. Persistence entry point, stores and the in-memory backend | Done | 65f1df6 |
| T2. Persistent actors: commands, effects and recovery | Done | 1af2f66 |
| T3. Snapshots | Done | 22fc8e9 |
| T4. Event schemas and upcasters | Done | b271f32 |
| T5. Projections | Done | |
| T6. SQLite backend | Not started | |
| T7. Postgres backend | Not started | |
| T8. Persistent box office and README | Not started | |

### T1. Persistence entry point, stores and the in-memory backend

- `src/persistence/`: `Journal`, `NewEvent`, `StoredEvent`, `SnapshotStore`, `NewSnapshot`, `Snapshot`, `OffsetStore`, `Persistence`, `JournalConflictError`, `JournalSequenceError`, and `inMemoryPersistence()`
- The `./persistence` export in `package.json`, and its paths and aliases in `tsconfig.json` and `vitest.config.ts`
- A JSON-value check (`isJsonValue`), shared by the in-memory backend and, in T2, the persistent actor
- `test/persistence/contract.ts`, run against the in-memory backend

**Done when** tests cover:

- [x] Append and read: sequence numbers start at 1 with no gaps, `read` honours `fromSeq` and `limit`, and streams are independent.
- [x] A conflict: appending at a stale `expectedSeq` rejects with `JournalConflictError` and writes nothing, even for a batch.
- [x] A batch is all or none.
- [x] Offsets increase across streams, and `readByTag` returns only that tag's events, after the offset, in offset order, up to `limit`.
- [x] Timestamps come from the given clock.
- [x] Events and snapshot states come back deep-equal to what went in, and a stored value can't be changed through a reference the caller kept.
- [x] Snapshot store: `load` returns the latest, and a save with a lower `seq` is ignored.
- [x] Offset store: `load` is 0 before any save, and returns the last save after.
- [x] A package test: `/persistence` loads, exports exactly its names, and `@kylewillett/troupe` doesn't load it.

### T2. Persistent actors: commands, effects and recovery

- `persistentActor()`, `PersistentActorDef`, `PersistentContext`, `PersistentState`, `PersistentSignal`, and `Effect`
- The cell's internal start hook, run after `initial` and before any message
- The `persisted` and `recovered` events
- A failing-journal wrapper in `test/helpers/`

**Done when** tests cover:

- [x] A command that persists replies with the new state, and the journal holds its events.
- [x] `reply` and `none` persist nothing and don't hold the mailbox.
- [x] Commands sent during a persist wait, then run in order, each seeing the state after the one before.
- [x] Commands sent right after `spawn` wait for recovery, then run in order.
- [x] Recovery: a new incarnation and a new system on the same backend both rebuild the same state from the journal.
- [x] `thenReply`, `thenRun` and `thenStop` run in the order they were chained, after the events are applied. `thenStop` stops after the write.
- [x] Each failure goes to supervision: a throw in `onCommand`, in a step, and in `onEvent`; a rejected append; an event that isn't JSON; and a failed read during recovery.
- [x] **Two writers:** two actors with the same id, spawned under different names, persist in turn. The loser fails with `JournalConflictError`, its command is dropped, and after a restart it sees the winner's events. The stream has no gaps or duplicates.
- [x] `persisted` and `recovered` events carry the right sequence numbers, and `recoveryCompleted` reaches `onSignal`.
- [x] Invalid options throw `TypeError` from `persistentActor()`.
- [x] Type tests: `C`, `E` and `S` are inferred, `persist` takes only `E`, `thenReply`'s callback gets `S`, and the result is spawnable as an `ActorRef<C>`.
- [x] Determinism: a scenario with persists, a conflict and a restart under backoff gives identical `kit.events` on two runs with the same seed.

### T3. Snapshots

**Done when** tests cover:

- [x] With `every: 3`, snapshots are saved at sequence numbers 3, 6 and 9, including when one persist crosses a multiple.
- [x] Recovery starts from the latest snapshot and replays only the events after it. The `recovered` event says so.
- [x] A snapshot with another version is ignored, and recovery replays everything.
- [x] A snapshot that fails to load or save is logged at `warn`, and the actor recovers or carries on.
- [x] A state that isn't JSON logs at `error` and saves nothing.
- [x] A slow save doesn't hold the mailbox, and `settle()` waits for it.

### T4. Event schemas and upcasters

- `src/persistence/standard-schema.ts`, `EventOptions`, `EventValidationError` and `EventVersionError`
- Zod or Valibot as a devDependency

**Done when** tests cover:

- [x] A schema rejects a bad event on write, before the append, with the schema's issues.
- [x] A schema rejects a bad stored event on recovery.
- [x] An async schema works on both paths.
- [x] A version-1 event in the journal is upcast to version 2 and passes the version-2 schema, and new events are stored at version 2.
- [x] A stored version above the current one fails recovery with `EventVersionError`.
- [x] Upcasters with a gap throw `TypeError` from `persistentActor()`.

### T5. Projections

**Done when** tests cover:

- [x] A projection handles every tagged event once, in offset order, across several entities.
- [x] It saves its offset after each batch, and a new projection with the same name starts after it.
- [x] A full batch reads again at once, and a short one waits `pollMs` of virtual time.
- [x] A failure in `handle` restarts the projection from the stored offset, so the batch repeats.
- [x] A bad tag from `tags()` fails the persist with `TypeError`.

### T6. SQLite backend

- `src/node/sqlite/`, the `./persistence/sqlite` export, `tsconfig.build.node.json`, and the lint and typecheck changes
- Its table SQL, shipped in `dist/`

**Done when:**

- [ ] The contract suite passes on `:memory:` and on a temp file, on Node 22, 24 and 26 in CI.
- [ ] Two `sqlitePersistence` instances on one file, used in turn, keep one stream intact, and the stale one gets `JournalConflictError`.
- [ ] Reopening a file finds everything a closed instance wrote.
- [ ] Package tests: the entry point loads from `dist/`, and `/persistence` doesn't load `node:sqlite`.
- [ ] `src/node/` is the only place lint allows Node imports.

### T7. Postgres backend

- `src/persistence/postgres/`, the `./persistence/postgres` export, and its table SQL
- `docker-compose.test.yml`, `npm run postgres:up`, `npm run test:integration`, a Vitest project for integration tests, and a Postgres service in CI
- `pg` and `@types/pg` as devDependencies
- AGENTS.md's commands updated for the database

**Done when:**

- [ ] The contract suite passes against Postgres, locally and in CI.
- [ ] `setup()` is safe to run twice, and `schema` keeps two journals apart in one database.
- [ ] **Concurrent writers:** two pools append to one stream at once, many times. Each append either succeeds or gets `JournalConflictError`, and the stream has no gaps or duplicates.
- [ ] **Offsets commit in order:** while two pools append to many streams at once, a reader following one tag never sees an offset lower than one it has already seen. Removing the advisory lock makes this test fail.
- [ ] A package test: the entry point doesn't import `pg`.
- [ ] The integration run fails, rather than skipping, when `CI` is set and `TROUPE_POSTGRES_URL` isn't.

### T8. Persistent box office and README

- `examples/box-office/`: `Show` becomes a persistent actor with events `held`, `confirmed` and `released`, on SQLite at `.troupe/box-office.db`, which is gitignored and deleted at the start of each run, so the story repeats.
- On `recoveryCompleted`, a show starts a fresh hold timer for each hold it recovered. Holds don't remember how long they had left, because durable timers are a later idea. The README says so.
- The story keeps milestone 1's first four steps, then:
  5. Carol's confirm succeeds, because the restarted `hamlet` recovered her hold.
  6. The system terminates. A new system opens the same file, and every show recovers its sales, which the narration prints from the `recovered` events.
- `test/examples/box-office.test.ts` runs the same story on the in-memory backend, with two systems sharing it for step 6.
- The README covers:
  - defining a persistent actor, and the effects
  - recovery, snapshots, and why `onEvent` must be pure
  - the three backends, including the Node 22 warning for SQLite and `setup()` for Postgres
  - schemas and upcasters
  - projections, and what "at least once" means for `handle`
  - two writers and `JournalConflictError`, and why backoff suits persistent actors

**Done when:**

- [ ] The demo described in "Outcome" works from a clean clone: `npm ci && npm run example`.
- [ ] The example test passes, and fails if the show stops persisting holds.

## Definition of done

- [ ] T1 to T8 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration`, `coverage` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies, and no peer dependencies.
- [ ] Everything outside `src/node/` builds with no Node types and imports no Node built-ins.
- [ ] Every backend passes the journal contract suite.
- [ ] The public API is exported only from the entry points' `index.ts` files, and every export has a TSDoc comment.

## Decision records

The tasks add these records, as Proposed, and accept them once their tests pass. Read [0002](decisions/0002-async-receive-blocks-the-mailbox.md), [0004](decisions/0004-runtime-agnostic-core.md), [0005](decisions/0005-one-package-with-subpaths.md) and [0006](decisions/0006-supervision-chosen-at-spawn.md) first, since these build on them.

| # | Decision | Task |
| --- | --- | --- |
| 0011 | Persisting and recovery hold the mailbox, so the mailbox is the stash | T2 |
| 0012 | Commands return effects, and state changes only through events | T2 |
| 0013 | The journal's sequence check is the single-writer backstop, and a failed write is settled by recovery | T2 |
| 0014 | Events and snapshot states are JSON values, checked before they're written | T1 |
| 0015 | Journal timestamps come from an injected wall clock, and never order anything | T1 |
| 0016 | Postgres appends take a journal-wide lock, so tag offsets commit in order | T7 |
| 0017 | Backends add no dependencies: `node:sqlite`, and a structurally typed `pg` pool | T6, T7 |
| 0018 | Event schemas use Standard Schema, with one upcaster per version step | T4 |

## Open questions

1. **Escalation**, carried over from milestone 1. Persistent entities don't need a death pact yet, so nothing escalates. Revisit with sharding in milestone 4.
2. **Journal timeouts.** A backend call that never settles leaves the actor busy for good, like milestone 1's open question 3. A timeout on the scheduler can't fire under the testkit while the actor is busy, because `settle()` won't finish. Milestone 5's simulated journal, which resolves on the scheduler, needs the same fix that [0010](decisions/0010-piped-asks-stay-on-the-scheduler.md) gave piped asks. Deferred to milestone 5, where the problem first bites.
3. **The cost of the Postgres lock.** One lock serialises every append in a journal. That's simple and correct, but it caps throughput. Milestone 3's benchmark should measure it. If it's too slow, the alternative is Akka-style gap detection in the reader.
4. **Snapshot schemas.** A version mismatch throws a snapshot away. Should snapshots also get a schema and upcasters? Not until a real migration needs one.
5. **Testing `onCommand` alone.** The builders live on `ctx`, so a unit test of `onCommand` needs a context. If that's painful, the testkit could offer a small `commandHarness(def)`. Decide in T8 from how the example's tests read.
