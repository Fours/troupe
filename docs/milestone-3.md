# Milestone 3: Backstage inspector, demo app and demo site

Source: [roadmap](roadmap.md), Milestones → 3. The release, demo and deploy patterns follow rate-limiter's milestone 5. Open questions answered in spec review on 2026-11-22.

## Outcome

A visitor opens `troupe.kylewillett.com` and watches a real Troupe system running in their browser, with no backend. On one page they can:

- see the actor tree change as actors spawn and stop
- watch a mailbox fill during a rush and drain afterwards
- crash a show and see its supervisor restart it with backoff, and its state come back from the journal
- take the journal down and bring it back, and watch every show fail, wait and recover
- pick a show and scrub its event timeline back through time, seeing its state after each event

The same inspector, Backstage, attaches to a system in Node too. `serveBackstage(system)` serves the UI on localhost and streams the system to it.

`@kylewillett/troupe` 0.1.0 is on npm, published from CI with provenance. A benchmark gives the first performance baseline, and the site carries a design write-up built from `docs/decisions/`.

**Demo at the end:** open the site. Opening night at the box office: customers arrive, hold seats, and confirm or walk away, and holds expire. Press "Rush" and the shows' mailboxes fill and drain. Press "Bad request" and `hamlet` crashes, restarts after 200 ms, and recovers its holds. Press "Journal down" and every show fails on its next write and retries with growing backoff. Press it again and they recover. Click `hamlet` and drag its timeline back to event 3 to see its seats as they were then. Then read "How Troupe works", and `npm install @kylewillett/troupe`.

## Scope

In scope:

- **Message events.** `delivered` and `processed` events, which a subscriber opts into, with mailbox depth and, where it's known, the sender
- **Inspection hooks**, internal and never exported: the actor tree, each actor's state, and a persistent actor's state at any sequence number
- **The `/backstage` entry point** (any runtime): the inspector protocol, a wire encoding for messages and state, and an in-process source
- **The `/backstage/server` entry point** (Node): `serveBackstage()`, which serves the UI and streams the protocol over HTTP
- **The Backstage UI** (React, Vite, plain CSS): the live tree, actor details, the failure and restart history, and the event timeline with time travel
- **The demo:** opening night at the box office, with simulated customers and fault buttons, running in the browser on the in-memory backend
- **A benchmark** (ping-pong, ask, fan-out, spawn, message events on and off, and journal appends on each backend), with its setup recorded, as the baseline
- **The first npm release**, 0.1.0, from CI with trusted publishing and provenance, after an API review
- **The design write-up**, a page on the demo site
- **The demo site** at `troupe.kylewillett.com`, deployed the portfolio's way, with PostHog, and linked from the portfolio and the README

Out of scope:

| Item | Where |
| --- | --- |
| Sending messages to actors, or stopping them, from Backstage. It only watches ([0021](decisions/0021-backstage-only-watches.md)) | Later, if ever |
| Inspecting several nodes at once | Milestone 4 |
| Recording a run and replaying it from its seed in the UI | Milestone 5 (Rehearsal) |
| Comparing throughput with other actor libraries. Their semantics differ too much for one number to mean anything | Not planned |
| A hosted backend for the demo | Not planned: the core runs in the browser, which is the point ([0004](decisions/0004-runtime-agnostic-core.md)) |
| 1.0. The API still moves in milestones 4 and 5 | After milestone 4 |
| OpenTelemetry tracing | Later. Message events are what it would build on |
| Journal timeouts (milestone 2, open question 2) | Milestone 5 |

Design for these without building them. In particular:

- The protocol is JSON over a transport, and refs travel as paths, so milestone 4 can send it from another node.
- Message events go to any subscriber that asks for them, not only Backstage, so tracing can use them later.
- Backstage reads a persistent actor's history from the journal, never from the live actor, so it works the same for an entity on another node.

## Design

### Message events

Milestone 1 left message-level events for this milestone. They're two new `SystemEvent` variants:

```ts
/** A message went into an actor's mailbox. Published only to subscribers that asked for messages. */
| {
    readonly type: 'delivered';
    readonly path: string;
    /** Unique per message in this system, so `processed` can be matched to it. */
    readonly id: number;
    /** The sending actor's path, when it's known (see below). */
    readonly from?: string;
    readonly message: unknown;
    /** The mailbox's size after this message went in. */
    readonly depth: number;
  }
/** An actor finished handling a message, including any async work it awaited. */
| {
    readonly type: 'processed';
    readonly path: string;
    readonly id: number;
    /** Scheduler time from taking the message to settling. 0 under virtual time for sync work. */
    readonly durationMs: number;
    /** The mailbox's size after this message came out. */
    readonly depth: number;
    /** Whether the handler returned a different state object. */
    readonly stateChanged: boolean;
    /** Present, and true, for a cancelled timer's message, which no handler saw. */
    readonly skipped?: true;
  }
```

