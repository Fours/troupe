# 0032. 1.0 comes after milestone 5, not milestone 4

- **Status:** Accepted. What 1.0 promises is [0039](0039-what-1-0-promises.md)
- **Date:** 2026-11-24
- **Milestone:** 4

## Context

[0024](0024-publish-from-ci-with-provenance.md) started the package at 0.1.0 and said 1.0 would come after milestone 4, once remote refs and sharding had settled the API. Milestone 4 is done, and it did change the API: `deadLetter` gained three reasons, `SystemEvent` gained seven event types, `ctx.watch` accepts remote refs, and Backstage's protocol went to version 2. Each would have been a major version under 1.0. Milestone 5, Rehearsal, replaces the network and the shard store with simulated ones that drop, delay and reorder messages, partition nodes, and skew and pause clocks. Those are exactly the interfaces it can change: `Transport`, `Connection`, `ShardStore` and the lease and membership options. It's also the milestone that tests the cluster's one promise, at most one live instance per entity, against faults, and it may find that something public has to change to keep it.

## Decision

- **Milestone 4 ships as 0.2.0, not 1.0.0.** Under 0.x, a minor version may break the API, and the changelog lists each change.
- **1.0 comes after milestone 5.** Once Rehearsal has run the cluster's interfaces against injected faults, and the invariant checker has passed over its seeds, the API is promised.
- This supersedes only 0024's plan for 1.0. Everything else in 0024, how and from where releases publish, stays, so 0024 stays Accepted, and its status line points here.

## Alternatives considered

| Option | Why not |
| --- | --- |
| 1.0.0 now, as 0024 planned | Rehearsal is built to break `Transport` and `ShardStore` on purpose, and fixing what it finds may change them. A major version a milestone after 1.0 would say 1.0 promised nothing. |
| 1.0.0 now, with `/cluster` marked experimental | Semver has no way to exempt part of a package. People who read 1.0 would expect `/cluster` to hold too, and the core's `SystemEvent` and `deadLetter` already changed for it. |
| 1.0.0 now, and 2.0.0 after Rehearsal if it must | Two majors in two milestones, for a package with no users depending on its stability yet, costs readers more than staying at 0.x for one more. |
| Prereleases of 1.0 (`1.0.0-rc.1`) | The release workflow publishes only to `latest`, and refuses prereleases (0024). Changing that buys nothing a 0.x minor doesn't. |

## Evidence

0.2.0 was published on 2026-11-24 by [release run 45440820039](https://github.com/Fours/troupe/actions/runs/45440820039), first attempt, from the tag `v0.2.0` on `c64bd90`.

- **The changes 1.0 would have broken:** 0.2.0's changelog marks four, all needed by milestone 4: `deadLetter`'s three new reasons, `SystemEvent`'s five membership events and two shard events, and Backstage's protocol version 2. Each would have been a major version after 1.0.
- **CI first:** the run's six CI jobs (`check` on Node 22, 24 and 26, `demo`, `cluster` and `cluster-docker`) passed before `publish` started.
- **Provenance:** the publish step signed a provenance statement from GitHub Actions, and npm lists a SLSA v1 provenance attestation for 0.2.0. In an empty project, `npm audit signatures` after installing 0.2.0 reports a verified registry signature and a verified attestation.
- **What ships:** `check-pack.ts`, `publint` and `attw` passed in CI and again in the publish job: 142 files, 242.7 kB packed, with `/cluster`, `/cluster/postgres` and `/cluster/tcp` resolving for ESM. Installed from npm, the three load and export what the export-list test expects, and `PROTOCOL` is 2.
- **What users get:** `scripts/smoke-published.sh 0.2.0` installed 0.2.0 from npm into an empty folder and ran the README's quick start on Node 22.23.5, 24.22.3 and 26.13.1, and each printed `2`.
- **Still 0.x:** npm's `latest` is 0.2.0.

## Consequences

- 0.2.0's changelog lists every public change since 0.1.1, since each one would break a `switch` with no `default`, or code that handled every reason.
- Milestone 5 may still change the cluster's interfaces as a minor version. Its spec should list what changes, and why, before the work starts.
- The write-up's "What's next" and the README's status say 1.0 comes after Rehearsal.
