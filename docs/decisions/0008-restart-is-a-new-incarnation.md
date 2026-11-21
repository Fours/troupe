# 0008. A restart is a new incarnation behind the same ref

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

A restart throws away an actor's state and runs `initial` again. Something has to say what else goes with the state. Senders hold the actor's ref and expect it to keep working. But anything the old incarnation set up, such as children, watches or timers, was set up for state that no longer exists.

## Decision

A restart ends one incarnation and starts another behind the same ref.

- **Carried over:** the ref, the mailbox (including messages that arrive during the restart), and the actors watching this one. Senders and watchers can't see a restart, apart from the `failed` and `restarted` events.
- **Not carried over:** the state, the children, the timers, the actor's own watches, and `ctx`. The old `ctx` goes stale: its `spawn` throws `ActorStoppedError`, and its `watch` does nothing. `initial` runs with a fresh `ctx`, and sets up what it needs again.

The steps are:
1. `preRestart` runs with the old state.
2. The actor's own watches are dropped.
3. Every child is stopped, and the restart waits for them to terminate.
4. `initial` runs once that's done and any backoff delay has passed. The delay runs from the failure, alongside steps 1 to 3.

While a restart is under way, messages queue up and none is processed. A stop during the restart cancels it, and `postStop` runs with the last state.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the actor's own watches | The new incarnation would get `terminated` for actors it never asked about, including the children the restart itself stopped. |
| Keep the children (Akka classic's `preRestart` can opt out) | Children set up for the old state would outlive it, and the new `initial` couldn't spawn them again under their names. |
| A fresh ref per incarnation | Every sender would need to learn the new ref. Supervision exists so that they don't. |
| Start the backoff delay once the children have stopped | Slow `postStop`s would add to the delay, so `delayMs` wouldn't say how long the actor was down. |

## Evidence

**T4 (2026-11-20):** `test/supervision.test.ts`, under "restart":
- `preRestart` sees the old state. Children run `postStop` and terminate before `restarted` is published, and are then spawned again under the same names.
- Queued messages reach the new incarnation. `ref` and `ctx.self` are the same object in both incarnations, and a watcher hears nothing until the final stop.
- After a restart, the old `ctx`'s `spawn` throws and its `watch` does nothing. A watch made before the restart doesn't deliver `terminated` afterwards.
- Keeping the actor's own watches, letting the old `ctx` stay current, processing messages during a restart, or not waiting for the children each fails a test.

T5 adds timers and tests that a restart cancels them.

## Consequences

- `initial` is the one place an actor sets itself up, for its first start and every restart. Milestone 2's persistent actors replay their journal there.
- An actor that wants to keep watching something across restarts watches it again in `initial`. That's cheap, because watching twice is the same as watching once, and watching an actor that has already terminated signals at once.
- If watching a stopped actor in `initial` makes the `terminated` handler fail, the actor restarts into the same failure. `maxRestarts` or backoff limits that loop, as they do for an `initial` that throws.
