# 0021. Backstage only watches: a read-only protocol of JSON frames, with refs as paths

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

Backstage, the inspector, has to show a running system in the same page (the demo), from a Node process over HTTP (`serveBackstage`, T6), and later from another node (milestone 4). Whatever it receives has to cross a wire, but messages and states hold things JSON can't carry: refs, errors, `Map`s, functions, cycles. An inspector that can also act on the system would be a remote control for every actor, with every risk that brings, and a second way in that milestone 4 would have to secure.

## Decision

- **A source and a protocol.** `backstage(system)` in `@kylewillett/troupe/backstage` attaches to a system in any runtime. `connect(listener)` sends a `hello` straight away (every live actor under `/user`, the scheduler's time, and recent lifecycle history), then one `event` frame for every system event. `request` answers `state`, `timeline` and `stateAt`. The in-process source hands the frames to the UI as they are, and a transport sends them with `JSON.stringify` and nothing else.
- **It only watches.** No request changes anything. `state` reads the live tree through the internal inspection hook. `timeline` and `stateAt` read the journal, never the live actor, so they work the same for an entity on another node. The demo's fault buttons belong to the demo, not the protocol.
- **Every frame and response is a JSON value.** `encode(value)` turns anything into one, with markers the UI shows for what they are:
  - a ref, recognised by its shape (`path`, `tell`, `ask`) so remote refs encode the same, is `{ $ref: path }`
  - an `Error` is `{ $error: { name, message } }`
  - anything else JSON can't say is `{ $value: "Map(3)" }` and the like
  - a cycle is `{ $cycle: true }`
  - what's too big is cut with `{ $truncated: n }`, `n` being how many items it left out. A long string is `{ $string, $truncated }`.
  - user keys that start with `$` gain a `$`, so data can't forge a marker.
- **The limits are constants:** 8 levels of containers, 200 items per container, 2,000 characters per string, and 10,000 values per call. The last one wasn't in the spec. Without it, a value 200 wide and 8 deep is 200⁸ values, all within the other limits.
- **Encoding never throws.** A getter that throws, a proxy trap or a revoked proxy becomes `{ $value: "unreadable" }`, and the rest of the value still encodes. Each event is encoded once, as it happens, since a message object can change after it's sent. Each field is encoded on its own, so a message gets the full depth.
- **Errors are responses, not rejections.** A malformed request gives a `TypeError` response, a number out of range or past the end a `RangeError`, a path with no live actor `NotFoundError`, and a plain actor asked for its history `NotPersistentError`. A journal failure gives the name it failed with. A UI on the far side of a wire then has one shape to handle.
- **Attaching turns message events on** ([0020](0020-message-events-are-opt-in.md)), and `close` turns them off again unless another subscriber wants them. A source with no connections skips encoding message events, but still keeps lifecycle events (`spawned`, `stopped`, `failed`, `restarted`, `persisted`, `recovered`, `deadLetter`) in a ring of `history` (500 by default) for the next `hello`.
- **A connection that throws** is logged to the system's logger and skipped, like any event listener. The inspection hook gives the source the logger for this.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Requests that send messages or stop actors | A remote control for every actor, reachable from a browser tab. It's a second, unguarded way into the system that milestone 4 would have to secure, and the demo doesn't need it: its buttons are the demo's own code (out of scope in the spec) |
| Structured clone instead of JSON | Not every transport has it. SSE and HTTP carry text, and it still can't carry functions or refs |
| Refs by brand, a private symbol on refs the system makes | Milestone 4's remote refs are a different implementation of `ActorRef`. Shape works for any of them |
| Encode lazily, when a connection asks | The message may have changed by then, so the UI would show something that was never sent |
| A `superjson`-style encoding that round-trips `Map`s and `Date`s | Backstage only shows values, so it never needs to rebuild them. It's more format for no gain, and a dependency or a lot of code |
| Rejecting on errors | A transport would have to turn rejections into responses anyway, and a rejected promise over a wire loses its type |
| Reading history from the live actor | It wouldn't work for an entity on another node, and the live actor has only its current state |

## Evidence

- `test/backstage/source.test.ts`: `hello` lists every live actor, including a child and a persistent actor's id, and the history, at once. Then every event the system publishes arrives in `seq` order, with message events and refs encoded. A connection made after a crash sees the `failed` (its error encoded) and the `restarted` with its backoff. `history` keeps at most its limit, 500 by default, and only what happened after the source attached. A throwing connection is logged and skipped. `close` turns message events off unless another subscriber wants them, stops every connection's frames, and makes `connect` throw and `request` answer `ClosedError`.
- `test/backstage/requests.test.ts`:
  - `state` covers a plain actor and a persistent one (`{ seq, state }`).
  - `timeline` gives stored events with their version and tags. It finds `lastSeq` past a page of 256, gives an empty page one past the end and an error after that, and gives `lastSeq` 0 for an empty stream.
  - `stateAt` covers every `n`. Each error name appears for its cases, and a journal failure is a response.
  - The box-office example, run with a source attached and every actor queried as the story goes, produces frames and responses that all survive `JSON.parse(JSON.stringify(...))` under `toStrictEqual`.
- `test/backstage/encode.test.ts`: one test per row of the table. Two seeded property tests (300 seeds each, on the testkit's `seededRandom`, so they need no dependency and always run the same) check two things. First, `encode` never throws on arbitrary values (cycles, proxies, throwing getters, `$` and `__proto__` keys, deep and wide shapes, long strings), and always gives a JSON value that survives a round trip. Second, it gives back any JSON value within the limits unchanged.
- `test/package.test.ts`: `/backstage` exports exactly its names, loads only `dist/` and no Node built-in, and no other entry point loads it.
- The tests fail when the escaping, the cycle check, the history ring's limit or `close`'s unsubscribe is broken (T3's commit message).

## Consequences

- The UI (T5), the server (T6) and milestone 4 all speak one format, and the server is a thin transport: frames out as SSE, requests in as `POST`.
- Backstage can't be used to change a system, which also means it can't be used to debug by poking. Anyone who wants that writes it into their own app, as the demo does.
- The UI has to treat `$` keys as escaped and show markers, and it never gets `Map` contents or class instances' fields. Plain-value state ([0001](0001-state-and-reducer-actors.md)) makes this rare.
- While a source is attached, every message is encoded: a cost on top of message events' own (0020). T5's UI and the demo will show whether it matters at the demo's scale. The benchmark doesn't cover it yet.
- `timeline` finds `lastSeq` by reading on to the end of the stream, since the `Journal` interface has no "last sequence number" call. That's fine at the demo's scale. A long stream would want such a call, which would be a change to every backend.
