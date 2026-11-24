# 0036. Journal and shard store calls time out on the scheduler, and a timeout is an unknown outcome, settled by recovery

- **Status:** Accepted
- **Date:** 2026-11-24
- **Milestone:** 5

## Context

A store call that never answers leaves its caller stuck. A persistent actor awaiting an append holds its mailbox for good ([0011](0011-persisting-holds-the-mailbox.md)), a projection's poll never comes back, and a handoff that waits for that actor to stop never finishes ([0030](0030-shards-are-placed-by-rendezvous-hashing.md)), so neither does the node's leave. A shard store call that hangs does the same to a region waiting on an acquire or a release. Milestone 2's open question 2 deferred the fix to here, because a timeout on the scheduler can't fire under the testkit while the actor is busy: `settle` waits on real turns and gives up. Rehearsal's run loop ([0033](0033-one-simulation-clock-and-a-clock-per-node.md)) moves time on while an actor awaits, and its simulated database hangs calls on purpose, so this is where the problem first bites and where it can be tested.

A timeout can't say what happened. An append may have committed and lost its reply, or never have arrived. [0013](0013-sequence-check-is-the-single-writer-backstop.md) already settles a failed append by recovery, and a timeout is one more way for an append to fail.

## Decision

- **Every journal, snapshot and offset call a persistent actor or projection makes times out** after `timeoutMs`, a positive integer, default 10,000, set per definition. The timer runs on the actor's own scheduler ([0003](0003-injected-scheduler-and-random.md)), through a `setTimer` the cell's internals give it, since keyed timers deliver messages to a mailbox the actor is holding.
- **A timeout fails the actor with `PersistenceTimeoutError`,** with the `id` (persistence id or projection name), the `operation` and the `timeoutMs`, and its supervision decides what happens next. Like any failed append, it applies nothing, publishes no `persisted` and runs no step, so **no reply is ever sent for a write whose outcome is unknown.** A restart recovers from the journal and finds out. A recovery read that times out fails the start, as a failed read does.
- **A snapshot is only a shortcut,** so a load that times out is skipped and recovery replays every event, and a save that times out is logged, as failed ones already were. The save stops counting as the actor's busy work, so a hung save no longer holds `settle` or a stop.
- **A projection** times out its tag read and its offset load and save the same way. It fails, and its supervision's backoff decides when it reads again. Delivery stays at least once: a batch whose offset save timed out runs again.
- **Every shard store call the cluster makes times out** after `leases.storeTimeoutMs`, a positive integer, default `renewMs`. One wrapper around the store covers all seven calls, for the lease keeper, the regions and the shards. Each caller already treats a failed call as one to log and retry, so a timeout takes that path. Its error is a plain `Error` naming the call, not public API, since users only see it in logs.
- **A renewal that times out counts as failed.** The holder's deadline already drops its leases whether the store answers or not ([0029](0029-a-shard-is-owned-by-whoever-holds-its-lease.md)), so this only frees the caller. **An acquire that times out may have been granted.** The holder doesn't know it has the lease, but `renewAll` still extends every lease the store has as the holder's, so the lease doesn't simply run out. The region retries the acquire after its backoff, the store finds the lease already the holder's and keeps its token, and the shard starts then. **A release that times out** leaves the lease to expire in the store, and the handoff carries on.
- **A late answer is dropped.** The promise has already rejected, so an answer that comes after the timeout changes nothing. A timed-out append that commits after the restarted actor has recovered makes that actor's next append fail with `JournalConflictError`, and the restart after it recovers both (0013).
- With timeouts, **a handoff is bounded by the entity's `timeoutMs`**, which answers milestone 4 T7's note on handoffs that never finish.

## Alternatives considered

