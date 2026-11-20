# Milestone 1: Local typed actors

Source: [roadmap](roadmap.md), Milestones → 1.

## Outcome

In one process, you can:

- define typed actors as a state plus a reducer
- spawn them into a parent and child hierarchy
- send with `tell`, and request and reply with `ask`
- watch other actors stop

A failed actor is stopped, resumed or restarted, according to the supervision strategy its parent chose. Timers and `pipeToSelf` deliver messages to their actor. Every source of time and randomness is injected, so the testkit runs all of this on virtual time, and the same seed gives the same run.

**Demo at the end:** `npm run example` runs the box office example, `examples/box-office`. A box office actor spawns one child actor per show. Customers hold seats with `ask`. Holds expire on a timer unless they're confirmed. A malformed request crashes a show, which restarts with backoff, and the narrated log shows every step. The restarted show has forgotten its holds, which sets up milestone 2.

## Scope

In scope:

- `actor()` definitions, `ActorRef<M>`, `ActorContext<M>`, and `createActorSystem()`
- A mailbox per actor and a shared dispatcher: one message at a time per actor, async `receive` included, fairness across actors, and yielding to the event loop
- Paths and names, a parent and child hierarchy, stops that recurse, and death watch
- Supervision: stop, resume, restart (with limits), and restart with backoff
- `ask` with timeouts, keyed timers, and `pipeToSelf`
- Dead letters, bounded mailboxes, a system event stream, and an injectable logger
- The `Scheduler` interface, a real one, and `ManualScheduler` for virtual time
- The `/testkit` entry point: `createTestKit()`, `TestProbe`, `settle()`, `advance(ms)`, and a seeded random
- Unit tests, type tests, an example app, and a README

Out of scope (later milestones):

| Item | Milestone |
| --- | --- |
| Persistent actors, journals, snapshots | 2 |
| Message-level tracing events (received, processed, mailbox depth) for the inspector | 3 |
| Backstage inspector, demo site, benchmarks, npm release | 3 |
| Serialization, remoting, refs that cross processes, cluster sharding | 4 |
| Simulated network and journal, fault injection | 5 |
| Worker threads, routers, OpenTelemetry | Later |

Design for these without building them. In particular:

- `ActorRef` is an interface that a remote ref could implement later.
- Nothing in the public API assumes that sender and receiver share memory.
- The scheduler and random sources must be the only ways the core reads time or chance.

## Design

### Defining an actor

An actor is an initial state plus a reducer ([0001](decisions/0001-state-and-reducer-actors.md)):

```ts
import { actor, createActorSystem, type ActorRef } from '@kylewillett/troupe';

type CounterMsg =
  | { type: 'inc'; by: number }
  | { type: 'get'; replyTo: ActorRef<number> };

const counter = actor<CounterMsg, number>({
  initial: 0,
  receive(count, msg, ctx) {
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
const n = await ref.ask((replyTo) => ({ type: 'get', replyTo })); // 2
```

```ts
export interface ActorDef<M, S> {
  /** The starting state, or a factory for it. Runs on start and on every restart. */
  initial: S | ((ctx: ActorContext<M>) => S);
  /** Handles one message and returns the next state. */
  receive(state: S, msg: M, ctx: ActorContext<M>): S | Promise<S>;
  /** Handles lifecycle signals. Optional. */
  onSignal?(state: S, signal: Signal, ctx: ActorContext<M>): S | Promise<S>;
}

/** Identity helper, so M and S are inferred and checked in one place. */
export function actor<M, S>(def: ActorDef<M, S>): ActorDef<M, S>;
```

- State is a plain value: data, not functions or class instances with behaviour. A function as `initial` is always called as a factory. This rule is what lets milestones 2 and 3 snapshot and display state.
- `initial` is synchronous. Loading state from storage is what persistent actors are for, in milestone 2.
- There's no "unhandled message" concept. Protocols are discriminated unions, and TypeScript's exhaustiveness checks cover them.
- `actor()` returns a definition, not a running actor. One definition can be spawned many times.

### Refs

```ts
export interface ActorRef<M> {
  readonly path: string;
  readonly tell: (msg: M) => void;
  readonly ask: <R>(build: (replyTo: ActorRef<R>) => M, opts?: AskOptions) => Promise<R>;
}

/** A ref to an actor of any protocol, for watching, stopping and comparing. */
export type AnyRef = ActorRef<never>;
```

