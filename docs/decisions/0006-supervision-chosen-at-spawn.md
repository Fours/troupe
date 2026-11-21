# 0006. The parent chooses supervision at spawn, and the default is stop

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

When an actor fails, something must decide whether it stops, resumes or restarts. Akka classic puts one strategy on the parent, which covers all its children. Akka Typed wraps each child's behavior when it's spawned, and defaults to stop.

## Decision

Each child's strategy is passed when it's spawned: `ctx.spawn(def, name, { supervision })`. The default is `stop`. There's no escalation in milestone 1. A parent that wants to react to a failed child watches it and reads `failure` on `terminated`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| One strategy per parent, for all its children (Akka classic) | Children with different failure modes would need different parents. |
| The strategy on the definition itself | The same definition might need different handling in different places, and the parent knows the context. |
| A default of restart (Akka classic) | Hides bugs: an actor that keeps failing silently loses its state on every message. Stop makes failures visible. |

## Evidence

T4's supervision tests. Milestone 2 should confirm that persistent entities, which restart by replaying their journal, fit this shape.

**T4 (2026-11-20):** `src/supervision.ts` builds the strategies, and `spawn` takes one in `supervision`. `test/supervision.test.ts` covers:
- The default is stop: a watcher sees `failure`, and the `failed` event records `directive: 'stop'`.
- Each strategy applies to each failure source: a throw or rejection in `receive`, a throw in `initial` or in a `terminated` handler, and values that aren't `Error`s, `undefined` included.
- Resume, restart, restart limits over a rolling window, and backoff under a seeded random, with the delays pinned.
- Breaking the restart limit (`>` to `>=`), the window edge, the backoff exponent, or the reset edge fails at least one test each.

Supervision decides from the failure times when a failure happens, so neither the limit window nor the backoff reset needs a timer of its own. What carries over a restart is [0008](0008-restart-is-a-new-incarnation.md).

## Consequences

- Restarting is opt-in, so users must think about it, and the README must show it early.
- Escalation and death pacts are open question 1. Adding them later doesn't break this API.
