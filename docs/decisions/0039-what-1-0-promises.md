# 0039. What 1.0 promises: the export lists, open unions, and a replay line within its version

- **Status:** Proposed
- **Date:** 2026-11-28
- **Milestone:** 5

## Context

[0032](0032-1-0-comes-after-rehearsal.md) held 1.0 back until Rehearsal had tested the cluster's interfaces against faults. That's done: the hunt fixed twenty bugs and a million seeds pass ([0043](0043-the-hunt-and-fencing.md)). Semver says what a major version is for, but not what this package's public API is, and some of it isn't obvious. Users `switch` over `SystemEvent`, a dead letter's `reason`, a history entry's `kind` and a Backstage frame's `type`. Every milestone so far added cases to at least one of them, and 0.2.0's changelog marked each addition **Breaking**. Rehearsal adds a different question: a seed is meant to give the same run every time, but any fix to the cluster changes what a seed's run does.

## Decision

From 1.0.0, a change that breaks any of the following waits for a major version.

- **The exports.** Exactly the names on each entry point's list in `test/package.test.ts`, and their documented behaviour: 182 names on twelve entry points, in the table below. Nothing else is public. That includes `dist/`'s other files, the internals that tests and the package's own scripts reach, and the wording of errors, log lines and violation messages.
- **Open unions.** A minor version can add these, so code that `switch`es over them needs a `default`, and each one's TSDoc says so:
  - `SystemEvent` types, and fields on an event;
  - dead-letter reasons;
  - a Rehearsal history entry's `kind`, and fields on an entry;
  - fault kinds, both `Fault` and `FaultKind`;
  - Backstage frame types, and optional fields on a frame.

  Removing a case, or changing what one means, is major.
- **Backstage's protocol.** `PROTOCOL` changes only in a major version. Within one, a frame can gain optional fields and new types, and an inspector skips what it doesn't know. Backstage's own UI does, and a test holds it to that. How the UI looks isn't promised.
- **The cluster's wire protocol** keeps its version, which a peer on another one refuses, until a major version. Optional fields can be added, as keep the majority's hello fields were ([0042](0042-keep-the-majority.md)).
- **The table SQL** in `dist/`, for SQLite, the Postgres journal and the Postgres shard store, changes only in a major version, since a change there needs a migration.
- **Node 22.18 and later.** Dropping a Node line is major.
- **Defaults** can be tuned in a minor version, and the changelog names each change. A new default that breaks code relying on the old one is major, as 0.3.0's timeouts would have been ([0036](0036-timeouts-are-unknown-outcomes-settled-by-recovery.md)).
- **Rehearsal's seeds and replay lines are promised within one version only.** On the same version, a seed and a plan give the same history byte for byte ([0034](0034-a-run-is-a-seed-and-a-plan.md)). Across versions, a seed can draw a different plan, and a plan can play out differently, since every fix to the cluster changes what a run does. A replay line now carries the version that recorded it. When a line from another version doesn't reproduce, `replay` names both versions instead of blaming non-determinism. Lines from before 1.0 have no version, and still run.

### The review

Every export was reviewed for its name, its TSDoc and whether it's ready to promise. The entry points milestone 3 reviewed for 0.1.0 were checked again for what's changed since.

| Entry point | Names | Found |
| --- | --- | --- |
| `.` | 33 | Ready. Since 0.1.0 it has gained the JSON check ([0037](0037-the-json-check-is-public.md)) and the pipe's signal ([0038](0038-a-pipe-with-a-signal-ends-on-the-scheduler.md)). `SystemEvent`'s and `DeadLetterReason`'s TSDoc now say they're open |
| `/testkit` | 9 | Ready. Unchanged since 0.1.0's review, which made `TestProbe` a type only |
| `/persistence` | 27 | Ready. `PersistenceTimeoutError` and `timeoutMs` came in 0.3.0 ([0036](0036-timeouts-are-unknown-outcomes-settled-by-recovery.md)) |
| `/persistence/sqlite`, `/persistence/postgres` | 2, 5 | Ready |
| `/backstage` | 18 | Ready. `Frame`'s and `PROTOCOL`'s TSDoc say what may change. Backstage's UI no longer takes an unknown frame for an event |
| `/backstage/ui`, `/backstage/server` | 4, 3 | Ready. `/backstage/ui` came in 0.4.0 ([0045](0045-backstage-embeds-with-a-mount-function-and-react-inside.md)) |
| `/cluster`, `/cluster/postgres`, `/cluster/tcp` | 17, 2, 2 | Ready. The hunt changed behaviour, not names: keep the majority ([0042](0042-keep-the-majority.md)) and the store's fixes ([0043](0043-the-hunt-and-fencing.md)) |
| `/rehearsal` | 60 | Ready after the changes below |

