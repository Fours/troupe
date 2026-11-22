# 0024. Publish from CI with trusted publishing and provenance, starting at 0.1.0

- **Status:** Proposed
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

The package goes on npm for the first time in milestone 3. Publishing from a laptop needs a long-lived npm token or an interactive login there, and nothing ties the published tarball to a commit: a reader of the npm page has to trust that `dist/` was built from what's on GitHub, with the tests passing. Most supply chain attacks on npm packages come from a stolen publish token or a tarball that differs from its source. The API also isn't settled: milestone 4 adds remote refs and cluster sharding, and milestone 5 adds Rehearsal, and both may change what's public now. rate-limiter solved the same problem in its [0025](https://github.com/Fours/rate-limiter/blob/main/docs/decisions/0025-publish-from-ci-with-provenance.md), and this record follows it except for the version.

## Decision

- **`.github/workflows/release.yml` publishes when a `v*` tag is pushed, and only then.** It runs CI's whole workflow (`ci.yml`, as a reusable workflow) on the tagged commit first: every Node line, Postgres, the package checks and the Playwright job. The publish job waits for all of it.
- **It refuses a tag that doesn't name exactly the version in `package.json`** (`v0.1.0` for `0.1.0`), with `scripts/check-release-tag.ts`. It also refuses a prerelease version, since it publishes to the `latest` dist-tag, and a tagged commit that isn't on `main`.
- **Trusted publishing, with no npm token anywhere.** npm trusts this repository's `release.yml`, run in the `npm` GitHub environment, and nothing else. The job gets a short-lived OIDC token from GitHub (`id-token: write`, on the publish job only) and npm exchanges it for a publish. The `npm` environment only accepts deployments from `v*` tags, so a branch can't publish even by editing the workflow.
- **Provenance comes with it.** Publishing through OIDC from a public repository makes npm attach a signed provenance statement on its own: which commit, which workflow and which run built the tarball. npm checks it against `repository` in `package.json`, which has to name this repository exactly.
- **Node 24 publishes.** Trusted publishing needs npm 11.5.1 or later, and Node 22 ships npm 10. The job checks npm's version before it tries.
- **What ships is checked before it ships.** An API review came first: every entry point's exact export list is checked against `dist/`'s declarations, and every export has TSDoc. `scripts/check-pack.ts` fails on any file in the tarball outside `dist/`, the README, the licence, the changelog and `package.json`, on any missing entry point, and on any dependency. `publint` checks `package.json`, and `attw --profile esm-only` checks that every entry point's types resolve. All three run in CI and again in the publish job.
- **The first version is 0.1.0.** Under 0.x semver promises nothing between minor versions, which is honest while milestones 4 and 5 can still move the API. 1.0 comes after milestone 4.
- **A placeholder creates the package by hand.** npm sets up a trusted publisher in an existing package's settings, so `0.0.0-placeholder.0`, an empty package, is published once from a laptop under the `placeholder` dist-tag, then deprecated. Every real version comes from CI.
- **No GitHub Release.** `CHANGELOG.md` ships in the package and is on GitHub. A release page would only repeat it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Publish by hand with `npm publish` | Needs a login or token on a laptop, runs whatever is in the working tree, and gives no provenance. |
| An npm automation token in a GitHub secret | A long-lived secret that can publish from anywhere if it leaks. Trusted publishing replaces it. |
| Publish 0.1.0 by hand, then CI from 0.1.1 | 0.1.0, the version people see first, would have no provenance. The placeholder costs one throwaway version instead. |
| Publish on every push to `main` (semantic-release, changesets) | More machinery than a solo project needs, and every release should be a decision, not a side effect of a push. |
| Start at 1.0.0, as rate-limiter did | rate-limiter's API was finished. This one gains remote refs in milestone 4, and 1.0 would promise a stability it can't keep. |
| Ship source maps, with `src/` | Doubles the tarball for stack traces that only `--enable-source-maps` reads, and `src/` isn't what the package runs. Without `src/`, the maps point at nothing, so the build makes none. |
| A GitHub Release per tag | It would repeat the changelog, with one more thing to keep in step. |

## Evidence

Proposed until 0.1.0 is published. What will prove it, in milestone 3's T7:

- The release run for `v0.1.0`, whose CI jobs pass before `publish` starts.
- npm's provenance statement for 0.1.0, naming `release.yml`, the tag, the commit and the run, and `npm audit signatures` verifying it in an empty project.
- No workflow reading `NPM_TOKEN`, `NODE_AUTH_TOKEN` or any secret.
- `test/scripts/check-release-tag.test.ts`, which covers a matching tag, eight mismatched ones, a prerelease, and the script's exit codes.
- `scripts/smoke-published.sh 0.1.0` running the README's quick start from npm on Node 22, 24 and 26.

## Consequences

- Releasing is: bump `version`, date the changelog, commit, tag `vX.Y.Z` on `main`, push the tag. A wrong tag fails before anything is published.
- A release takes as long as CI with Postgres and Playwright, about 10 minutes.
- The trusted publisher's settings on npmjs.com must match exactly: owner `Fours`, repository `troupe`, workflow `release.yml`, environment `npm`. Renaming any of them stops publishing until it's set up again.
- Prereleases need a change to the workflow first, to publish them under another dist-tag.
- `0.0.0-placeholder.0` stays on npm, deprecated. Check the registry a few minutes after a release before deciding it failed: rate-limiter's 1.0.0 took about a minute and a half to appear after its run went green.
- Removing something public now costs a minor version, and after 1.0 a major one. T7's review removed what it could while that was free.