```ts
export interface EventStream {
  subscribe(listener: (event: SystemEvent) => void, opts?: { messages?: boolean }): () => void;
}
```

- **Opt-in per subscriber** ([0020](decisions/0020-message-events-are-opt-in.md)). A listener gets `delivered` and `processed` only if it subscribed with `{ messages: true }`. While no subscriber has, the system doesn't build them at all, so the cost is one check per message. The benchmark measures that cost (T1, T2).
- **`seq` is shared.** Every published event takes the next `seq`, so a subscriber without messages sees gaps while one with messages is attached. `seq` orders events. It no longer counts them, and the TSDoc says so.
- Only messages through the mailbox get these events: `tell`s, timer messages and `pipeToSelf` results. Signals are already visible as `stopped`, `failed`, `restarted` and `terminated`.
- A message that can't get into the mailbox gets a `deadLetter` event, as now, and no `delivered`.
- **Every `delivered` ends exactly once**, so the UI can track each message by `id`:
  - a `processed`, including when the handler fails, which comes before the `failed` event
  - a `deadLetter` with the same `id`, when a stop drains the message from the mailbox (`deadLetter` gains an optional `id`, set when message events are on)
  - a `processed` with `skipped: true`, for a timer message whose timer was cancelled after it was queued, whether it's taken or drained. Today these vanish without an event.
- **The sender is best-effort** ([0020](decisions/0020-message-events-are-opt-in.md)). `from` is the path of the actor whose handler is running when the `tell` happens: in `initial`, `receive` or `onSignal`, before any `await`. The dispatcher already knows which cell it's running, so this needs no change to `tell`. After an `await`, the runtime-agnostic core can't know the sender, since there's no `AsyncLocalStorage` in every runtime, so `from` is absent. Persistent actors run their effect steps through an internal hook that sets the sender, so `thenReply` replies have one. Sends from outside any actor, and from timers, have none.
- `message` is the object itself, not a copy. The encoder (below) decides what crosses a wire.

### Inspection hooks

Backstage needs things the public API doesn't offer, such as an actor's state. They're internal hooks, keyed by symbols that aren't exported, as milestone 2's start hook is. They aren't public API, so user code can't come to depend on reading another actor's state.

- **The system** gets a hook giving its scheduler, and a walk of the tree: for each cell, its path, its status (`starting`, `running`, `restarting` or `stopping`), its mailbox depth, its current state, and whether it's a persistent actor.
- **A persistent actor's definition** gets a hook with its `persistenceId`, its `persistence`, and `stateAt(seq)`. `stateAt` reads the journal from the start up to `seq`, in pages of 256, upcasting, checking and folding each event as recovery does, and returns the state after event `seq`. It shares recovery's code. It never touches the live actor, and it doesn't use a snapshot, since only the latest one is kept.
- The hooks only read. Nothing they return lets the caller change an actor.

### The protocol (`@kylewillett/troupe/backstage`)

```ts
/** Attaches an inspector to a system. Runs in any runtime. */
export function backstage(system: ActorSystem, opts?: BackstageOptions): BackstageSource;

export interface BackstageOptions {
  /** How many lifecycle events to keep for a new connection's history. Default 500. */
  history?: number;
}

export interface BackstageSource {
  /** Calls `listener` with a `hello` frame at once, then an `event` frame for every event. */
  connect(listener: (frame: Frame) => void): () => void;
  /** Answers one request. Read-only. */
  request(req: BackstageRequest): Promise<BackstageResponse>;
  /** Unsubscribes from the system. Every connection ends. */
  close(): void;
}

export type Frame =
  | {
      readonly type: 'hello';
      readonly protocol: 1;
      readonly system: string;
      readonly now: number;
      readonly actors: readonly ActorInfo[];
      /** Lifecycle events since the source attached, oldest first, at most `history`. */
      readonly history: readonly WireEvent[];
    }
  | { readonly type: 'event'; readonly event: WireEvent };

export type BackstageRequest =
  | { readonly type: 'state'; readonly path: string }
  | { readonly type: 'timeline'; readonly path: string; readonly fromSeq: number; readonly limit: number }
  | { readonly type: 'stateAt'; readonly path: string; readonly seq: number };
```

