# 0041. A failure can raise its backoff delay, through the strategy's `minDelayFor`, past `maxMs`

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

`restartWithBackoff` works out its delay from its options and the restart count alone ([0006](0006-supervision-chosen-at-spawn.md)). Sometimes the failure itself says when to try again. Steadfast, a durable agent runtime on Troupe, runs each model call in a child actor under `restartWithBackoff({ minMs: 1_000, maxMs: 60_000, randomFactor: 0.2 })`. When a provider answers 429 with a `retry-after` of 5 s, the child throws an `Error` whose `cause` is a `ModelError` with `retryAfterMs: 5_000`, and supervision restarts it after 1 s, into another 429. Steadfast's rules say a missing Troupe feature is added to Troupe, not worked around, so this is its milestone 1 open question 8.

The answer has to fit what supervision already is. A strategy is a frozen value, checked where it's built and again at `spawn`. `decide` is pure, apart from drawing jitter from the system's `random`, so a test can pin its delays from a seed. Time comes only from the scheduler ([0003](0003-injected-scheduler-and-random.md)).

## Decision

`supervise.restartWithBackoff` takes one more option, `minDelayFor: (failure: unknown) => number | undefined`.

- **It's called with each failure, as it was thrown**, and returns the fewest ms the restart must wait, or `undefined` for no minimum. It reads the failure however the application wraps it. Steadfast's is `(f) => f instanceof Error && f.cause instanceof ModelError ? f.cause.retryAfterMs : undefined`. Troupe doesn't walk `cause` chains or look for a field by name.
- **Restart number `n` waits `max(min(maxMs, minMs * 2^n), minimum) * (1 + random() * randomFactor)` ms, rounded.** With no minimum, or a minimum of 0, that's the old formula exactly, with the same draws from `random`.
- **The minimum isn't capped by `maxMs`.** `maxMs` bounds Troupe's own guess at how long a failure takes to clear. A server that says how long is better informed, and restarting before it said to only earns another 429. A `minDelayFor` that wants a ceiling applies one itself.
- **The minimum doesn't count as extra backoff steps.** The restart is backoff restart `n + 1`, as it would have been, and the next failure's step is `n + 1` whatever the minimum was. `n` counts failures since the last reset, and a retry-after says something about the server now, not about how often this actor fails.
- **Jitter applies on top of the minimum.** The jitter factor is at least 1, so the restart still never comes sooner than the minimum, and the rounding can't take it below an integer minimum. A rate limit on a shared key sends the same `retry-after` to every actor that hit it, and without jitter they would all restart in the same millisecond.
- **The minimum is a non-negative integer of ms**, as every duration in Troupe is. A return that isn't one, or `undefined`, and a `minDelayFor` that throws, are logged at `error` with the actor's path and its failure, and the restart uses the ordinary backoff. A broken reader can't break supervision, as a broken listener can't break an actor.
- **`decide` stays pure.** The cell calls `minDelayFor` through `minimumDelay(strategy, failure)` before deciding, logs any problem, and passes the result to `decide` as `FailureFacts.minDelayMs`. `decide` still runs no user code.
- **The option is checked where it's passed in:** `restartWithBackoff` throws `TypeError` for a `minDelayFor` that isn't a function, and so does `spawn` for a hand-built backoff strategy with one. A strategy built without it has no `minDelayFor` key, so it's the same value it always was.
- **Only `restartWithBackoff` has it.** `restart` is immediate by definition. An actor that may be told to wait uses backoff.
- The `restarted` event's `delayMs` is the delay waited, minimum included. Nothing else about the event changes.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A Troupe error class, such as `RestartAfterError(ms)`, that supervision looks for | The actor's failure would have to be Troupe's type, or wrap one, and Steadfast's is its own `Error` with a `ModelError` cause. Supervision would have to guess how deep to look in a `cause` chain. And the actor would decide its own restart delay, when the parent chooses supervision ([0006](0006-supervision-chosen-at-spawn.md)). |
| A field by convention, such as `retryAfterMs` anywhere on the failure or its causes | The same guessing about depth and wrapping, and a name Troupe would have to promise forever. A function reads any shape. |
| `ctx.restartNoSoonerThan(ms)`, called before throwing | It adds state to the cell that only the next failure reads, and it's easy to set and then fail for some other reason. The failure carrying its own delay keeps the two together. |
| Capping the minimum at `maxMs` | It restarts before the server said to, and gets another 429. A ceiling is one `Math.min` in `minDelayFor` for an application that wants one. |
| Counting a minimum as the steps it covers, so `n` jumps to the step whose delay passes it | The next failure would wait as if the actor had failed many times, when it failed once with a long `retry-after`. `n` would stop meaning a count of failures. |
| The minimum without jitter: `max(jittered backoff, minimum)` | Every actor told the same `retry-after` restarts at the same millisecond, the herd jitter is there to break up. |
| Calling `minDelayFor` inside `decide` | `decide` would run user code, and its tests would need to cover a reader that throws. Calling it first keeps `decide` pure and the problem in the cell, which has the logger. |
| Rounding a fractional minimum up instead of refusing it | Every other duration in Troupe is integer ms, checked. A reader that works in seconds returns `Math.ceil(seconds * 1000)`. |
| The option on `restart` too | `restart` restarts at once. Waiting is what backoff is for. |

