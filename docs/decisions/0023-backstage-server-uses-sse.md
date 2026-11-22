# 0023. The Backstage server uses server-sent events on `node:http`, with no dependency

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

Backstage has to attach to a system running in Node as well as to the demo in the browser (milestone 3, T6). The UI is the same in both places: it's written against a `BackstageClient` with `connect` and `request`, which the in-process source already implements (0021). Node needs a transport for that interface. Frames flow one way, from the system to the page, and quickly: a rush is thousands of message events a second. Requests are rare and go the other way. The package has no runtime dependencies and, after milestone 3, no peer dependencies either. The server also shows every message and every state, so whoever can reach it can read the whole system.

## Decision

- **`serveBackstage(system, { port, host })`**, in its own Node-only entry point, `@kylewillett/troupe/backstage/server`, built on `node:http` alone.
  - `GET /` serves the built UI from `dist/backstage-ui/`, which ships in the package (open question 3).
  - `GET /events` streams frames as server-sent events.
  - `POST /request` answers one request as JSON.
- **Every SSE message is an array of frames.** A new connection gets `retry: 1000`, then its `hello` alone, sent the moment it connects. After that, events wait in a per-connection queue and go out as one message every 50 ms. The batch timer runs on the system's own scheduler (0003), so a testkit system's batches move with virtual time. Frames are JSON values already (0021), so the transport is `JSON.stringify` and nothing else.
- **A reconnect is a fresh start.** `EventSource` reconnects by itself, and every connection gets its own `hello`. The UI's store already starts over on a `hello` (T5), so a server restart, a dropped connection and a demo restart are all handled the same way.
- **A connection that stops reading is dropped.** When more than 1 MB waits unsent on one response, the server destroys it. The browser reconnects once it can and gets a fresh `hello`, so a stalled tab can't make the server's memory grow without limit.
- **Localhost only by default.** `host` defaults to `127.0.0.1` and `port` to 7070. `0` picks a free port, which `url` reports. A wildcard host (`0.0.0.0` or `::`) gets a `url` on loopback, since browsers can't all open a wildcard address.
- **The `Host` header must name the address it serves**, port included, or the request gets a 403. This blocks DNS rebinding, where a page on `evil.example` re-points its own name at `127.0.0.1` to read a local server as if it were same-origin.
  - A loopback server answers any loopback name: `localhost`, `127.x.x.x` and `[::1]`. Refusing `localhost:7070` for a server on `127.0.0.1:7070` would protect nothing, since `localhost` can't be rebound.
  - A server on every address answers any IP address and `localhost`, but never another name, since rebinding needs a name.
  - A server on one other address answers only that address.
