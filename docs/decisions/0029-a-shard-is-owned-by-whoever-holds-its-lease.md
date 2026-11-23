# 0029. A shard is owned by whoever holds its lease, and the store and the holder each time the lease on their own clock

- **Status:** Accepted
- **Date:** 2026-11-23
- **Milestone:** 4

## Context

Cluster sharding promises at most one live instance of each entity. Membership can't keep that promise, because it's gossiped and automatic downing can be wrong ([0028](0028-membership-is-gossiped-with-automatic-downing.md)): two nodes can disagree about who's alive, and a node that's been downed may still be running. Something outside the nodes has to say who owns each shard. A lease in a shared store does that, but a lease is a promise about time, and nodes' clocks can't be compared. Milestone 5 will skew and pause them on purpose. The design has to stay safe with no clock compared to any other, and run on the system's scheduler so a cluster in memory repeats from its seed ([0003](0003-injected-scheduler-and-random.md)).

## Decision

**A shard belongs to the node that holds its lease in a `ShardStore`, and to nothing else.** Membership chooses where a shard should go. The lease decides where it is.

- **The store.** `ShardStore` has `acquire(lease, holder, ttlMs)`, `renewAll(holder, ttlMs)`, `release(lease, holder, token)` and `holders(prefix)`, plus `remember`, `forget` and `remembered` for remembered entities. A lease is `<type>/<shard>`, and a holder is `<address>#<uid>`, so a restarted node is a new holder and waits for its old incarnation's leases to expire. Bad arguments reject with `TypeError`, the same on every backend, from one set of checks.
- **Tokens.** Every change of hands raises the lease's token by one, including a holder taking back a lease it had released or let expire, since that's a new ownership in the history. Acquiring a lease you still hold keeps its token and extends it. Releasing a lease keeps its row, expired, so the count never starts again at 1. Events carry the token (from T6), so a history can tell one ownership from the next.
- **The store judges expiry on its own clock.** A lease is live while the store's clock reads less than its expiry. Postgres reads `clock_timestamp()`, never `now()`, which is fixed for a whole transaction. `inMemoryShardStore({ clock })` reads the clock it's given, `Date.now` by default as in [0015](0015-journal-timestamps-come-from-an-injected-clock.md), and a cluster on a `ManualScheduler` gives it the scheduler's `now`. No node sends a time to the store.
- **The holder judges it on its own.** The node notes its monotonic `scheduler.now()` before it sends an acquire or a renewal. When the store says yes, the node treats the lease as its own until that time plus `ttlMs` minus `marginMs`. The store's `ttlMs` started after the node noted the time, so as long as the two clocks run at about the same rate, the node's deadline comes at least `marginMs` before the store's expiry, whatever either clock reads. A deadline only moves later. If renewals fail or hang, the node keeps trying every `renewMs`, and at its deadline it lets the lease go, whether or not the store has answered. A renewal that answers after that can't win the lease back: only a new acquire can. A renewal that no longer lists a lease the node held when it sent it means the lease is gone, and the node lets go at once. Losing a lease early is always safe.
- **`renewMs` must be less than `ttlMs - marginMs`,** checked where the options are passed in, so a renewal can land before each deadline. The defaults come in T6 with `sharding.init`: `ttlMs` 10,000, `renewMs` 3,000 and `marginMs` 2,000, which T8 will measure.
- **Postgres decides races in one statement.** `acquire` is `INSERT ... ON CONFLICT (name) DO UPDATE ... WHERE holder = $2 OR expires_at <= clock_timestamp()`. When two transactions race for one row, Postgres makes the second wait for the first's lock, then checks the `WHERE` again against what the first committed, so only one can take a free or expired lease. A loser reads the winner back, and if the lease has come free in between, tries again, up to three times. `acquire` and `renewAll` run in read-committed transactions, whatever the database's default, so a race waits instead of failing to serialize, as the journal's appends do ([0016](0016-postgres-appends-take-a-journal-lock.md)).
- **Backends.** `inMemoryShardStore` is in `/cluster`, and `postgresShardStore({ pool, schema })` is in its own entry point, `/cluster/postgres`, for any runtime. It runs on the same structurally typed pool as the journal and imports no driver ([0017](0017-backends-add-no-dependencies.md)). Its tables, `shard_leases` and `remembered_entities`, live in the journal's schema by default. Its SQL ships as `dist/cluster/postgres/schema.sql`. Its `setup()` takes the schema's advisory lock, as the journal's does, so the two can set up one schema at once. Both backends pass one contract suite.
- **The journal stays the backstop.** A node whose clock pauses past its deadline (a long GC, a suspended VM) can still write once after another node has taken over. The new owner recovered from the journal and appends at its own sequence number, so one of the two appends fails with `JournalConflictError` ([0013](0013-sequence-check-is-the-single-writer-backstop.md)). The journal doesn't check the lease token (milestone 4, open question 2).
- **The lease keeper is internal.** The holder's side lives in `src/cluster/leases.ts`, and T6's shards use it. It's not exported.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Ownership by membership, as Akka's shard coordinator decides from the member list | A partitioned or wrongly downed node would keep its shards while another node started them. That's what Akka needs a split-brain resolver for, and why auto-downing is unsafe there |
| A coordinator node that hands shards out | A single point of failure that needs its own election and handover. Postgres is already what the journal stands on |
| The node sends its own timestamp, and the store compares it | Compares two clocks. Milestone 5 skews them, and a node whose clock runs behind would keep a lease the store should have expired |
| The holder times the lease from when the store answers | Late by however long the answer took. A slow answer would leave the holder believing in a lease that had already expired in the store. Noting the time before sending is the only reading that can't come after the store's |
| Deleting a lease's row on release | Tokens would start at 1 again, and a history couldn't tell the new owner from an old one |
| `now()` in Postgres | Fixed when the transaction starts, so a statement that waited for a lock would judge expiry at the wrong time |
| `SELECT ... FOR UPDATE`, then decide in TypeScript | Two round trips under a row lock for what one statement does, and a free lease has no row to lock, so two first acquires would race on the insert |
| Wrap `renewAll` in a transaction only so a test can hold its `COMMIT` | Its transaction is for read committed, not for testing. The tests hold the renewal before it's sent as well as at its `COMMIT` |

