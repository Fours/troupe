# Troupe

Typed actors for TypeScript, in the spirit of Akka: hierarchies, supervision, `ask`, timers, a testkit that runs on virtual time, and event-sourced persistent actors on an in-memory, SQLite or Postgres journal, and cluster sharding across Node processes, with at most one live instance of each entity.

> **Status:** 0.x, so a minor version can change the API. 1.0 comes after milestone 5, Rehearsal, has tested the cluster against injected faults ([0032](docs/decisions/0032-1-0-comes-after-rehearsal.md)). See the [changelog](CHANGELOG.md), the [roadmap](docs/roadmap.md), and the specs for milestones [1](docs/milestone-1.md), [2](docs/milestone-2.md), [3](docs/milestone-3.md) and [4](docs/milestone-4.md).

**[See it run](https://troupe.kylewillett.com/):** opening night at a box office, a Troupe system running live in your browser with no backend, inspected by Backstage. Crash a show and watch it restart and recover from its journal, take the journal down, and scrub a show's events back through time. Then [festival night](https://troupe.kylewillett.com/cluster/): a dozen shows on three nodes in the page, with buttons that kill, restart and add nodes.

**[How it works](https://troupe.kylewillett.com/how-it-works/):** the design write-up, "How Troupe works", tells the [decision records](docs/decisions/) as one story, from actors as a state and a reducer to the benchmark's numbers, and links every claim to its record.

- **Typed:** each actor has one message type, and refs are checked against it.
- **No runtime dependencies**, and the core runs on any JavaScript runtime, not only Node.
- **Deterministic tests:** time, scheduling and chance are injected, so the testkit replays a run exactly from a seed.

## Install

```bash
npm install @kylewillett/troupe
```

It needs Node 22.18 or later, and is ESM only. Each release is published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), which ties it to the commit and the workflow run that built it ([0024](docs/decisions/0024-publish-from-ci-with-provenance.md)). It's one package with several entry points:

| Entry point | What it has | Runs on |
| --- | --- | --- |
| `@kylewillett/troupe` | actors, systems, supervision, `ask`, timers | any runtime |
| `@kylewillett/troupe/testkit` | virtual time, seeded random, probes | any runtime |
| `@kylewillett/troupe/persistence` | persistent actors, projections, the in-memory backend | any runtime |
| `@kylewillett/troupe/persistence/sqlite` | the SQLite backend, on `node:sqlite` | Node |
| `@kylewillett/troupe/persistence/postgres` | the Postgres backend, on your own `pg` pool | any runtime with a pool |
| `@kylewillett/troupe/backstage` | Backstage, the inspector: its protocol and an in-process source | any runtime |
| `@kylewillett/troupe/backstage/ui` | `mountBackstage`, the inspector's UI in your own page, with React inside | browsers |
| `@kylewillett/troupe/backstage/server` | `serveBackstage`, the inspector's UI over HTTP | Node |
| `@kylewillett/troupe/cluster` | joining a cluster, cluster sharding, the in-memory network and shard store | any runtime |
| `@kylewillett/troupe/cluster/postgres` | the Postgres shard store, on your own `pg` pool | any runtime with a pool |
| `@kylewillett/troupe/cluster/tcp` | `tcpTransport`, nodes in separate processes, on `node:net` | Node |

None of them has a runtime dependency.

## Quick start

An actor is a state plus a reducer. `receive` takes the current state and one message, and returns the next state.

```ts
import { actor, createActorSystem, type ActorRef } from '@kylewillett/troupe';

type CounterMsg = { type: 'inc'; by: number } | { type: 'get'; replyTo: ActorRef<number> };

const counter = actor<CounterMsg, number>({
  initial: 0,
  receive(count, msg) {
    switch (msg.type) {
      case 'inc':
        return count + msg.by;
      case 'get':
        msg.replyTo.tell(count);
        return count;
    }
  },
});

const system = createActorSystem();
const ref = system.spawn(counter, 'counter');
ref.tell({ type: 'inc', by: 2 });
console.log(await ref.ask<number>((replyTo) => ({ type: 'get', replyTo }))); // 2
await system.terminate();
```

## Defining actors

`actor({ initial, receive, onSignal })` returns a definition, which you can spawn as many times as you like.

- **`initial`** is the starting state, or a function `(ctx) => state`. It runs when the actor starts and again on every restart, so it's also where an actor spawns its children and starts its timers.
- **`receive(state, msg, ctx)`** returns the next state, either directly or as a promise.
- **`onSignal(state, signal, ctx)`** is optional. It handles `preRestart`, `postStop`, and `terminated` for actors this one watches.

**State is a plain value:** data, not functions or class instances. Refs carry functions, so keep them out of state too: a parent finds its children with `ctx.child(name)`. Persistent actors snapshot state, and the milestone 3 inspector displays it, so this rule matters.

Protocols are discriminated unions, and TypeScript checks that `receive` handles every case. There's no "unhandled message".

An actor runs **one message at a time**. If `receive` returns a promise, the actor's next message waits until the promise settles, while other actors carry on.

## `tell` and `ask`

- **`ref.tell(msg)`** sends a message and returns at once. It never throws. A message that can't be delivered, because the actor has stopped or its bounded mailbox is full, becomes a dead letter on the event stream.
- **`ref.ask(build, { timeoutMs })`** sends a request and returns a promise of the reply. `build` gets a temporary `replyTo` ref and returns the message to send. Write the reply type, as in `ask<number>(...)`, because TypeScript can't infer it from the protocol. If no reply comes within `timeoutMs` (default 5,000), the promise rejects with `AskTimeoutError`. Asking a stopped actor times out too, rather than failing fast, so that local refs behave like remote ones will.

Messages from one sender to one receiver arrive in the order they were sent.

## The hierarchy

Actors spawned with `system.spawn` live under `/user`. An actor's children live under its path, as in `/user/box-office/hamlet`.

```ts
const parent = actor<never, null>({
  initial: (ctx) => {
    const child = ctx.spawn(counter, 'counter');
    ctx.watch(child);
    return null;
  },
  receive: (state) => state,
  onSignal(state, signal, ctx) {
    if (signal.type === 'terminated') ctx.log.info('child stopped', { child: signal.ref.path });
    return state;
  },
});
```

- **`ctx.stop()`** stops the actor itself, and `ctx.stop(child)` stops one of its children. Stopping recurses: an actor stops its children first, waits for them, runs `postStop`, and then terminates.
- **`ctx.watch(ref)`** delivers a `terminated` signal when that actor stops. It works on any actor, not only children. If the actor stopped because it failed, the signal carries the `failure`.
- **`system.terminate()`** stops everything, and resolves once the last actor has stopped.

## Supervision

When an actor fails, its parent's strategy decides what happens. A failure is a throw or a rejected promise in `initial`, `receive`, `onSignal` or a `pipeToSelf` mapper. The parent chooses the strategy when it spawns the child:

```ts
import { supervise } from '@kylewillett/troupe';

ctx.spawn(show, 'hamlet', {
  supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }),
});
```

| Strategy | What happens |
| --- | --- |
| `supervise.stop()` (the default) | The actor stops, and watchers get `terminated` with the `failure`. |
| `supervise.resume()` | The actor keeps its state, drops the message that failed, and carries on. |
| `supervise.restart({ maxRestarts, withinMs })` | It runs `preRestart`, stops its children and timers, and runs `initial` again. The mailbox and the ref carry over. Too many failures within the window stop it instead. |
| `supervise.restartWithBackoff({ minMs, maxMs, randomFactor, resetAfterMs, minDelayFor })` | A restart that first waits `minMs`, doubling each time up to `maxMs`, with random jitter. Messages queue up while it waits. |

When a failure says how long to wait, such as a 429 with a `retry-after`, give the backoff a **`minDelayFor`**. It's called with each failure, as it was thrown, and returns the fewest ms to wait, or `undefined`. The restart waits for that or for the backoff, whichever is longer, with jitter on top. A minimum isn't capped by `maxMs`, since the server knows better, and doesn't count as extra backoff steps ([0041](docs/decisions/0041-a-failure-can-raise-its-backoff-delay.md)):

```ts
supervise.restartWithBackoff({
  minMs: 1_000,
  maxMs: 60_000,
  minDelayFor: (failure) =>
    failure instanceof Error && failure.cause instanceof ModelError
      ? failure.cause.retryAfterMs // a 5 s retry-after waits 5 to 6 s, not 1 s
      : undefined,
});
```

A restart is a new incarnation: its state starts from `initial`, and whatever the old one held is gone, unless it's a [persistent actor](#persistent-actors), which recovers its state from its journal. Every failure publishes a `failed` event and logs at `error`.

## Timers and `pipeToSelf`

```ts
type SessionMsg =
  | { type: 'touch' }
  | { type: 'idle' }
  | { type: 'load'; id: string }
  | { type: 'loaded'; result: Result<string> };

const session = actor<SessionMsg, { lastLoaded?: string }>({
  initial: (ctx) => {
    ctx.timers.startSingle('idle', { type: 'idle' }, 60_000);
    return {};
  },
  receive(state, msg, ctx) {
    switch (msg.type) {
      case 'touch':
        ctx.timers.startSingle('idle', { type: 'idle' }, 60_000); // replaces the old timer
        return state;
      case 'idle':
        ctx.stop();
        return state;
      case 'load':
        ctx.pipeToSelf(fetchProfile(msg.id), (result) => ({ type: 'loaded', result }));
        return state;
      case 'loaded':
        return msg.result.ok ? { lastLoaded: msg.result.value } : state;
    }
  },
});
```

- **Timers** are keyed. `startSingle` and `startPeriodic` replace any timer with the same key, and `cancel(key)` stops one. Once a timer is cancelled or replaced, its message is never received, even if it's already in the mailbox. Every timer is cancelled when the actor stops or restarts.
- **`ctx.pipeToSelf(promise, map)`** waits for a promise without blocking the mailbox. When the promise settles, the actor gets `map(result)` as a message, where `result` is `{ ok: true, value }` or `{ ok: false, error }`. The mapper runs inside the actor, so a throw there goes to supervision.
- **`ctx.pipeToSelf(promise, map, { signal })`** also ends the pipe when `signal` aborts: the actor gets `map({ ok: false, error: signal.reason })` at once, and whatever the promise does afterwards is ignored. Use it for work that one of the actor's own timers, or its `postStop`, cancels, such as a call with a timeout. A promise that ignores its signal then can't hold the actor up ([0038](docs/decisions/0038-a-pipe-with-a-signal-ends-on-the-scheduler.md)).

## The testkit

`@kylewillett/troupe/testkit` runs a system on virtual time, with a seeded random. Tests run instantly, and the same seed gives the same run.

```ts
import { createTestKit } from '@kylewillett/troupe/testkit';

const kit = createTestKit({ seed: 1 });
const probe = kit.probe<number>('replies');
const ref = kit.system.spawn(counter, 'counter');

ref.tell({ type: 'inc', by: 2 });
ref.tell({ type: 'get', replyTo: probe.ref });
await kit.settle();
probe.expectMessage(2);

await kit.advance(60_000); // fires every timer due in the next minute, in order
await kit.shutdown();
```

- **`kit.settle()`** runs everything that can happen without time passing: queued messages, due timers, and async `receive` work. It throws `SettleTimeoutError` if an actor stays busy, for example awaiting a promise that never settles. A pipe with a signal isn't waited for, since the signal ends it, so `advance` can let time pass until the actor's timer aborts it. It gets one event-loop turn, so a promise that has already settled still arrives.
- **`kit.advance(ms)`** moves virtual time forward. It fires timers in order, and settles at each due time.
- **Probes** are refs that record what they're sent. Their assertions are synchronous: `expectMessage(value | predicate)`, `expectNoMessage()`, `messages()`, and `watch(ref)` then `expectTerminated(ref)`. Settle or advance first, then assert.
- **`kit.events`** and **`kit.logs`** record everything the system published and logged.

## Persistent actors

`@kylewillett/troupe/persistence` adds event sourcing. A persistent actor doesn't change its state directly. It turns each command into events, the journal stores them, and only then are they applied to the state. On start and on every restart, the actor replays its events to get its state back, so a crash, a restart or a new process loses nothing that was written.

### Defining one

```ts
import { createActorSystem, type ActorRef } from '@kylewillett/troupe';
import { inMemoryPersistence, persistentActor } from '@kylewillett/troupe/persistence';

type Receipt = { ok: true; balance: number } | { ok: false; reason: string };
type AccountCmd =
  | { type: 'deposit'; amount: number; replyTo: ActorRef<Receipt> }
  | { type: 'withdraw'; amount: number; replyTo: ActorRef<Receipt> };
type AccountEvent = { type: 'deposited'; amount: number } | { type: 'withdrawn'; amount: number };

const persistence = inMemoryPersistence();

const account = (id: string) =>
  persistentActor<AccountCmd, AccountEvent, { balance: number }>({
    id: `account-${id}`,
    persistence,
    initial: { balance: 0 },
    onCommand(state, cmd, { persist, reply }) {
      const receipt = (s: { balance: number }): Receipt => ({ ok: true, balance: s.balance });
      switch (cmd.type) {
        case 'deposit':
          return persist({ type: 'deposited', amount: cmd.amount }).thenReply(cmd.replyTo, receipt);
        case 'withdraw':
          if (cmd.amount > state.balance) {
            return reply(cmd.replyTo, { ok: false, reason: 'insufficient funds' });
          }
          return persist({ type: 'withdrawn', amount: cmd.amount }).thenReply(cmd.replyTo, receipt);
      }
    },
    onEvent(state, event) {
      return event.type === 'deposited'
        ? { balance: state.balance + event.amount }
        : { balance: state.balance - event.amount };
    },
  });

const system = createActorSystem();
const alice = system.spawn(account('alice'), 'alice');
await alice.ask<Receipt>((replyTo) => ({ type: 'deposit', amount: 10, replyTo })); // balance 10
```

`persistentActor` returns an ordinary actor definition: spawn, name, watch and supervise it like any other. `id` names its event stream in the journal. Events and states must be JSON values, and are checked before they're written. To check a value yourself first, `jsonProblem(value)` from `@kylewillett/troupe` names where it stops being JSON, such as `$.items[2] is a hole`, and `isJsonValue(value)` says whether it is one.

### Effects

`onCommand` is synchronous and can't change the state. It returns an effect, built from its context:

- **`persist(...events)`** appends the events, applies them with `onEvent`, and then runs the steps chained after it.
- **`reply(to, message)`** persists nothing and replies at once. **`none()`** does nothing.
- **`.thenReply(to, (state) => message)`** replies with the state after the events. **`.thenRun((state) => ...)`** runs a side effect, such as starting a timer. **`.thenStop()`** stops the actor once the events are written.

Steps run in the order you chain them. While a persist is in flight, the actor's mailbox waits, so the next command sees the state the last one left. A rejected append applies nothing: the actor fails, and a restart recovers what the journal really holds. Every successful append publishes a `persisted` event.

### Recovery, snapshots, and why `onEvent` must be pure

When the actor starts or restarts, it reads its stream and folds each event through `onEvent`. Commands sent meanwhile wait in the mailbox. Then `onSignal` gets `recoveryCompleted`, and the system publishes a `recovered` event with the last sequence number.

Because every recovery replays every event, **`onEvent` must be pure**: no I/O, no timers, no replies, no randomness or clock reads, and no throwing for an event it has accepted before. Anything else would happen again on every replay. Side effects belong in `thenRun` and `thenReply`, which run once, after the write. Timers don't survive a restart, so start the ones your state implies in `onSignal` on `recoveryCompleted`.

Long streams make recovery slow. `snapshots: { every: 100 }` saves the state after any persist that crosses a multiple of 100, and recovery starts from the latest snapshot and replays only the events after it. Snapshots are a shortcut, never the source of truth: events are never deleted, and recovery replays everything when it can't use a snapshot. Bump `snapshots.version` whenever the state's shape changes, and recovery ignores the old ones. A snapshot that fails to save or load logs a warning, and the actor carries on.

### Backends

```ts
import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { postgresPersistence } from '@kylewillett/troupe/persistence/postgres';
import pg from 'pg';

const memory = inMemoryPersistence();
const sqlite = sqlitePersistence({ path: 'app.db' }); // or ':memory:'
const postgres = postgresPersistence({ pool: new pg.Pool(), schema: 'troupe' });
await postgres.setup();
```

- **In-memory** runs anywhere, and is what tests use. It forgets everything when the process exits.
- **SQLite** uses Node's built-in `node:sqlite`, so it adds no dependency. It's Node only. On Node 22, `node:sqlite` is experimental, and the first load prints an `ExperimentalWarning`. Node 24 and later don't. Calls are synchronous under the hood, and `close()` closes the file.
- **Postgres** runs on a pool you pass in. Troupe never imports `pg`: anything with `pg`'s `query` and `connect` works. Call **`setup()`** once, on start, to create the tables. It's safe to run every time. Each `schema` is a separate journal, so two apps can share a database. If you manage migrations yourself, the tables' SQL ships as `dist/persistence/postgres/schema.sql`. The SQLite backend ships its own as `dist/node/sqlite/schema.sql`.

Every backend passes the same contract suite, so an actor behaves the same on each one.

### Schemas and upcasters

Events live for as long as your data does, so their shape will change. `events` adds runtime checks and versions:

```ts
import { z } from 'zod';

const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deposited'), amount: z.number().int().positive(), memo: z.string() }),
  z.object({ type: z.literal('withdrawn'), amount: z.number().int().positive(), memo: z.string() }),
]);

persistentActor({
  // ...
  events: {
    schema: Event,
    version: 2,
    // Version 1 events had no memo.
    upcasters: { 1: (event) => ({ ...(event as object), memo: '' }) },
  },
});
```

- Any [Standard Schema](https://standardschema.dev) library works, such as Zod or Valibot, sync or async. The schema checks each event before the append, so a bad event is never written, and again on recovery. A failure is an `EventValidationError` with the schema's issues.
- New events are stored at `version`. On recovery, a stored event runs through one upcaster per version step, from its own version up, and then through the schema. `upcasters[n]` turns a version-n event into a version-(n + 1) one, and they must cover every step from 1 to `version - 1`.
- An event stored at a higher version than the actor knows fails recovery with `EventVersionError`, so old code never misreads new data.

### Tags and projections

`tags(event)` labels events, and a projection follows one tag across every entity, in the order the journal stored them. It's how you build read models, such as a sales report from every show.

```ts
import { supervise } from '@kylewillett/troupe';
import { projection } from '@kylewillett/troupe/persistence';

system.spawn(
  projection({ name: 'deposits', persistence, tag: 'account', handle: (e) => report.record(e) }),
  'deposits',
  { supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }) },
);
```

The projection reads a batch, hands each event to `handle` in turn, and then saves its offset in the backend's offset store. A new projection with the same name starts after the saved offset. When a batch comes back short, it waits `pollMs` before it reads again.

Delivery is **at least once**. If `handle` fails, or the process dies before the offset is saved, the projection restarts from the last saved offset, and that batch runs again. So `handle` must be safe to repeat: make it idempotent, for example by upserting keyed on the event's `persistenceId` and `seq`, or by recording the last `offset` it applied. `handle` gets the event as it was stored, not upcast or checked, since a tag can span entity types.

### Two writers, and why backoff suits persistent actors

An entity's events must form one stream. If two actors with the same `id` both write, perhaps from two processes on one database, the stream could fork. It can't, because every append says which sequence number it follows, and the journal rejects a stale one with **`JournalConflictError`**. The loser's command is dropped, and the actor fails like any other.

That's where supervision comes in. A restart replays the journal, so the loser catches up on the winner's events and carries on after them. Use **`restartWithBackoff`** for persistent actors. A conflict, or a database that's down, won't clear up in the next microtask, and every restart reads the whole stream again. Backoff spaces out those reads, with jitter so a fleet of entities doesn't retry in step, instead of hammering a journal that's already in trouble.

### Timeouts

Every journal, snapshot and offset call a persistent actor or a projection makes gives up after **`timeoutMs`**, 10,000 by default, on the actor's scheduler, so a database that stops answering can't hold an entity's mailbox for good. An append or a read that takes longer fails the actor with **`PersistenceTimeoutError`**, which says the call (`operation`), the actor's `id` and the `timeoutMs`, and supervision takes it from there. No reply goes out for a write that timed out: it may still have been written, so the outcome is unknown, and the restart recovers from the journal to find out ([0036](docs/decisions/0036-timeouts-are-unknown-outcomes-settled-by-recovery.md)). A snapshot load that times out is skipped, and recovery replays every event. A save that times out is logged.

## Clusters

`@kylewillett/troupe/cluster` spreads entities, such as accounts or shows, across several Node processes. You address an entity by its type and ID from any node, and `tell` or `ask` it as if it were local. Its ref works wherever the entity lives, and keeps working when it moves. If a node dies, its entities start again on the others, recovered from the journal.

### Joining a cluster

Every node needs a transport, the same list of seeds, and the same shard store, which is where shard ownership lives:

```ts
import pg from 'pg';
import { createActorSystem } from '@kylewillett/troupe';
import { joinCluster } from '@kylewillett/troupe/cluster';
import { postgresShardStore } from '@kylewillett/troupe/cluster/postgres';
import { tcpTransport } from '@kylewillett/troupe/cluster/tcp';
import { postgresPersistence } from '@kylewillett/troupe/persistence/postgres';

const secret = process.env.CLUSTER_SECRET;
if (!secret) throw new Error('CLUSTER_SECRET must be set');

const pool = new pg.Pool();
const persistence = postgresPersistence({ pool, schema: 'troupe' });
const shards = postgresShardStore({ pool, schema: 'troupe' });
await persistence.setup(); // both are safe on every start, from every node at once
await shards.setup();

const system = createActorSystem({ name: 'bank' });
const cluster = joinCluster(system, {
  name: 'bank',
  transport: tcpTransport({ port: 2552, host: '10.0.0.1', secret }),
  seeds: ['10.0.0.1:2552', '10.0.0.2:2552', '10.0.0.3:2552'],
  shards,
});
await cluster.whenUp;
```

- **Seeds.** A node joins through any seed that answers. Only the first seed may form a cluster on its own, after `seedTimeoutMs` (5 s) with no other seed answering, so two halves can't each form one at start-up. Give every node the same list.
- **Membership is gossiped, with no leader.** Nodes heartbeat each other every `heartbeatMs` (1 s). One unheard for `unreachableAfterMs` (5 s) is unreachable, and one unreachable for `downAfterMs` (10 s) more is marked down, automatically. That's safe here because being marked down never decides who owns a shard: the lease does ([0028](docs/decisions/0028-membership-is-gossiped-with-automatic-downing.md)). A node that learns it was marked down leaves, and comes back only by restarting.
- **Leaving.** `cluster.leave()`, or `system.terminate()`, hands every shard this node holds to its next owner, after each entity finishes what it's doing, a persist included, then leaves. Call it on SIGTERM.
- `cluster.members()` is this node's view of the members, and the system's event stream has `memberUp`, `memberLeaving`, `memberDown`, `memberRemoved`, `reachability`, `shardAcquired` and `shardReleased`.

For nodes in one process, such as tests or a browser, `inMemoryNetwork({ scheduler })` gives each node a transport and `inMemoryShardStore()` a store, and the same code runs on the testkit's virtual time.

### Sharding an entity type

```ts
import type { ActorRef } from '@kylewillett/troupe';

// account(id) is the persistent account from "Defining one", on the Postgres persistence above.
const accounts = cluster.sharding.init({ type: 'account', entity: account, shardCount: 64 });

const alice: ActorRef<AccountCmd> = accounts.ref('alice');
await alice.ask<Receipt>((replyTo) => ({ type: 'deposit', amount: 10, replyTo }), { timeoutMs: 5_000 });
```

- An entity's ID is hashed into one of `shardCount` shards, and each shard lives on one node. Every node that calls `init` for a type hosts some of its shards. `host: false` makes a node that only routes, such as a web server. `shardCount` must be the same on every node, and can't change on a running cluster.
- A shard goes to the member with the highest rendezvous hash of the shard and the member, so every node computes the same owner without a coordinator, and a new node takes only the shards it now tops, about one in N ([0030](docs/decisions/0030-shards-are-placed-by-rendezvous-hashing.md)). Shards move by handoff, a few at a time every `rebalanceMs`.
- An entity starts on its first message, and again after it stops. `passivation: { idleMs }` stops idle ones. `remember: true` starts a shard's entities as soon as the shard lands on a node, rather than on their next message.
- `schema` checks every message an entity gets with any Standard Schema library, after it crosses the wire. One that fails is an `invalid` dead letter.
- `supervision` is the type's, as for any child. The default is `supervise.stop()`, and the next message starts the entity again.

### What's guaranteed, and what isn't

- **At most one live instance of each entity.** A shard is owned by whoever holds its lease in the shard store, never by whoever membership thinks is alive. Postgres judges a lease's expiry on its own clock, and the holder gives it up a margin earlier on its own, so no two clocks are compared. A node cut off from Postgres stops its shards before anyone else can start them ([0029](docs/decisions/0029-a-shard-is-owned-by-whoever-holds-its-lease.md)). If a node pauses past its lease and wakes to write once more, the journal's sequence check fails one of the two writes ([0013](docs/decisions/0013-sequence-check-is-the-single-writer-backstop.md)).
- **At most once delivery.** Nothing is retried or acknowledged. A message on a connection that breaks, or sent to a node in the seconds before anyone notices it died, is lost, and an `ask` for it times out. If a request must happen, ask again, and make it safe to repeat ([0026](docs/decisions/0026-remoting-is-at-most-once-behind-a-transport.md)).
- **Order per pair.** Messages from one node to one actor arrive in the order they were sent. While an entity's shard moves, messages already on their way can be reordered, but never delivered twice.
- **Messages are JSON plus refs.** Every message to an entity is encoded, even when the entity is on the same node, so one with a `Map`, a class instance or a function fails on your laptop, not in production when its shard moves. It becomes an `unserializable` dead letter, and a warning names the bad path ([0025](docs/decisions/0025-messages-on-the-wire-are-json-plus-refs.md)). Refs can go anywhere in a message, and arrive as refs.
- **Not guaranteed:** exactly-once delivery; availability while Postgres is unreachable, since every shard stops at its lease deadline rather than risk a second copy; a split-brain strategy, so while a partition lasts, the side that can't reach a shard's holder waits for it to heal, or for the holder to learn it was marked down and leave; encryption between nodes.
- **Not built:** spawning an actor on another node, looking an actor up by path on another node, and cluster singletons. Refs travel in messages, or come from sharding.

### The secret, and the private network

`tcpTransport` frames JSON on `node:net`, with nothing but Node underneath. Before anything else, each side proves it knows `secret` by answering a random challenge with an HMAC, so the secret itself never crosses the wire ([0027](docs/decisions/0027-nodes-talk-tcp-with-a-shared-secret.md)). A node that can't prove it is disconnected.

> **Nothing between nodes is encrypted.** Remoting lets a node tell any actor anything, so keep cluster traffic on a private network that only your nodes can reach, and keep the secret out of source control. `tcpTransport` listens on `127.0.0.1` unless you set `host`. When the address other nodes should dial differs from the one it listens on, as in Docker or behind NAT, set `advertise` to it.

### Failover

With the default leases (`ttlMs` 10,000, renewed every 3,000, given up 2,000 early), a node killed with `kill -9` has its entities back on the others once its leases expire. Over 60 kills of three nodes on TCP and Postgres, 20 on each of Node 22, 24 and 26, an entity on the killed node answered from another node after 10.4 to 11.0 s at the median, and 11.7 s at worst ([0031](docs/decisions/0031-failover-waits-for-the-lease-not-for-downing.md)). A graceful leave is much quicker: the handoff takes milliseconds, and no ask is lost.

Shorter leases fail over faster, at a price: a node that stalls, in a long GC pause or a slow Postgres, for longer than `ttlMs` minus `marginMs` loses every lease it holds. Pass `leases: { ttlMs, renewMs, marginMs }` to `joinCluster`, the same on every node, and keep `unreachableAfterMs` shorter than `ttlMs` minus `renewMs`. Every shard store call gives up after `leases.storeTimeoutMs`, `renewMs` by default. A renewal that times out counts as failed, and the holder still gives its shards up at its own deadline, whether the store answers or not.

Backstage works on a cluster node too. It adds a Cluster panel, with the members as this node sees them and a grid of who holds each shard, and shows the sharding tree above `/user`.

## Pitfalls

- **Don't await an `ask` inside `receive` to an actor that might ask you back.** An async `receive` holds the mailbox until it settles. If the other actor asks this one in turn, neither can answer until the ask times out. Use `pipeToSelf` for requests between actors: the mailbox stays open while the reply is on its way. Under the testkit, a piped ask also runs entirely on virtual time ([0010](docs/decisions/0010-piped-asks-stay-on-the-scheduler.md)). An awaited ask that can only time out makes `settle` throw.
- **Timers keep a Node process alive.** A system with active timers stops Node from exiting until you call `system.terminate()`, which cancels them.

## Backstage

Backstage is an inspector for a running system: the live actor tree with each mailbox's depth, the selected actor's state, messages and failures, and a persistent actor's journal, which you can scrub back through to see its state after any event. It only watches. Nothing in it can send a message or stop an actor ([0021](docs/decisions/0021-backstage-only-watches.md)).

In Node, `serveBackstage` serves it on localhost:

```ts
import { serveBackstage } from '@kylewillett/troupe/backstage/server';

const backstage = await serveBackstage(system); // { port: 7070, host: '127.0.0.1' } by default
console.log(`Backstage: ${backstage.url}`);
// ...
await backstage.close();
```

Open the URL in a browser. The UI ships in the package, so it needs nothing else and works offline. `port: 0` picks a free port. It streams the system with server-sent events, and reconnects by itself if the process restarts ([0023](docs/decisions/0023-backstage-server-uses-sse.md)).

> **Backstage shows every message and every state.** Keep it on a loopback address, as it is by default. Binding `host` to anything else shows them to whoever can reach that address. On loopback, it refuses requests whose `Host` header isn't a name for the address it serves, which stops other sites in your browser from reaching it through DNS rebinding, and it sends no CORS headers.

`npm run example:backstage` builds the package and runs [examples/backstage](examples/backstage): the demo's opening night on real time and SQLite, with Backstage on <http://127.0.0.1:7070/>. Ten seconds in, `hamlet` gets a bad request, so there's a crash and a restart to look at.

In a page of your own, beside your own views, `mountBackstage` draws it in an element you give it, on a system in the page or on anything else that speaks its protocol:

```ts
import { backstage } from '@kylewillett/troupe/backstage';
import { mountBackstage } from '@kylewillett/troupe/backstage/ui';

const ui = mountBackstage(document.getElementById('inspector')!, {
  client: backstage(system),
  selected: undefined,
  onSelect: (path) => ui.update({ selected: path }),
  explain: { tree: 'The box office and its shows.' },
});
ui.update({ client: backstage(restartedSystem) }); // a new system: Backstage starts over
ui.unmount();
```

The selection is the page's: picking an actor calls `onSelect`, and it's selected once you pass it back as `selected`, so your own views can select it too. `explain` adds your words to each panel's. React is inside this entry point, so your page needs none, whatever it's built with, and the package still has no dependencies. Nothing else in the package loads it ([0045](docs/decisions/0045-backstage-embeds-with-a-mount-function-and-react-inside.md)).

## The box office example

`npm run example` builds the package and runs [examples/box-office](examples/box-office) on real time, on a SQLite file at `.troupe/box-office.db`, which it deletes at the start of each run so the story repeats. A box office actor spawns one show per production, and each show is a persistent actor whose events are `held`, `confirmed` and `released`. Customers hold seats with `ask`, and holds expire on a timer unless they're confirmed.

A malformed request crashes `hamlet`, which restarts with backoff and recovers its holds from the journal, so Carol's confirm still succeeds. Then the system terminates, a new one opens the same file, and every show comes back with its sales.

One thing doesn't come back exactly: a recovered hold gets a fresh timer for the full hold time, because holds don't remember how long they had left. Durable timers are a later idea. [test/examples/box-office.test.ts](test/examples/box-office.test.ts) runs the same story under the testkit, with two systems sharing one in-memory backend.

## Festival night in Docker

Three nodes, a crowd and Postgres, from this repository's `examples/cluster/`, in Docker Compose. Each show is an entity, and the crowd, a node that hosts nothing, buys seats at a dozen shows over and over. You need Docker and Node 22.18 or later.

```bash
npm ci
npm run cluster:up
```

It builds the package into an image, starts everything, and follows the log in plain words: who's up, which node has which shows, and what happens when something goes wrong. Each node serves Backstage on its own port, so open <http://127.0.0.1:7071/> for node-1, 7072 and 7073 for the others, and 7074 for the crowd, whose shard grid is its routing table.

In another terminal, kill a node:

```bash
docker compose -f docker-compose.cluster.yml kill node-2
```

node-2's shows stop answering, and the crowd's asks to them time out for about ten seconds, until their leases run out. Then they answer from node-1 and node-3, with every sale they had confirmed:

```text
  17.6s  the-tempest didn't answer in time. The crowd keeps asking.
  20.0s  node-2 stopped answering heartbeats. Its shows can't be reached.
  25.1s  the-tempest answers again, now from node-3, 9.8 s after its last sale on node-2. It picked up at sale 85, so its 82 confirmed sales survived.
```

Start it again, and shows move back to it, a few at a time:

```bash
docker compose -f docker-compose.cluster.yml start node-2
```

Stop one gracefully, and it hands its shows off before it exits, with no ask lost:

```bash
docker compose -f docker-compose.cluster.yml stop node-3
```

`npm run cluster:down` removes it all. The log is JSON lines underneath: `docker compose -f docker-compose.cluster.yml logs crowd` shows them as written. The nodes share a demo secret, which you can change with `CLUSTER_SECRET` in a `.env` file. `npm run cluster:smoke` runs the same story as a check, and CI runs it on every push.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

The Postgres tests need a database. `npm run postgres:up` starts one on port 5440 with Docker, or you can point `TROUPE_POSTGRES_URL` at your own.

```bash
npm run postgres:up
npm run test:integration && npm run coverage
npm run test:cluster   # real node processes on TCP and that Postgres, killed and restarted
npm run postgres:down
```

Design decisions are recorded in [docs/decisions](docs/decisions/README.md).

## License

MIT