- Every frame and response is a JSON value, so a transport sends it with `JSON.stringify` and nothing else. The in-process source hands the same objects to the UI.
- `backstage()` subscribes with `{ messages: true }`, so attaching it turns message events on, and closing it turns them off again if nothing else wants them.
- The source keeps a ring of recent lifecycle events (`spawned`, `stopped`, `failed`, `restarted`, `persisted`, `recovered` and `deadLetter`) for `hello.history`, so a page opened after a crash still shows it. Message events aren't kept: the UI keeps its own.
- **Requests.** `state` returns an actor's current state. `timeline` returns a persistent actor's stored events from `fromSeq`, at most `limit` (up to 256), as the journal stored them, version and tags included, plus its `lastSeq`. `stateAt` returns its state after event `seq`, through the hook above. An unknown path, a non-persistent actor or a `seq` past the end is an error response, not a rejection. A request that isn't one of these is a `TypeError` response.
- **Backstage only watches** ([0021](decisions/0021-backstage-only-watches.md)). No request changes the system. The demo's buttons belong to the demo, not the protocol.

**The wire encoding.** Messages and states can hold things JSON can't: refs, errors, `undefined`, `Map`s, functions, cycles. `encode(value)` turns any value into a JSON value, and the UI shows the markers for what they are:

| Value | Encoded as |
| --- | --- |
| A JSON value | itself |
| An `ActorRef` | `{ "$ref": "/user/box-office/hamlet" }` |
| An `Error` | `{ "$error": { "name": "RangeError", "message": "..." } }` |
| `undefined` in an object | left out, as JSON does. In an array, `null` |
| A non-finite number, a `bigint`, a function, a symbol, a `Map`, a `Set`, a class instance | `{ "$value": "Map(3)" }`, a short description |
| A value already on the path from the root (a cycle) | `{ "$cycle": true }` |
| Anything past 8 levels deep, or past 200 items in one container, or a string past 2,000 characters | cut there, with `{ "$truncated": n }` saying how many were left out |

A key that starts with `$` in user data is escaped as `$$`, so markers can't be forged. The limits are constants, tuned in T3 against the demo's states, and the encoder never throws.

### The Backstage UI

A React app with plain CSS, in `backstage/`. It's written against a small client interface that the in-process source and the HTTP client both implement, so the demo page and `serveBackstage` run the same UI.

- **The tree.** Every live actor, under `/user`, with its status and a mailbox depth bar. Temporary `ask` refs aren't actors and aren't shown. Spawns, stops and restarts animate, and stopped actors fade out rather than vanishing.
- **Actor details**, for the selected actor: its state, encoded and updated as it changes; its mailbox depth over the last 30 s; its recent messages, with sender, time in the mailbox and handling time; and its failure and restart history, with each error and the backoff it waited.
- **The timeline**, for a persistent actor: its events in sequence order, each with its tags and time. Dragging the scrubber, or using the arrow keys, picks an event, and the state panel shows the state after it, from `stateAt`, with what changed from the event before highlighted. "Live" returns to the current state. Results are cached, since history doesn't change.
- **Message flow.** The tree briefly highlights the link from sender to receiver for each message whose sender is known.
- **It keeps up.** Frames are applied to a store outside React, and the UI redraws at most once per animation frame. The store keeps bounded history: 200 messages per actor and 60 s of depth samples. It's a pure function from frames to a view model, with unit tests.
- It works from the keyboard, and reads well in light and dark.

### The demo: opening night

The demo domain is the box office, grown to be worth watching (open question 1). It's plain TypeScript in `demo/src/domain/`, with no React, and it uses the repo's own `src/` through the package name.