- `tell` and `ask` use property syntax, not method syntax, so `ActorRef` is **contravariant** in `M`. An `ActorRef<A | B>` can be used where an `ActorRef<A>` is expected, but not the other way round. Method syntax would be checked bivariantly and allow both. A type test checks this, along with the fact that every `ActorRef<X>` is assignable to `AnyRef`.
- `tell` never throws and never blocks. If the target can't take the message, it becomes a dead letter.
- A ref belongs to one **incarnation** of one actor. The same ref survives restarts. Once the actor has stopped, its old ref sends to dead letters, even if a new actor is spawned at the same path. `spawn` and `ctx.self` return the same object for one incarnation, so `===` compares refs.
- Messages from one sender to one receiver arrive in the order they were sent. In one process, a mailbox is FIFO for everyone.

### Actor context

`ctx` is passed to `initial`, `receive` and `onSignal`:

```ts
export interface ActorContext<M> {
  readonly self: ActorRef<M>;
  readonly log: Logger;                 // the system logger, with { path } added to every entry
  now(): number;                        // the scheduler's time, in ms
  spawn<C, CS>(def: ActorDef<C, CS>, name?: string, opts?: SpawnOptions): ActorRef<C>;
  stop(ref?: AnyRef): void;             // self when omitted, otherwise a child
  watch(ref: AnyRef): void;
  unwatch(ref: AnyRef): void;
  child(name: string): AnyRef | undefined;
  children(): readonly AnyRef[];        // in spawn order
  readonly timers: Timers<M>;
  pipeToSelf<T>(promise: PromiseLike<T>, map: (result: Result<T>) => M): void;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
```

- `ctx` belongs to one incarnation. After that incarnation stops or restarts, `spawn` throws `ActorStoppedError`, `watch` and the timer methods do nothing, and `self.tell` sends to the mailbox (and so to dead letters, once the actor has stopped).
- `ctx.stop(ref)` throws `NotAChildError` if `ref` is neither `self` nor a child.

### Signals

```ts
export type Signal =
  | { type: 'preRestart'; error: unknown }           // before a restart, with the old state
  | { type: 'postStop' }                             // after all children have stopped
  | { type: 'terminated'; ref: AnyRef; failure?: unknown }; // a watched actor stopped
```

The state returned from `terminated` becomes the new state. Anything returned from `preRestart` or `postStop` is ignored. If either of those throws, the error is logged and the stop or restart goes ahead.

### System

```ts
export function createActorSystem(opts?: ActorSystemOptions): ActorSystem;

export interface ActorSystemOptions {
  name?: string;            // default "troupe"; lower-case letters, digits and "-"
  scheduler?: Scheduler;    // default realScheduler()
  random?: () => number;    // default Math.random; used for backoff jitter
  logger?: Logger;          // default consoleLogger("warn")
  askTimeoutMs?: number;    // default 5000
  throughput?: number;      // messages one actor runs per turn, default 10
  yieldAfter?: number;      // messages the dispatcher runs before yielding to the event loop, default 1000
}

export interface ActorSystem {
  readonly name: string;
  spawn<M, S>(def: ActorDef<M, S>, name?: string, opts?: SpawnOptions): ActorRef<M>;
  stop(ref: AnyRef): void;               // top-level actors only, otherwise NotAChildError
  readonly events: EventStream;
  terminate(): Promise<void>;            // stops everything; resolves when all have stopped
  readonly whenTerminated: Promise<void>;
}

export interface SpawnOptions {
  supervision?: SupervisorStrategy;      // default: stop (see Supervision)
  mailbox?: { capacity?: number };       // default: unbounded
}
```

- Options are checked in `createActorSystem` and `spawn`, and anything that can't be used throws a `TypeError`. That includes non-positive integers, unknown option fields, and a `random` that isn't a function.
- After `terminate()` has been called, `spawn` throws `ActorSystemTerminatedError`, and every `tell` becomes a dead letter. Calling `terminate()` again returns the same promise.

### Paths and names

- The root is `/`. Actors spawned with `system.spawn` live under `/user`, and `ask`'s temporary refs live under `/temp`. A child's path is its parent's path plus `/<name>`, for example `/user/box-office/show-42`.
- A name matches `^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$`, so paths are safe in URLs when milestone 4 puts them on the wire.
- Omitting a name generates `$1`, `$2` and so on, counted per parent. A name that starts with `$` can only be generated, never passed in.
- An invalid name, or the name of a sibling that hasn't fully stopped yet, makes `spawn` throw `ActorNameError` synchronously. A name is free again once its actor has run `postStop` and terminated.