| Option | Why not |
| --- | --- |
| One timeout per `Persistence` backend | A backend has no scheduler, and the timeout has to run on the actor's (0003). Under Rehearsal, the actor's scheduler is its node's own clock. |
| Retry a timed-out append before failing | It may already have committed, and a blind retry at the same sequence number fails anyway. Recovery is the one place that reads what the journal holds. |
| Reply with an error for a timed-out write | The sender would act on an outcome nobody knows. An ask that times out says the same thing, more honestly. |
| A public `ShardStoreTimeoutError` | No caller outside the cluster sees a shard store call. It would be API to keep stable from 1.0 for a log line. |
| Release a lease that `renewAll` returns but the holder doesn't track, after a timed-out acquire | Releasing needs the token, which only the acquire's lost answer had. The retried acquire gets it back. T7's hunt will show whether an untracked lease that stays renewed is a problem in practice. |
| Leave it to the hunt, with no timeouts | A hung call stalls Rehearsal's run, so it couldn't measure anything else. |

## Evidence

**T4 (2026-11-24):** the testkit's `settle` can't wait on a busy actor, so these tests drive the kit's `ManualScheduler`, or the test cluster's, with Rehearsal's run loop.

`test/persistence/timeout.test.ts`:
- "fails a hung append with PersistenceTimeoutError after timeoutMs, and sends no reply": with the append held, nothing fails at 999 ms, and at 1,000 ms the actor fails with `PersistenceTimeoutError` for `append`. Once the held append lands, its answer is dropped and no reply comes. "defaults to 10 s" checks the default.
- "after a timed-out append that committed, recovers with its events": on the simulated database with lost replies, the append is applied, the actor times out, and the restart recovers it. The next deposit replies 16, and the journal holds 1 to 3.
- "after a timed-out append that never committed, recovers without it": a held append that never lands times out, and the next deposit replies 11.
- A hung recovery read fails the start. A hung snapshot load falls back to replaying every event, and a hung save is logged and leaves nothing busy.
- A projection whose `readByTag` hangs fails at 1,000 ms and reads again 500 ms later, after its backoff, and handles both events. One whose offset save hangs runs the batch again. One whose offset load hangs fails its start. Invalid `timeoutMs` throws from both definitions.

`test/cluster/timeout.test.ts`:
- The timed store fails each of its seven calls at its timeout, not a millisecond before, passes answers and failures through, cancels its timer, and drops a late answer.
- A hung acquire gives up at 500 ms, FAST's `renewMs` and so the default, and the region tries again after its backoff and starts the shard.
- With renewals hung, the holder gives the shard up as `leaseLost` within `ttlMs - marginMs` of the last renewal that answered. Once the store answers again, the desired owner takes the shard back.
- A node whose releases hang still finishes leaving, and the other node takes its shards once the leases expire.
- "a handoff whose entity's append hangs finishes within the entity's timeoutMs": with the append held for good and `timeoutMs` 2,000, the shard is released for handoff within 1,000 ms of the timeout. The new owner recovers a balance of 10 without the unknown write, and the ask for that write times out with no reply. Without the timeout, milestone 4's "waits for an entity's persist in flight" test shows the shard staying put for as long as the append is held.

Breaking each piece fails its tests: awaiting the append without the timeout fails the five append tests, the handoff one included. Removing the store wrapper fails the acquire and release tests. Removing the projection's timeouts fails its three. A hung renewal's timeout is the one with no test that fails without it, since the deadline already stops the shard, as the decision says.

## Consequences

- No journal or store call can hold an actor, a projection or a handoff for longer than its timeout, so a Rehearsal run that stalls has found an actor waiting on something outside the simulation, not a hung database.
- A slow database now fails entities rather than slowing them. A journal that takes longer than 10 s to append, which no healthy one does, needs a longer `timeoutMs`. This is the breaking change in the changelog.
- 10 s matches the default lease TTL, so a hung append never outlives the shard it's in by long. `storeTimeoutMs` defaults to `renewMs`, so a renewal never waits past the next one.
- A timed-out append is an unknown outcome, so a sender whose ask times out can't tell whether its write was made. Making a command safe to retry, for example with a request id the state remembers, is up to the entity.
- Every journal call now sets and cancels one timer on the scheduler. That's a heap insertion per append, which the benchmark should show if it matters.