- **Actors.** A `box-office` with one persistent show per production (four shows, 40 to 120 seats). A `crowd` actor that spawns a `customer` actor for each arrival, at most 12 at a time. Each customer asks for a hold, waits a moment, then confirms or walks away, and stops. A `sales-board` projection follows the `sale` tag and keeps seats sold per show. So the tree has long-lived actors, short-lived ones churning, persistent ones and a projection.
- **Time** runs on a `ManualScheduler` from the testkit, which the page advances from `requestAnimationFrame` by the elapsed time times the speed: paused, ¼×, 1× or 4×. Pausing freezes the system, not just the UI ([0022](decisions/0022-demo-drives-virtual-time.md)). `advanceTo` runs timers synchronously, but the journal resolves on microtasks, so one big jump would fire timers ahead of writes that should have finished first. Each frame therefore advances in steps of at most 10 ms, letting promises settle between steps. T4 probes this before building on it. The random is `seededRandom`, so a given seed tells the same story.
- **Persistence** is `inMemoryPersistence()`, behind a wrapper in the demo that can fail every call.
- **Buttons:**
  - *Rush:* 30 customers at once, so mailboxes fill.
  - *Bad request:* a malformed hold to the selected show (or `hamlet`), which throws. Supervision restarts it with backoff, and it recovers from the journal.
  - *Journal down / up:* every append and read fails until it's back. Each show fails on its next write, and restarts with growing backoff until the journal returns.
  - *Restart the system:* terminates it and starts a new one on the same backend, so every show recovers.
- **Words first.** The page explains what's happening in plain words, next to Backstage, and the technical detail is one click away, as in rate-limiter's demo.

### The Node server (`@kylewillett/troupe/backstage/server`)

```ts
/** Serves Backstage for `system` on localhost. Node only. */
export function serveBackstage(system: ActorSystem, opts?: { port?: number; host?: string }): Promise<BackstageServer>;

export interface BackstageServer {
  /** Where to open it, such as http://127.0.0.1:7070/. */
  readonly url: string;
  /** Stops serving, ends every connection and closes the source. */
  close(): Promise<void>;
}
```

- `node:http` only, with no dependency ([0023](decisions/0023-backstage-server-uses-sse.md), open question 2). `GET /` serves the built UI, `GET /events` streams frames as server-sent events, and `POST /request` answers one request as JSON. Server-sent events are one way, which is all the stream needs, and the browser's `EventSource` reconnects by itself, getting a fresh `hello`.
- Frames are batched into one SSE message per 50 ms, on a timer from the system's scheduler, so the time rule holds.
- **Localhost only by default.** `host` defaults to `127.0.0.1`. The server refuses requests whose `Host` header isn't the address it serves, which blocks DNS rebinding, and it sends no CORS headers. The README says that Backstage shows every message and state, so binding it anywhere else exposes them.
- The UI is built into `dist/backstage-ui/` and ships in the package, so the server needs nothing else (open question 3). It's static files, not a dependency.
- `port` defaults to 7070. `0` picks a free one, and `url` says which.
- `npm run example:backstage` runs opening night in Node, on real time and SQLite, with `serveBackstage`, and prints the URL. It proves the same UI works over both transports.

### The benchmark

`npm run bench` runs `bench/run.ts` with Node's type stripping, against `dist/`. It's a baseline for later milestones, not a contest ([0019](decisions/0019-how-the-benchmark-measures.md)).

| Scenario | What it measures |
| --- | --- |
| Ping-pong | Two actors, 1,000,000 `tell`s back and forth: messages per second |
| Ask | 100,000 sequential `ask`s: round trips per second, and p50 and p99 latency |
| Fan-out | One parent, 10,000 children, one message to each and a reply back, 100 rounds |
| Spawn and stop | 10,000 actors spawned and stopped |
| Message events | Ping-pong with no subscriber, a plain one, and one with `{ messages: true }` |
| Journal appends | One stream, then 100 streams in parallel, on in-memory, SQLite (file) and Postgres |

- Each scenario warms up, then runs 10 times. The output is the median and the spread, with the machine, Node version, commit and exact command in a `setup.json` beside it.
- Results go in `docs/decisions/data/0019-.../`, one folder per run, as the decisions README asks.
- **The baseline comes first.** T1 runs it on milestone 2's code, before message events exist, so T2 can show that with no message subscriber, ping-pong is within the run-to-run spread of the baseline.
- **Found in T1: the yield timer sets the pace.** With the default `yieldAfter` of 1,000, a busy pair of actors spends most of its time in the dispatcher's zero-delay yield ([0007](decisions/0007-microtask-wake-macrotask-yield.md)), which Node clamps to about 1 ms. So ping-pong and fan-out also run as `-noyield`, with `yieldAfter` out of reach, and the message-events rows run that way. T2's check compares `events-none`, whose spread is a few percent, not the yield-paced `ping-pong`. Whether the yield should change is a question for the write-up (see 0019), not this milestone.
- The Postgres rows with 100 parallel streams answer milestone 2's open question 3, the cost of the journal-wide lock ([0016](decisions/0016-postgres-appends-take-a-journal-lock.md)). If the lock turns out to be the bottleneck, that's a finding for the write-up and milestone 4, not a change in this milestone.
- CI runs `npm run bench -- --quick` (one small run of each in-memory scenario) so the benchmark can't rot. CI's numbers are never recorded.

