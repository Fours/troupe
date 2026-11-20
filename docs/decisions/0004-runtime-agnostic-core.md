# 0004. The core is runtime-agnostic, and the build has no Node types

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

Milestone 3's demo site and inspector should run the real framework in a browser, with no backend, the way the rate-limiter demo runs its real Lua. Deno, Bun and edge runtimes are a bonus.

## Decision

`src/` uses only the ECMAScript standard library and globals that every runtime has: `setTimeout`, `clearTimeout`, `queueMicrotask`, `performance.now` and `console`, declared in `src/globals.d.ts`. `tsconfig.build.json` builds with `"types": []`, so a Node API in `src/` fails to compile, and lint bans `node:*` imports and Node globals. Node-only features, such as Postgres and SQLite journals, worker threads and TCP, live in their own entry points from milestone 2 on, with their own build settings.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Node only, using `AsyncLocalStorage`, `EventEmitter` and `setImmediate` freely | Simpler, but milestone 3's demo would need a server. |
| Runtime-agnostic, enforced by review only | Slips would go unnoticed until the browser build broke. |

## Evidence

The user chose it on 2026-11-20. The T0 scaffold builds with the empty `types` list. Milestone 3's demo will prove it in a real browser.

## Consequences

- Timers can't be `unref()`'d, so a running system keeps a Node process alive until `terminate()`. The README says so.
- No `AsyncLocalStorage`, so context such as tracing is passed explicitly, through `ctx`.
- Each Node-only entry point needs its own tsconfig, or project reference, with Node types.
