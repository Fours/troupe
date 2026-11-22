# Design decisions

Each file here records one design choice: the choice itself, the alternatives, and the evidence for it. Write them for a reader, not just as notes to yourself. In milestone 3, they become the public write-up.

## How to add one

1. Copy `template.md` to `NNNN-short-title.md`, using the next free number.
2. Set the status:
   - **Proposed** means it's planned but not proven yet.
   - **Accepted** means it's backed by evidence or built.
   - **Superseded by NNNN** means a later record replaced it. Don't delete old records, and don't rewrite their history.
3. Add a row to the index below.
4. Put raw benchmark output in `data/`, named after the record, and link it from the Evidence section. Every set of numbers states the machine, the runtime and its version, and the exact command, so it can be rerun.

When you change a decision, update its record in the same commit as the code.

## Index

| # | Decision | Status | Milestone |
| --- | --- | --- | --- |
| [0001](0001-state-and-reducer-actors.md) | Actors are a state plus a reducer | Accepted | 1 |
| [0002](0002-async-receive-blocks-the-mailbox.md) | An async `receive` holds the mailbox until it settles | Accepted | 1 |
| [0003](0003-injected-scheduler-and-random.md) | All time, scheduling and chance go through an injected scheduler and random | Accepted | 1 |
| [0004](0004-runtime-agnostic-core.md) | The core is runtime-agnostic, and the build has no Node types | Accepted | 1 |
| [0005](0005-one-package-with-subpaths.md) | One npm package with subpath exports | Accepted | 1 |
| [0006](0006-supervision-chosen-at-spawn.md) | The parent chooses supervision at spawn, and the default is stop | Accepted | 1 |
| [0007](0007-microtask-wake-macrotask-yield.md) | The dispatcher wakes on a microtask and yields on a macrotask | Accepted | 1 |
| [0008](0008-restart-is-a-new-incarnation.md) | A restart is a new incarnation behind the same ref | Accepted | 1 |
| [0009](0009-ask-is-a-temporary-ref.md) | `ask` goes through a temporary ref and never fails fast | Accepted | 1 |
| [0010](0010-piped-asks-stay-on-the-scheduler.md) | `pipeToSelf` of an ask is delivered by the system, not through a promise | Accepted | 1 |
| [0011](0011-persisting-holds-the-mailbox.md) | Persisting and recovery hold the mailbox, so the mailbox is the stash | Accepted | 2 |
| [0012](0012-commands-return-effects.md) | Commands return effects, and state changes only through events | Accepted | 2 |
| [0013](0013-sequence-check-is-the-single-writer-backstop.md) | The journal's sequence check is the single-writer backstop, and a failed write is settled by recovery | Accepted | 2 |
| [0014](0014-events-are-json.md) | Events and snapshot states are JSON values, checked before they're written | Accepted | 2 |
| [0015](0015-journal-timestamps-come-from-an-injected-clock.md) | Journal timestamps come from an injected wall clock, and never order anything | Accepted | 2 |
| [0016](0016-postgres-appends-take-a-journal-lock.md) | Postgres appends take a journal-wide lock, so tag offsets commit in order | Accepted | 2 |
| [0017](0017-backends-add-no-dependencies.md) | Backends add no dependencies: `node:sqlite`, and a structurally typed `pg` pool | Accepted | 2 |
| [0018](0018-standard-schema-and-upcasters.md) | Event schemas use Standard Schema, with one upcaster per version step | Accepted | 2 |