### Mailbox and dispatcher

Each actor has two queues. The **system queue** holds stop requests and `terminated` notifications. It's always read before the **user queue**, which holds messages, in FIFO order.

Every actor shares one dispatcher, which keeps a FIFO **ready queue** of actors that have work and aren't busy:

- `tell` adds the message to the user queue. If the actor is idle, the dispatcher adds the actor to the ready queue. If the dispatcher isn't running, `tell` starts it with `scheduler.runSoon` (a microtask in the real scheduler).
- A turn takes the actor at the front of the queue and runs up to `throughput` of its messages. If it still has work after that, it goes to the back of the queue, which keeps actors fair to each other.
- After `yieldAfter` messages in a row, the dispatcher stops and resumes through `scheduler.setTimer(fn, 0)`, a macrotask. This lets I/O and timers run even while actors message each other in a loop. Waking on microtasks and yielding on a macrotask ([0007](decisions/0007-microtask-wake-macrotask-yield.md)) keeps latency low without starving the event loop.
- **Async `receive`:** if `receive` returns a promise, the actor is *busy*. It leaves the ready queue, and its next message waits until that promise settles. Other actors keep running in the meantime ([0002](decisions/0002-async-receive-blocks-the-mailbox.md)). The same rule applies to `onSignal`.
- **Bounded mailbox:** with `mailbox.capacity`, a `tell` to a full user queue drops the message, which becomes a dead letter with reason `mailboxFull`. The system queue is never bounded.

Pitfall for the README: an actor that awaits `ask` to an actor that asks it back has deadlocked, until the ask times out. `pipeToSelf` avoids this, because the mailbox stays open while the reply is on its way.

### Stopping and death watch

- `ctx.stop()` stops the actor after its current message. `ctx.stop(child)` and `system.stop(ref)` put a stop request on the target's system queue, so it runs after the target's current message, before anything else queued.
- **Stopping order:**
  1. The actor stops taking messages, and its timers are cancelled.
  2. Every child is stopped, and the actor waits until all of them have terminated. This happens recursively, depth first.
  3. `postStop` runs (and is awaited if it returns a promise).
  4. The actor is marked terminated, and its name is freed in its parent.
  5. Every watcher gets `terminated`, and a `stopped` event is published.
- Messages left in the user queue, and any that arrive later, become dead letters with reason `stopped`.
- `watch(ref)` works on any actor, not only children. Watching twice is the same as watching once. Watching an actor that has already terminated delivers `terminated` straight away. After `unwatch(ref)` returns, no `terminated` for that ref arrives, even one that's already queued.
- `failure` is set on `terminated` when the actor stopped because supervision stopped it.
- Parents don't watch their children automatically, and nothing escalates in this milestone (see the open questions).
- `system.terminate()` stops `/user` the same way, then `/temp`. Its promise resolves after the last `stopped` event.

### Supervision

The parent chooses a child's strategy when it spawns the child ([0006](decisions/0006-supervision-chosen-at-spawn.md)):

```ts
ctx.spawn(show, 'show-42', { supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }) });
```

```ts
export type SupervisorStrategy =
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'restart'; maxRestarts: number; withinMs: number }
  | { type: 'backoff'; minMs: number; maxMs: number; randomFactor: number; resetAfterMs: number };

export const supervise: {
  stop(): SupervisorStrategy;
  resume(): SupervisorStrategy;
  restart(opts?: { maxRestarts?: number; withinMs?: number }): SupervisorStrategy;        // defaults: Infinity, Infinity
  restartWithBackoff(opts: { minMs: number; maxMs: number; randomFactor?: number; resetAfterMs?: number }): SupervisorStrategy; // defaults: 0.2, maxMs
};
```

**A failure** is an error thrown, or a promise rejected, by `initial`, `receive`, `onSignal` (`terminated` only), or a `pipeToSelf` mapper. A value thrown that isn't an `Error` still counts. The message that failed is dropped, not retried. Then:

- **stop** (the default): the actor stops as described above, with `failure` set.
- **resume**: the actor keeps its state and carries on with the next message.
- **restart**: in order:
  1. `preRestart` runs with the old state.
  2. Timers are cancelled.
  3. Children are stopped, and the actor waits for them to terminate.
  4. `initial` runs again.

  The mailbox, the ref and any watchers carry over. If there are more than `maxRestarts` failures within a rolling `withinMs` window, the actor stops instead, with `failure` set.
- **backoff**: the same as restart, but restart number *n* (counting from 0) waits `min(maxMs, minMs * 2^n) * (1 + random() * randomFactor)` ms first. While it waits, messages queue up and nothing is processed. *n* resets to 0 once the actor has run for `resetAfterMs` without failing.

A failure in `initial` during a restart is another failure, so a restart loop is limited by `maxRestarts`, or slowed by the backoff.

Every failure publishes a `failed` event and logs at `error`, with the path, the error, and what the strategy did.

### Ask

```ts
export interface AskOptions { timeoutMs?: number } // default: the system's askTimeoutMs
```

- `ref.ask(build)` creates a temporary ref under `/temp`, calls `build(tempRef)`, and `tell`s the result to `ref`.
- The first reply resolves the promise. Any later replies become dead letters with reason `askCompleted`.
- If no reply comes within `timeoutMs`, the promise rejects with `AskTimeoutError`, which carries the target path and the timeout. A reply that arrives after that is a dead letter.
- Asking a stopped actor makes the message a dead letter and times out. It doesn't fail fast, because a remote ref in milestone 4 won't know either (see the open questions).
- If `build` throws, `ask` rejects with that error and sends nothing.

### Timers

```ts
export interface Timers<M> {
  startSingle(key: string, msg: M, delayMs: number): void;
  startPeriodic(key: string, msg: M, intervalMs: number): void; // fixed delay from each firing
  cancel(key: string): void;
  cancelAll(): void;
  isActive(key: string): boolean;
}
```

- Starting a key that's already active replaces that timer.
- **A cancelled or replaced timer's message is never received**, even if it was already in the mailbox when the timer was cancelled. Timer messages carry a generation number that's checked when they're dequeued.
- Every timer is cancelled on stop and on restart. A single timer is no longer active once its message has been received.

### pipeToSelf

`ctx.pipeToSelf(promise, map)` waits for the promise without blocking the mailbox. When the promise settles, the actor gets the result as a message to itself. `map(result)` runs *inside the actor*, when that message is dequeued, so a mapper that throws is a failure that supervision handles. If the actor has stopped by then, the raw `Result` becomes a dead letter.

### Dead letters, events and logging

```ts
export type SystemEvent = { seq: number; at: number } & (
  | { type: 'spawned'; path: string }
  | { type: 'stopped'; path: string; failure?: unknown }
  | { type: 'failed'; path: string; error: unknown; directive: 'stop' | 'resume' | 'restart' }
  | { type: 'restarted'; path: string; attempt: number; delayMs: number }
  | { type: 'deadLetter'; recipient: string; message: unknown; reason: 'stopped' | 'mailboxFull' | 'askCompleted' | 'terminated' }
);

export interface EventStream {
  subscribe(listener: (event: SystemEvent) => void): () => void; // returns unsubscribe
}
```

- `seq` increases by one per event across the whole system, and `at` is the scheduler's time.
- Listeners are called synchronously, in order, as events happen. A listener that throws is logged and skipped. It can never affect an actor or another listener ([0003](decisions/0003-injected-scheduler-and-random.md) explains why events are synchronous).
- Events are the only observability in this milestone. Milestone 3 adds opt-in message-level events for the inspector. Nothing in the core depends on a logging or metrics library.

```ts
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
export function consoleLogger(level?: 'debug' | 'info' | 'warn' | 'error'): Logger; // default "warn"
export const silentLogger: Logger;
```

### Scheduler and runtime

```ts
export interface Scheduler {
  now(): number;                                        // ms; only differences matter
  runSoon(task: () => void): void;                      // FIFO, after the current task
  setTimer(task: () => void, delayMs: number): () => void; // returns cancel
}
export function realScheduler(): Scheduler; // performance.now(), queueMicrotask, setTimeout
```

