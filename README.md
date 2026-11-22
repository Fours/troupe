# Troupe

Typed actors for TypeScript, in the spirit of Akka: hierarchies, supervision, `ask`, timers, a testkit that runs on virtual time, and event-sourced persistent actors on an in-memory, SQLite or Postgres journal. Cluster sharding comes next.

> **Status:** early development, not published yet. See the [roadmap](docs/roadmap.md) and the specs for [milestone 1](docs/milestone-1.md) and [milestone 2](docs/milestone-2.md).

- **Typed:** each actor has one message type, and refs are checked against it.
- **No runtime dependencies**, and the core runs on any JavaScript runtime, not only Node.
- **Deterministic tests:** time, scheduling and chance are injected, so the testkit replays a run exactly from a seed.

## Install

The package isn't on npm yet. The first release comes with milestone 3. Until then, clone the repo:

```bash
git clone https://github.com/Fours/troupe.git
cd troupe
npm install
npm run example
```

Once it's released, it will be `npm install @kylewillett/troupe`. It needs Node 22.18 or later, and is ESM only. It's one package with several entry points:

| Entry point | What it has | Runs on |
| --- | --- | --- |
| `@kylewillett/troupe` | actors, systems, supervision, `ask`, timers | any runtime |
| `@kylewillett/troupe/testkit` | virtual time, seeded random, probes | any runtime |
| `@kylewillett/troupe/persistence` | persistent actors, projections, the in-memory backend | any runtime |
| `@kylewillett/troupe/persistence/sqlite` | the SQLite backend, on `node:sqlite` | Node |
| `@kylewillett/troupe/persistence/postgres` | the Postgres backend, on your own `pg` pool | any runtime with a pool |
| `@kylewillett/troupe/backstage` | Backstage, the inspector: its protocol and an in-process source | any runtime |
| `@kylewillett/troupe/backstage/server` | `serveBackstage`, the inspector's UI over HTTP | Node |

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
| `supervise.restartWithBackoff({ minMs, maxMs, randomFactor, resetAfterMs })` | A restart that first waits `minMs`, doubling each time up to `maxMs`, with random jitter. Messages queue up while it waits. |

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

- **`kit.settle()`** runs everything that can happen without time passing: queued messages, due timers, and async `receive` work. It throws `SettleTimeoutError` if an actor stays busy, for example awaiting a promise that never settles.
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

`persistentActor` returns an ordinary actor definition: spawn, name, watch and supervise it like any other. `id` names its event stream in the journal. Events and states must be JSON values, and are checked before they're written.

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

## The box office example

`npm run example` builds the package and runs [examples/box-office](examples/box-office) on real time, on a SQLite file at `.troupe/box-office.db`, which it deletes at the start of each run so the story repeats. A box office actor spawns one show per production, and each show is a persistent actor whose events are `held`, `confirmed` and `released`. Customers hold seats with `ask`, and holds expire on a timer unless they're confirmed.

A malformed request crashes `hamlet`, which restarts with backoff and recovers its holds from the journal, so Carol's confirm still succeeds. Then the system terminates, a new one opens the same file, and every show comes back with its sales.

One thing doesn't come back exactly: a recovered hold gets a fresh timer for the full hold time, because holds don't remember how long they had left. Durable timers are a later idea. [test/examples/box-office.test.ts](test/examples/box-office.test.ts) runs the same story under the testkit, with two systems sharing one in-memory backend.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

The Postgres tests need a database. `npm run postgres:up` starts one on port 5440 with Docker, or you can point `TROUPE_POSTGRES_URL` at your own.

```bash
npm run postgres:up
npm run test:integration && npm run coverage
npm run postgres:down
```

Design decisions are recorded in [docs/decisions](docs/decisions/README.md).

## License

MIT