## Evidence

`test/supervision.test.ts`, "backoff with a minimum delay", on the testkit's virtual time, with Steadfast's shape of failure: an `Error` whose `cause` is a `ModelError` with `retryAfterMs`.

- Under `{ minMs: 1_000, maxMs: 60_000, randomFactor: 0.2 }`, a `retryAfterMs` of 5,000 holds the restart, and the messages behind it, until the 5,000 ms minimum with its jitter has passed: nothing at 1 ms short of it, the new incarnation's state exactly at it, and `restarted` exactly that long after `failed`.
- A minimum below the backoff, of 500 and then 1,999, waits the backoff, the same delays as plain backoff from the same seed.
- A minimum of 600,000 ms, ten times `maxMs`, is waited in full. The next failure, with no `retry-after`, is attempt 2 and waits step 1, as if the first restart had been an ordinary one.
- With `randomFactor: 0`, minimums of 250, 0, 150 and 5,000 against steps of 100, 200, 400 and 800 wait 250, 200, 400 and 5,000 ms.
- With a `minDelayFor` that never applies, or always returns 0, attempts, delays and restart times are identical to plain backoff's, including the pinned delays of the plain backoff test (101, 206, 595, 1,080, 1,261 and 1,203 ms from seed 7).
- `minDelayFor` gets the failure as it was thrown: the same `Error` object from `receive`, `undefined` from a rejection, `42`, and the error from an `initial` that failed.
- A `minDelayFor` that throws, or returns -1, 1.5, `NaN`, `Infinity` or `'5000'`, logs at `error` with the path and the failure (and what it threw, for a throw), and the restart waits the ordinary backoff.

`test/supervise.test.ts` and `test/options.test.ts`: `minDelayFor` that's a number or `null` throws `TypeError` from `restartWithBackoff`, naming the option, and a hand-built backoff strategy with a string `minDelayFor` throws from `spawn`. A strategy with it is frozen and keeps the same function, and one without it has no such key. `test/types.test.ts`: the option's type is `(failure: unknown) => number | undefined`, and a reader typed for `Error` only, or one returning a string, is a type error.

Ignoring the minimum fails three of these tests, and capping it at `maxMs` fails two. Counting a minimum as extra steps fails two, and taking the max after jitter instead of before fails two. Not catching a throwing reader fails one, accepting fractions fails one, and not checking the option fails four.

## Consequences

- Steadfast passes `minDelayFor` that reads its `ModelError`'s `retryAfterMs`, and a 429 with `retry-after: 5` restarts the step after 5 to 6 s, instead of after 1 s into another 429.
- A `retry-after` can now keep an actor down for as long as the server says, past `maxMs`. That's the point, but an application facing an untrusted server should clamp it in `minDelayFor`.
- The strategy now holds a function. It always could have, since strategies are values in memory chosen by the parent at spawn and never sent anywhere ([0006](0006-supervision-chosen-at-spawn.md)). But a strategy with a `minDelayFor` isn't JSON, which matters if strategies ever travel or show in Backstage. Neither does today.
- `minDelayFor` runs on every failure, synchronously, inside the actor's failure handling, so it should be cheap and shouldn't block.