- The core reads time only through `scheduler.now()`, schedules work only through the `Scheduler`, and draws chance only from `random` ([0003](decisions/0003-injected-scheduler-and-random.md)). Lint bans `Date.now`, `setImmediate`, `process` and `Buffer` in `src/`.
- The build has no Node types ([0004](decisions/0004-runtime-agnostic-core.md)). `src/globals.d.ts` declares the few globals that every runtime has: `setTimeout`, `clearTimeout`, `queueMicrotask`, `performance.now` and `console`.
- A timer handle from `setTimeout` is never `unref()`'d, because that's Node-only. A running system with active timers keeps a Node process alive, and `terminate()` lets it exit. The README says so.

### Testkit (`@kylewillett/troupe/testkit`)

```ts
export function createTestKit(opts?: { seed?: number; startTime?: number; system?: Omit<ActorSystemOptions, 'scheduler' | 'random' | 'logger'> }): TestKit;

export interface TestKit {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly events: readonly SystemEvent[];   // everything published, in order
  readonly logs: readonly LogEntry[];        // everything logged, at every level
  probe<M>(name?: string): TestProbe<M>;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  shutdown(): Promise<void>;                 // terminate, then settle
}

export interface TestProbe<M> {
  readonly ref: ActorRef<M>;
  expectMessage(match?: M | ((msg: M) => boolean)): M; // takes the next message, or throws
  expectNoMessage(): void;
  messages(): M[];                                       // takes all queued messages
  watch(ref: AnyRef): void;
  expectTerminated(ref: AnyRef): void;
}

export class ManualScheduler implements Scheduler { /* see T1 */ }
export function seededRandom(seed: number): () => number; // mulberry32
```

- **`settle()`** runs everything that can happen without time passing: queued tasks, timers that are due, and actors' messages. It keeps going until nothing is left. Async `receive` and `pipeToSelf` use real promises, so while any actor is busy, `settle` waits one real macrotask tick and looks again. It throws `SettleTimeoutError` if the system still isn't idle after 1,000 ticks, for example when an actor awaits a promise that never settles.
- **`advance(ms)`** moves virtual time forward. Timers fire in order of due time, then creation order. Before each one fires, the clock is set to its due time, and the kit settles after each. Timers that are scheduled during an `advance` and fall due within it fire too.
- Probe assertions are synchronous, because the test controls time. Call `await kit.settle()` (or `advance`), then assert. Probes live under `/temp/probe-<name>`.
- The kit wires in `seededRandom(seed ?? 1)` and a logger that records entries into `kit.logs`. The same test with the same seed produces the same `kit.events`.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T0. Scaffold the repo | Done | |
| T1. Scheduler and virtual time | Not started | |
| T2. Actor system, mailbox and dispatcher | Not started | |
| T3. Hierarchy, stopping and death watch | Not started | |
| T4. Supervision | Not started | |
| T5. Ask, timers and pipeToSelf | Not started | |
| T6. Testkit and determinism | Not started | |
| T7. Box office example and README | Not started | |

### T0. Scaffold the repo

- `package.json`:
  - `"name": "@kylewillett/troupe"`, `"version": "0.0.0"`, and `"private": true` until the milestone 3 release
  - `"type": "module"` and `"engines": { "node": ">=22.18" }` (the lowest 22.x that strips types without a flag, for the examples)
  - `"publishConfig": { "access": "public" }`, and `exports` for `.` and `./testkit`
- `.nvmrc` (26), `.gitignore`, `LICENSE` (MIT), Prettier, and ESLint with the `src/` runtime rules
- `tsconfig.json` for the editor and tests, and `tsconfig.build.json` for `src/` with no Node types
- Vitest with coverage, a 90% line threshold on `src/`
- GitHub Actions, on Node 22, 24 and 26: lint, typecheck, test, coverage, build

**Done when:**

- [x] `npm run lint && npm run typecheck && npm test && npm run build` passes on an empty suite, locally.
- [ ] The same passes in CI, once the GitHub remote exists.

### T1. Scheduler and virtual time

- `src/globals.d.ts`: the runtime globals listed under "Scheduler and runtime"
- `src/scheduler.ts`: `Scheduler` and `realScheduler()`
- `src/testkit/manual-scheduler.ts`: `ManualScheduler`, with `now()`, `runSoon`, `setTimer`, `runReady(): number` (runs queued tasks and due timers until none are left, and returns how many ran), `advanceTo(time)` and `pendingTimers()`. `advanceTo` is synchronous, and `kit.advance` builds on it in T6.
- `src/testkit/random.ts`: `seededRandom(seed)`