What the review changed, all in `/rehearsal`, which has never been released:

- **The TSDoc test didn't cover `/rehearsal`**, so 123 fields of its types had no comment, most of them on history entries and faults. They have one now, and the test lists the entry point.
- **`AcknowledgedWritesOptions.kept` had its comment on the wrong field.** Two comments were stacked on `acknowledged`, so `kept` had none.
- **`DelayFault` and the `slow` disk fault named `Range`,** a type the entry point doesn't export. They now spell it out as `readonly [number, number]`, as `FaultOptions.lastingMs` already did.

Nothing was removed or renamed. Every name on the lists is one a user needs, to call a function or to name what it takes or returns.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Closed unions: a new `SystemEvent` type or dead-letter reason is a major version | Every milestone added some. A cluster feature as small as a new lease event would need a 2.0, and in practice the cases would stop being added and the information would go somewhere less typed. Open unions are how TypeScript libraries usually grow. |
| A seed's run promised across minor versions | It can't be kept. A fix to the cluster changes what happens after the moment it fixes, and that changes the history. Promising it would make every fix a major version, or leave a promise that's quietly broken. |
| A replay line refused on another version | Most lines still reproduce on a nearby version, and a refusal would make the planted bugs' recorded lines useless after any release. Naming both versions when a line doesn't reproduce says what the user needs to know. |
| Marking `/rehearsal` experimental within 1.0 | Semver can't exempt part of a package (0032). Rehearsing your own entities is the reason the entry point is public. |
| The table SQL left out of the promise | A user's database outlives the package version. A schema change without a major version would break a running deployment on `npm update`. |

## Evidence

- **The export lists:** `test/package.test.ts` checks, from the built `dist/`, that each of the twelve entry points exports exactly its list, values and types, through the package's exports map as a user's import resolves it.
- **The TSDoc:** `test/tsdoc.test.ts` checks every export of every entry point, `/rehearsal` included, and every public member. With `/rehearsal` added, it failed on 123 fields until they were documented.
- **Open frames:** `test/backstage-ui/store.test.ts` sends Backstage's store a frame type and an event type it doesn't know, and checks it skips both and carries on. Before the fix, it threw.
- **Replay lines:** `test/rehearsal/rehearse.test.ts` checks that a line carries this version, that a line with no version still decodes and runs, and that one from another version names both versions when it doesn't reproduce. `test/version.test.ts` fails unless the version the core records is `package.json`'s.
- **The release:** to be filled in once 1.0.0 is published, as 0024's and 0032's were: the release run, provenance, the tarball checks, and the smoke test on Node 22, 24 and 26.

## Consequences

- A `switch` over any open union needs a `default`. The built-in invariants and Backstage's UI already skip what they don't know, and the README's Rehearsal section says so for invariants of your own.
- Each minor version's changelog lists new union cases and changed defaults, but doesn't mark them **Breaking**. **Breaking** means a major version from now on.
- `src/version.ts` and `package.json`'s version change together in every release commit, and a test holds them to that.
- The recorded runs and hunts in `docs/decisions/data/` and `test/rehearsal/planted.ts` stay valid only while their lines reproduce. The tests replay them, so a change that alters them fails there and gets them recorded again.
- 1.0 says nothing about mixing versions in one cluster beyond the wire protocol's version. No test runs a cluster with nodes on two versions yet.