- **No CORS headers, ever**, preflights included, so no other origin can read a response. `POST /request` also needs `Content-Type: application/json` (otherwise 415). That's a type a cross-origin form or `fetch` can't send without a preflight, which fails. Bodies are capped at 64 KB (413). Bad JSON gets a 400 with a `TypeError` response, in the same shape the source uses, so the client has one shape to handle.
- **Locked-down static files.** Paths are decoded, resolved against the UI's folder and refused (404) if they land outside it. The page gets a `default-src 'self'` Content-Security-Policy with `frame-ancestors 'none'`. Every response gets `nosniff`, `no-referrer` and `no-store`.
- **`close()`** stops listening, sends what each stream has pending, ends every stream, closes the source (which turns message events off unless something else wants them), and closes idle keep-alive sockets so it doesn't wait on them. If `listen` fails, the promise rejects and the source is closed.
- **Option errors throw at once**, before the promise, as every other option check does.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A WebSocket server written on `node:http` by hand | The handshake, framing, masking and close codes are a few hundred lines to get right, for a two-way channel the stream doesn't need. Requests are rare enough for a plain `POST` |
| `ws` as an optional peer dependency | Breaks "no peer dependencies" (milestone 3's definition of done), and adds a version range for users to manage for a debugging tool |
| One SSE message per frame | A rush makes thousands of small writes a second, and the UI redraws at most once per animation frame anyway (T5). 50 ms batches cut the writes without the UI seeing any lag |
| The batch timer on `setTimeout` | Breaks the rule that time comes only from the injected scheduler (0003), and a testkit system's stream would then run on real time while the system runs on virtual time |
| Long polling | More requests, more code on both ends, and still needs a cursor to resume from. `EventSource` reconnects by itself, and a fresh `hello` is a simpler resume |
| Accept only the exact `host:port` it was given | Opening `localhost:7070` for a server on `127.0.0.1` would fail, with no protection gained |
| No `Host` check, relying on binding to loopback | Loopback binding stops other machines, not other sites in the visitor's own browser. DNS rebinding reaches loopback through the browser |
| The UI on the demo site, connecting to `http://localhost` | Mixed content and private-network rules differ between browsers, it needs CORS, and it would tie the UI's version to the site's rather than the package's (open question 3) |
| An auth token in the URL | Worth adding if Backstage is ever served beyond loopback. On loopback, the `Host` check and the absence of CORS already stop every page but its own |

## Evidence

`test/node/backstage-server.test.ts` runs real HTTP on a free port against a testkit system:

- **The UI.** `/` serves `index.html` with the CSP, and its files by path. Encoded `..` paths, a malformed escape and a NUL byte all get 404s and never the file beside the UI's folder. With no UI built, `/` says to run the build.
- **Batching.** The `hello` arrives at once. Two spawns then leave nothing on the wire and one timer due at `now + 50` on the testkit's scheduler. After `advance(50)`, one message carries both events.
- **Reconnects.** A second connection after a disconnect gets a fresh `hello` listing the actor spawned in between.
- **Slow clients.** A connection that stops reading under a stream of 1,500-character messages is dropped once its server-side buffer passes the limit (64 KB in the test). A new connection then gets a fresh `hello`.
- **Requests.** `POST /request` answers `state`, and passes the source's error responses through. Bad JSON gets a 400, a form or `text/plain` body a 415, and an oversized body a 413. The wrong method on each path gets a 405 with `Allow`.
- **Who may ask.** Every path refuses `Host: evil.example:<port>`, the right name on the wrong port, and a name with no port. `localhost:<port>` is accepted. `hostCheck` has unit tests for loopback, wildcard and specific-address servers, including `127.0.0.1.nip.io`, `user@host` and a path in the header. No response carries an `Access-Control-*` header, an `OPTIONS` preflight and the event stream included.
- **Starting and stopping.** `close()` delivers the pending event, ends two open streams cleanly, closes the source once, cancels the batch timer and stops listening (`ECONNREFUSED`). It doesn't hang on a keep-alive socket. `port: 0` reports the port it got. A taken port rejects with `EADDRINUSE` and closes the source. Bad options throw `TypeError` at once.

Breaking each of these made its test fail: dropping the `Host` check, writing each event at once instead of batching, leaving streams open on close, removing the folder check, removing the buffer limit, and not closing the source when `listen` fails.

`test/package.test.ts` loads `/backstage/server` from `dist/`. It checks the entry point pulls in only `dist/` and Node built-ins, that no other entry point loads `node:http`, and that it declares exactly `serveBackstage`, `BackstageServer` and `BackstageServerOptions`. It checks that `npm pack` includes `dist/backstage-ui/` with its script and stylesheet, and that the built server serves that page and its script.

`e2e/server.spec.ts` runs `examples/backstage`: opening night on real time and SQLite, served on port 7071. In Chromium the page reads "Live", shows the tree with customers arriving, shows `hamlet`'s state from a request, and shows the failure and restart from the example's bad request. The page makes no request but to the server, and has no console errors, so the CSP doesn't block the UI. With the HTTP client's frames ignored, the test fails.

## Consequences

- One UI runs everywhere: the demo in-process, and any Node system over HTTP. Milestone 4 can carry the same frames from another node, since nothing in the protocol assumes the transport.
- `EventSource` can't send headers, so adding auth later means a token in the URL or a cookie. That's fine for a localhost tool and worth revisiting before Backstage is offered beyond one machine.
- A tab that falls behind loses its place rather than slowing the server, and catches up from a fresh `hello`. Message events in between are gone, as they would be in-process: the source keeps only lifecycle history.
- The package now carries about 250 KB (77 KB gzipped) of built UI. It's static files, not a dependency, and only the server entry point reads them.
- The UI's build is part of `npm run build`, so `dist/` is complete only after Vite has run. The package test checks the tarball for it.