**Done when** tests cover:

- [ ] `realScheduler`: `runSoon` tasks run in FIFO order, after the current task. `setTimer` fires, and its cancel function stops it.
- [ ] `ManualScheduler`: timers fire in due order, and in creation order on a tie. `now()` reads each timer's due time while it runs. Tasks queued by a timer run before the next timer. A timer set during `advanceTo` that falls due within it fires. Cancel works, even after the timer is due but before it runs.
- [ ] `seededRandom`: the same seed gives the same sequence, different seeds give different ones, and every value is in `[0, 1)`.
- [ ] `npm run typecheck` still passes with the build config's empty `types`.

### T2. Actor system, mailbox and dispatcher

- `src/types.ts`: `ActorDef`, `ActorRef`, `AnyRef`, `ActorContext`, `Signal`, `Result`, `SpawnOptions`, `ActorSystemOptions`
- `src/actor.ts` (`actor()`), `src/system.ts` (`createActorSystem`), `src/cell.ts` (one actor's state, mailbox and lifecycle), `src/dispatcher.ts`, `src/names.ts`, `src/events.ts`, `src/logger.ts` and `src/errors.ts`
- A first `createTestKit()` with `settle()`, plus `TestProbe` with `expectMessage`, `expectNoMessage` and `messages`. T6 completes the kit. Later tasks use it from here on.

**Done when** tests cover:

- [ ] State is threaded through `receive`, and `initial` runs once, as a value or as a factory.
- [ ] 1,000 `tell`s from outside are each processed exactly once, in order.
- [ ] Async `receive`: the next message waits until the promise settles, while another actor's messages run in the meantime.
- [ ] Fairness: with two busy actors and `throughput: 2`, their messages interleave two at a time.
- [ ] Yielding, on the real scheduler: a real `setTimeout(0)` fires while two actors ping-pong without end.
- [ ] Paths, generated names, `ActorNameError` for invalid, reserved and duplicate names, and `ctx.self === ` the spawned ref.
- [ ] A bounded mailbox drops overflow as a `deadLetter` event with reason `mailboxFull`.
- [ ] Option validation throws `TypeError` for each bad option, unknown fields included.
- [ ] Events have increasing `seq` and the scheduler's `at`. A listener that throws doesn't affect actors or other listeners. Unsubscribing works.
- [ ] Type tests (`expectTypeOf`): `ActorRef` is contravariant in `M`, every ref is assignable to `AnyRef`, and `actor()` infers `M` and `S`.

### T3. Hierarchy, stopping and death watch

**Done when** tests cover:

- [ ] `ctx.spawn` creates children under the parent's path. `child(name)` and `children()` work, in spawn order.
- [ ] Stopping order: children terminate depth first, then the parent's `postStop` (awaited when it's async), then watchers get `terminated`, then the `stopped` event. Check it with an event log on a three-level tree.
- [ ] `ctx.stop()` finishes the current message. Messages queued after it, and any sent later, are dead letters with reason `stopped`.
- [ ] `ctx.stop(child)` jumps the child's user queue. `ctx.stop(notAChild)` throws `NotAChildError`.
- [ ] A name is reusable only after its actor has terminated, and an old ref never reaches the new actor.
- [ ] Watch is idempotent. Watching a terminated actor delivers `terminated` at once. A `terminated` that's already queued isn't delivered after `unwatch`.
- [ ] `system.terminate()` stops everything, resolves after the last `stopped` event, and returns the same promise each time. Afterwards `spawn` throws `ActorSystemTerminatedError` and `tell` is a dead letter with reason `terminated`.

### T4. Supervision

`src/supervision.ts`: `supervise` and the strategy logic.

**Done when** tests cover:

- [ ] The default is stop. `terminated` carries `failure`, and a `failed` event records the directive.
- [ ] Each failure source triggers supervision: a throw in `receive`, a rejection in async `receive`, `initial`, `terminated` in `onSignal`, and a thrown value that isn't an `Error`.
- [ ] Resume keeps the state and drops only the failing message.
- [ ] Restart runs `preRestart` with the old state, stops the children, cancels the timers and runs `initial` again. It keeps the mailbox, the ref and the watchers.
- [ ] A restart limit: `maxRestarts: 2, withinMs: 1000` stops the actor on the third failure inside the window, and allows it once the window has passed.
- [ ] Backoff delays follow the formula exactly, under a seeded random. Messages wait during the delay, and the count resets after `resetAfterMs`.
- [ ] A throw in `preRestart` or `postStop` is logged and doesn't block the restart or stop.