### Publishing

As rate-limiter does it ([0025](https://github.com/Fours/rate-limiter/blob/main/docs/decisions/0025-publish-from-ci-with-provenance.md)):

- **An API review first.** Every export of every entry point has TSDoc, and a package test reads `dist/`'s `.d.ts` files to check that each entry point exports exactly a written list. Anything that shouldn't be public is removed while that's still free. `publint` and `@arethetypeswrong/cli` (ESM only) check the package as npm users see it, and `scripts/check-pack.js` fails on any file in the tarball outside `dist/`, the README, the licence and the changelog. All run in CI.
- `package.json` loses `"private": true` and gains `homepage`, `repository` and `bugs`. The version becomes 0.1.0, and `CHANGELOG.md` starts there.
- `.github/workflows/release.yml` runs on a `v*` tag. It runs all of CI (`ci.yml` becomes reusable), checks that the tag is exactly `v` plus the version and that the commit is on `main`, then publishes with OIDC trusted publishing from Node 24, so no npm token exists anywhere and npm adds provenance.
- **You do two things by hand.** If npm needs the package to exist before trusted publishing can be set up, you publish a placeholder from your machine. Then you add this repository and workflow as the trusted publisher on npmjs.com. Agents never run `npm publish`.
- **The tag needs your approval in chat** before it's pushed, like any public action.
- A smoke script installs the published version in an empty folder in Docker and runs the README's quick start, on Node 22 and 24.

### The write-up

A second page on the demo site, "How Troupe works", at `/how-it-works/`. It tells the story in the order a reader needs, not in record order, and every claim links to its record:

1. An actor here is a state and a reducer, and why (0001)
2. One message at a time, and how the dispatcher shares the thread fairly (0002, 0007)
3. Failure: supervision, restarts as new incarnations, and backoff (0006, 0008)
4. Asking without fooling yourself about remote actors (0009, 0010)
5. Why every clock and coin flip is injected, which is what makes the demo pausable and milestone 5 possible (0003)
6. Why the demo runs in your browser (0004, 0005)
7. Event sourcing: effects, holding the mailbox, two writers, JSON events, schemas (0011 to 0018)
8. The numbers: the benchmark, as charts
9. What's next: cluster sharding and Rehearsal

It opens with a summary a non-engineer can read on its own. Charts are built from `docs/decisions/data/` when the site builds, so they can't drift from the records, and a missing source fails the build. It's its own HTML entry, so it has its own URL, title and link preview, loads none of the demo, and gets its own pageviews.

### Deploying

`npm run deploy` the portfolio's way (`/add-s3-deploy`): build `demo/`, sync it to `s3://kylewillett.com/troupe/`, and invalidate the site's own CloudFront distribution at `troupe.kylewillett.com`. You create the distribution, the DNS record, and the CloudFront Function that serves folder URLs such as `/how-it-works/` (rate-limiter's [0035](https://github.com/Fours/rate-limiter/blob/main/docs/decisions/0035-folder-urls-with-a-cloudfront-function.md)). `CLOUDFRONT_DISTRIBUTION_ID` goes in the gitignored `scripts/deploy.config.local`, and PostHog's key in the gitignored `demo/.env.local`, without which the deploy refuses to run. PostHog is added with `/add-posthog`, lazy-loaded, and not loaded under automation.

### Layout and build

```
src/
  backstage/        the /backstage entry point: backstage(), the protocol types, encode()
  node/backstage/   the /backstage/server entry point: serveBackstage()
backstage/          the Backstage UI: React components, the store, and the two clients
  index.html        the standalone UI, built into dist/backstage-ui/
demo/               the demo site (Vite): the demo page and how-it-works/
  src/domain/       opening night: actors, the crowd, the faulty journal. No React
bench/              the benchmark
```

| Entry point | Runtime | Built with |
| --- | --- | --- |
| `@kylewillett/troupe/backstage` | any | `tsconfig.build.json`, no Node types |
| `@kylewillett/troupe/backstage/server` | Node | `tsconfig.build.node.json` |

- The UI and demo dependencies (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@playwright/test`, `posthog-js` and so on) are development dependencies of the root package. None of them ships: the UI ships only as built static files. One install, one lint and one typecheck cover everything (rate-limiter's open question 7).
- `npm run build` gains a Vite build of `backstage/` into `dist/backstage-ui/`. `npm run demo:dev` and `npm run demo:build` build the site into `demo/dist/`, which never ships.
- Lint keeps `backstage/` and `demo/` free of Node built-ins, and adds the React hooks rules there.
- Package tests check that `@kylewillett/troupe` and `/persistence` load nothing from `/backstage`, and that `/backstage` loads no Node built-in.
- The UI's store and the demo's domain have Vitest unit tests. A Playwright suite (Chromium) runs in its own CI job against the built site: the page loads, the tree appears, each button does what it says, the timeline scrubs, and it works from the keyboard and at the phone width chosen in open question 4. `src/`'s 90% line threshold is unchanged, and `backstage/` and `demo/` have no threshold.

## Tasks

Do these in order. Each one ends with passing tests.

| Task | Status | Commit |
| --- | --- | --- |
| T1. The benchmark and its baseline | In progress | |
| T2. Message events and inspection hooks | Not started | |
| T3. The Backstage protocol and in-process source | Not started | |
| T4. Demo foundation: opening night | Not started | |
| T5. The Backstage UI | Not started | |
| T6. The Node server | Not started | |
| T7. API review and the 0.1.0 release | Not started | |
| T8. The write-up | Not started | |
| T9. Deploy and link | Not started | |

### T1. The benchmark and its baseline

Write [0019](decisions/0019-how-the-benchmark-measures.md).

- `bench/`, `npm run bench`, `--quick` in CI
- A run on milestone 2's code, recorded in `docs/decisions/data/`

**Done when:**

- [x] Every scenario in the table runs, and prints the median and spread of 10 runs
- [ ] Each recorded run has a `setup.json` with the machine, Node version, commit and command, and rerunning that command reproduces it within its spread
  - *Not yet met in full.* Every `setup.json` is there. Rerunning put 35 of 45 medians inside their recorded ranges, all of `events-none`, `events-plain` and `ping-pong-noyield` among them. The misses are Postgres and the memory journal drifting 3 to 6% past the edge, and fan-out moving by 15 to 22% ([0019](decisions/0019-how-the-benchmark-measures.md), Evidence).
- [x] The baseline is recorded on Node 22, 24 and 26, on milestone 2's last commit
- [x] The Postgres parallel-streams rows are recorded, and milestone 2's open question 3 has its answer
- [x] `npm run bench -- --quick` runs in CI in under a minute

### T2. Message events and inspection hooks

Write [0020](decisions/0020-message-events-are-opt-in.md).

- The `delivered` and `processed` events, `subscribe`'s `messages` option, and the sender
- The system's and persistent actors' inspection hooks, including `stateAt`

**Done when** tests cover:

- [ ] A subscriber with `{ messages: true }` gets a `delivered` and a `processed` for every mailbox message, with matching ids, and the right depths during a burst
- [ ] A subscriber without it gets neither, and with no message subscriber none are built
- [ ] `from` is set for a `tell` in `initial`, `receive`, `onSignal` and a persistent actor's `thenReply`, and absent after an `await`, from outside an actor, and from a timer
- [ ] Every `delivered` ends exactly once: a `processed` (before the `failed`, when the handler throws), a `deadLetter` with its `id` when a stop drains it, or a skipped `processed` for a cancelled timer's message
- [ ] `stateChanged` is true only when the handler returned a different object
- [ ] The tree walk shows each actor's path, status, depth and state through a spawn, a restart and a stop
- [ ] `stateAt(n)` equals the state after `n` events, for every `n` of the box office's journal, including upcast events, and doesn't touch the live actor
- [ ] Determinism: with a message subscriber, two runs with the same seed give identical events
- [ ] The benchmark shows ping-pong with no message subscriber (`events-none`) within T1's spread. The numbers with one are recorded

### T3. The Backstage protocol and in-process source

Write [0021](decisions/0021-backstage-only-watches.md).

- `src/backstage/`: `backstage()`, `encode()`, the protocol types, and the `./backstage` export

**Done when** tests cover:

- [ ] `connect` gets a `hello` with every live actor and the recent history, then an `event` frame for each event
- [ ] A connection made after a crash sees the crash in `history`, and `history` keeps at most its limit
- [ ] Every frame and response survives `JSON.parse(JSON.stringify(...))` unchanged
- [ ] `encode` handles each row of the encoding table, escapes `$` keys, and never throws, including on a property test of arbitrary values
- [ ] `state`, `timeline` and `stateAt` answer correctly, and an unknown path, a plain actor or a `seq` past the end gives an error response
- [ ] `close` turns message events off again, and ends every connection
- [ ] A package test: `/backstage` loads, exports exactly its names, and loads no Node built-in, and the other entry points don't load it

### T4. Demo foundation: opening night

Write [0022](decisions/0022-demo-drives-virtual-time.md).

- `demo/`: the Vite app, with `demo:dev` and `demo:build`, and lint and typecheck covering it
- `demo/src/domain/`: the actors, the crowd, the faulty journal wrapper, and the driven clock
- A plain page with the buttons and a text log, which T5 replaces with Backstage
- The Playwright job in CI

**Done when:**

- [ ] Unit tests on the testkit: customers hold, confirm and walk away; holds expire; the sales board counts sales; each button does what the Design section says
- [ ] Journal down makes every show fail and back off, and journal up lets each one recover with its sales intact
- [ ] Two runs with the same seed tell the same story, event for event
- [ ] Pause stops the system's time. ¼× and 4× change how fast it passes
- [ ] The built page runs in Chromium, as a Playwright smoke test in CI

### T5. The Backstage UI

**Done when:**

- [ ] The store has unit tests: frames to view model, bounded history, dropped messages, and a fresh `hello` after a reconnect
- [ ] The demo page shows the tree, actor details, failure history and the timeline, live
- [ ] Scrubbing a show's timeline shows its state after each event, with the change highlighted, and "Live" returns to the present
- [ ] A rush of 30 customers at 4× keeps the page responsive: no frame takes longer than 50 ms in a Playwright trace
- [ ] Playwright covers the tree, each button, the timeline from mouse and keyboard, and the phone width from open question 4
- [ ] Someone non-technical can say what it shows without help (you check this)

### T6. The Node server

Write [0023](decisions/0023-backstage-server-uses-sse.md).

- `src/node/backstage/`, the `./backstage/server` export, the UI built into `dist/backstage-ui/`
- `npm run example:backstage`

**Done when** tests cover:

- [ ] `GET /` serves the UI, `GET /events` streams a `hello` then batched events, and `POST /request` answers
- [ ] A reconnect gets a fresh `hello`
- [ ] A request with another `Host` header is refused, and no CORS headers are sent
- [ ] `close()` ends every stream and closes the source, and `port: 0` reports the port it got
- [ ] Playwright opens `example:backstage`'s URL and sees the tree
- [ ] A package test: the entry point loads from `dist/`, and `dist/backstage-ui/` is in the tarball

### T7. API review and the 0.1.0 release

Write [0024](decisions/0024-publish-from-ci-with-provenance.md).

**Done when:**

- [ ] Every export of every entry point has TSDoc, and a package test checks each entry point's exact export list. Anything removed from the public API is listed in this section
- [ ] `publint`, `attw --pack --profile esm-only` and `scripts/check-pack.js` pass, and run in CI
- [ ] `package.json` has no `private`, and has `homepage`, `repository` and `bugs`, and version 0.1.0. `CHANGELOG.md` has a 0.1.0 entry
- [ ] `release.yml` publishes on a `v*` tag only after every CI check passes, and refuses a tag that doesn't match the version or isn't on `main`
- [ ] Trusted publishing is set up on npmjs.com (by you), and no workflow has an npm token
- [ ] After your approval in chat, `v0.1.0` is tagged and published, and npm shows its provenance
- [ ] In an empty folder, the published package's README quick start works on Node 22 and 24
- [ ] AGENTS.md and the README no longer say the package is unpublished

### T8. The write-up

**Done when:**

- [ ] The page covers the sections under Design, and every claim links to a decision record, checked by a test against `docs/decisions/`
- [ ] Its charts are built from `docs/decisions/data/` when the site builds, and a missing source fails the build, with a test
- [ ] It opens with a summary a non-engineer can read alone, and it works on a phone
- [ ] The README links to it, and `docs/decisions/README.md` says it's the public write-up

### T9. Deploy and link

**Done when:**

- [ ] `npm run deploy` builds and publishes the site, set up the portfolio's way, with PostHog
- [ ] The site is live at `troupe.kylewillett.com`, with both pages, and the Playwright suite passes against it
- [ ] The README and the npm page link to the site, and `homepage` in `package.json` is the site (a patch release carries it to npm)
- [ ] The portfolio links to it (a commit in the portfolio repo)

## Definition of done

- [ ] T1 to T9 are complete.
- [ ] `npm run lint`, `typecheck`, `test`, `test:integration`, `coverage` and `build` all pass, locally and in CI, and so does the Playwright job.
- [ ] Line coverage is at least 90% for `src/`.
- [ ] There are no runtime dependencies, and no peer dependencies.
- [ ] Everything outside `src/node/` builds with no Node types and imports no Node built-ins.
- [ ] `@kylewillett/troupe` 0.1.0 is on npm with provenance.
- [ ] The demo and the write-up are live and linked from the portfolio.
- [ ] Every results folder in `docs/decisions/data/` has a `setup.json`.

## Decision records

The tasks add these records, as Proposed, and accept them once their tests pass. Read [0001](decisions/0001-state-and-reducer-actors.md), [0003](decisions/0003-injected-scheduler-and-random.md), [0004](decisions/0004-runtime-agnostic-core.md) and [0005](decisions/0005-one-package-with-subpaths.md) first, since these build on them.

| # | Decision | Task |
| --- | --- | --- |
| 0019 | How the benchmark measures, and that it's a baseline, not a comparison | T1 |
| 0020 | Message events are opt-in per subscriber, and the sender is best-effort | T2 |
| 0021 | Backstage only watches: a read-only protocol of JSON frames, with refs as paths | T3 |
| 0022 | The demo drives virtual time from animation frames, so pausing pauses the system | T4 |
| 0023 | The Backstage server uses server-sent events on `node:http`, with no dependency | T6 |
| 0024 | Publishing from CI with trusted publishing and provenance, starting at 0.1.0 | T7 |

## Open questions

1. **The demo's domain.** The roadmap left it to this spec. Options: opening night at the box office, as above; a bank with transfers between accounts as a saga; or food delivery, with orders, kitchens and couriers. Recommendation: the box office. Readers of the README already know it, it has every moving part the outcome asks for (timers, churn, crashes, recovery, a projection), and it suits the theatre names. A saga would show more coordination, but it's a pattern the framework doesn't offer yet, so the demo would be teaching code that isn't in the library.

   *Answer (spec review, 2026-11-22): the box office, as opening night.*

2. **The Node server's transport.** Options: server-sent events and a `POST` on `node:http`, as above; a WebSocket server written on `node:http` by hand; or `ws` as an optional peer dependency. Recommendation: server-sent events. The stream only flows one way, it's about 100 lines with no dependency, and `EventSource` reconnects by itself. A hand-written WebSocket server is more code to get right for no gain here, and `ws` breaks "no peer dependencies". Milestone 4's node-to-node transport is a separate choice.

   *Answer (spec review, 2026-11-22): server-sent events and a `POST` on `node:http`, with no dependency.*

3. **Where the standalone UI lives.** Options: built into the package and served by `serveBackstage`, as above; or only on the demo site, connecting to a server on `localhost`. Recommendation: ship it. It's a few hundred KB of static files, it works offline and on any version, and an `https` page reaching `http://localhost` runs into mixed-content and CORS rules that differ between browsers.

   *Answer (spec review, 2026-11-22): built into the package and served by `serveBackstage`.*

4. **Phones.** Recruiters often open links on a phone. Options: a phone layout at 375 px that shows one Backstage panel at a time (tree, details or timeline) under the demo controls; or `/mobile-gate` on the demo page, pointing to the write-up. Recommendation: the one-panel layout, as rate-limiter's demo works on a phone. The write-up works on phones either way.

   *Answer (spec review, 2026-11-22): a 375 px layout that shows one Backstage panel at a time.*

5. **The version.** Recommendation: 0.1.0. The roadmap says 0.x, and the API will change in milestone 4. Under 0.x, a minor version can break.

   *Answer (spec review, 2026-11-22): 0.1.0.*

6. **The sender.** Options: best-effort from the running cell, as above; an explicit `tell(msg, { from })`; or no sender at all. Recommendation: best-effort. An explicit sender changes the `ActorRef` interface that milestone 4's remote refs implement, and puts the work on every caller. No sender loses the message-flow view. Best-effort covers most sends, since most handlers send before they await.

   *Answer (spec review, 2026-11-22): best-effort, from the running cell.*

7. **Message events in the public union.** Options: public `SystemEvent` variants behind `{ messages: true }`, as above; or private events that only Backstage sees. Recommendation: public. Anyone can build on them (tests, logging, later tracing), and the opt-in keeps them free for everyone else.

   *Answer (spec review, 2026-11-22): public `SystemEvent` variants behind `{ messages: true }`.*
