# Troupe

Typed actors for TypeScript, in the spirit of Akka: hierarchies, supervision, `ask`, timers, and a testkit that runs on virtual time. Event-sourced persistent actors and cluster sharding come next.

> **Status:** early development, not published yet. See the [roadmap](docs/roadmap.md) and the [milestone 1 spec](docs/milestone-1.md).

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

Once it's released, it will be `npm install @kylewillett/troupe`. It needs Node 22.18 or later, and is ESM only.

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

**State is a plain value:** data, not functions or class instances. Refs carry functions, so keep them out of state too: a parent finds its children with `ctx.child(name)`. Milestone 2 snapshots state, and the milestone 3 inspector displays it, so this rule matters.

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

A restart is a new incarnation: its state starts from `initial`, and whatever the old one held is gone. Every failure publishes a `failed` event and logs at `error`.

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

## Pitfalls

- **Don't await an `ask` inside `receive` to an actor that might ask you back.** An async `receive` holds the mailbox until it settles. If the other actor asks this one in turn, neither can answer until the ask times out. Use `pipeToSelf` for requests between actors: the mailbox stays open while the reply is on its way. Under the testkit, a piped ask also runs entirely on virtual time ([0010](docs/decisions/0010-piped-asks-stay-on-the-scheduler.md)). An awaited ask that can only time out makes `settle` throw.
- **Timers keep a Node process alive.** A system with active timers stops Node from exiting until you call `system.terminate()`, which cancels them.

## The box office example

`npm run example` builds the package and runs [examples/box-office](examples/box-office) on real time. A box office actor spawns one show per production. Customers hold seats with `ask`, and holds expire on a timer unless they're confirmed. A malformed request crashes a show, which restarts with backoff and forgets its holds. That last part is what milestone 2's persistent actors fix. [test/examples/box-office.test.ts](test/examples/box-office.test.ts) runs the same scenario under the testkit.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test && npm run coverage && npm run build
```

Design decisions are recorded in [docs/decisions](docs/decisions/README.md).

## License

MIT
