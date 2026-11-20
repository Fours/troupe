# 0001. Actors are a state plus a reducer

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

The actor definition is the API that users touch most, and it's hard to change later. Milestone 2 snapshots state, and milestone 3 shows state in an inspector and replays it through time. Both need state that can be read, copied and compared.

## Decision

An actor is `actor({ initial, receive, onSignal? })`. `receive(state, msg, ctx)` returns the next state, either directly or as a promise. State is a plain value, and the framework holds it between messages.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Akka Typed behaviors (return the next behavior) | Best for actors that switch protocols, but state hides in closures, where snapshots and the inspector can't reach it. Less familiar to most TypeScript developers. |
| Classes with fields and a `receive` method (Akka classic, Orleans) | Familiar, but mutable instance state is hard to snapshot, compare or replay, and `this` binding is a common source of bugs. |

## Evidence

The user chose it on 2026-11-20, when milestone 1 was specced. Milestone 2's `onEvent` fold and milestone 3's time-travel replay should both use state from this shape without adapters.

## Consequences

- Persistent actors in milestone 2 follow the same shape, with `onCommand` and `onEvent`, so there's one mental model.
- An actor that changes protocol by state, such as a state machine, uses a discriminated-union state instead of swapping behaviors.
- Users must keep functions and class instances out of state. The README says so, and milestone 4's serialization check enforces it.