## Evidence

**T5 (2026-11-23), Node 26.12.1, Postgres 18.7 from `docker-compose.test.yml`:**

- **The contract.** `test/cluster/shard-store-contract.ts` runs on both stores: in `npm test` for the in-memory store, and in `npm run test:integration` for Postgres, where time passes on the database's clock in `pg_sleep`. It covers acquiring a free lease, failing on a held one with its holder, re-acquiring one's own with the same token, taking an expired one with a higher token, for another holder or the same one, renewing all of a holder's live leases and never an expired one, releasing only with the right holder and token, listing holders by prefix, remembering and forgetting, rejecting bad arguments, and astral characters. Making the in-memory store ignore expiry fails 7 tests. Keeping the token from going up fails 4.
- **Races.** Two pools race for one lease 200 times, free and then released. Exactly one wins each time, with token 1 then 2, and the loser is told the winner. Dropping the `WHERE` from the upsert fails it, and the contract's "fails on a held lease".
- **Postgres's clock decides.** A renewal held before it reaches Postgres, while 350 ms pass on Postgres's clock with a 300 ms TTL, finds the lease already taken by another holder with token 2, and renews nothing. A renewal whose `UPDATE` runs but whose `COMMIT` is held past the TTL makes the other holder wait for the row. Once it commits, the other holder takes the lease, since the renewed expiry is already past on Postgres's clock. Dropping the expiry check from the upsert fails both, and three contract tests.
- **The holder lets go first.** On a `ManualScheduler`, with renewals that fail and with renewals that hang, and with the store's clock even with the node's or an hour ahead, the node holds the lease until exactly 11,000 ms (its last good renewal, noted at 3,000, plus 10,000 minus 2,000), lets go at 11,000, and another holder still can't acquire it until 13,000 on the store's clock. A renewal whose answer takes 2,000 ms still gives a deadline of 11,000, not 13,000. Noting the time after the reply fails that test, and dropping the margin fails 8. A renewal that answers after the deadline doesn't make the lease the node's again.
- **`setup()`.** Two shard stores and two journals set up one schema at once, on two pools, five times, then again in turn on a schema with data in it. Removing the shard store's lock fails it.
- Package tests show that `/cluster/postgres` loads only files from `dist/`, with no `pg` and no Node built-in, that neither `/cluster` nor `/persistence/postgres` loads it, and that `dist/cluster/postgres/schema.sql` is the default schema's SQL.

## Consequences

- A partitioned node, a downed node that's still running, or two nodes with different member lists can't start a second copy of a shard. Each of them either holds the lease or doesn't.
- Postgres is what the cluster stands on. If it's unreachable, no lease is renewed, and every shard on every node stops at its deadline. Entities go unavailable rather than double. The journal already needed Postgres, so this adds no new thing that can fail.
- Safety depends on the store's clock and the holder's running at about the same rate, not on their readings. A store whose wall clock jumps forward can expire a lease before its holder's deadline, so for a moment two nodes may both run the shard. The journal's sequence check still keeps every stream to one writer. Milestone 5's skewed and jumping clocks will show how often that happens.
- A failover takes up to `ttlMs` after the old holder's last renewal, plus the new owner's next attempt. T8 measures it and tunes the defaults.
- Every node renews all its leases in one statement every `renewMs`, whatever the number of shards it holds.