### T5. Ask, timers and pipeToSelf

`src/ask.ts`, `src/timers.ts` and `pipeToSelf` in `src/cell.ts`.

**Done when** tests cover:

- [ ] `ask` resolves with the first reply, and later replies are dead letters with reason `askCompleted`.
- [ ] `ask` times out with `AskTimeoutError` at exactly `timeoutMs` of virtual time, and the error names the target. A reply after that is a dead letter.
- [ ] Asking a stopped actor times out. A `build` that throws rejects at once and sends nothing.
- [ ] A single timer fires once at its delay, and a periodic one fires every interval.
- [ ] Replacing or cancelling a timer drops its message, even one already in the mailbox.
- [ ] Timers are cancelled on stop and on restart.
- [ ] `pipeToSelf` doesn't block the mailbox. A resolved and a rejected promise each arrive as a `Result`. A mapper that throws goes to supervision. A result for a stopped actor is a dead letter.

### T6. Testkit and determinism

Complete `src/testkit/`: `advance`, `events`, `logs`, `shutdown`, the probe's `watch` and `expectTerminated`, and `SettleTimeoutError`.

**Done when** tests cover:

- [ ] `settle` waits for async `receive` and `pipeToSelf` chains, and throws `SettleTimeoutError` on a promise that never settles.
- [ ] `advance` fires timers in order, settles between them, and fires timers created during the advance.
- [ ] `expectMessage` with a value, with a predicate, and with no argument. Each failure message names the probe and what it got.
- [ ] **Determinism:** a scenario with timers, asks, a crash under backoff with jitter, and a stop runs twice with the same seed and gives identical `kit.events`. A different seed changes the backoff delays.
- [ ] A package test builds `dist/` and checks that both entry points load and export exactly the names in this spec.
- [ ] Every public export has a TSDoc comment.

### T7. Box office example and README

- `examples/box-office/`:
  - A `BoxOffice` actor spawns one `Show` child per show, with backoff supervision.
  - Customers use `ask` to hold and confirm seats. A hold expires on a timer unless it's confirmed.
  - A malformed request crashes a show, which restarts with backoff.
  - `main.ts` prints a narrated log from the event stream and `terminate()`s at the end.
- `npm run example` builds and runs it with real time.
- `test/examples/box-office.test.ts` runs the same scenario under the testkit, so the example can't rot.
- The README covers:
  - install and a quick start
  - defining actors, `tell` and `ask`, and the hierarchy
  - supervision, timers and `pipeToSelf`
  - the testkit
  - the ask deadlock pitfall, and the warning that timers keep a Node process alive until `terminate()`

**Done when:** the demo described in "Outcome" works from a clean clone, and the example test passes.

## Definition of done

- [ ] T0 to T7 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `coverage` and `build` all pass, locally and in CI.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies.
- [ ] `src/` builds with no Node types and imports no Node built-ins.
- [ ] The public API is exported only from `src/index.ts` and `src/testkit/index.ts`.

## Decision records

This milestone sets up records 0001 to 0007 in `docs/decisions/`. 0001, 0004 and 0005 are Accepted. The rest are Proposed, and the tasks named in each one prove them. If the design changes during implementation, update the matching record in the same commit.

## Open questions

1. **Escalation.** Should an unhandled `terminated` from a watched child fail the watcher, like Akka Typed's death pact? This spec says no for now: nothing escalates, and a parent that cares watches its children. Revisit when milestone 2's entities need it.
2. **Fail fast on asking a stopped actor.** Locally, we know the target has stopped and could reject `ask` at once. This spec times out instead, so local behaviour matches what a remote ref can know in milestone 4. Reconsider if the testkit makes this painful.
3. **A timeout for `receive`.** An async `receive` that never settles leaves the actor busy for good. Should `SpawnOptions` take a `receiveTimeoutMs` that counts as a failure? This spec says no for now, and `settle` catches it in tests.
4. **Checking that messages can be serialized.** Should the testkit be able to check that every message survives `structuredClone`, apart from refs, to catch messages that milestone 4 couldn't send over the wire? It's deferred to milestone 4, when codecs exist.
