# 0005. One npm package with subpath exports

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

The `troupe` name and the `@troupe` scope are both taken on npm, so the package is published under the user's own scope. The project will grow a testkit, persistence, cluster and inspector parts, and some of them need drivers, such as `pg`.

## Decision

Publish one package, `@kylewillett/troupe`, with subpath exports: `.` and `./testkit` now, and later `./persistence`, `./persistence/postgres`, `./cluster` and so on. Drivers are optional peer dependencies, which only their entry point imports. This is the same pattern as `prom-client` in rate-limiter.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Separate packages in an npm workspaces monorepo (`@kylewillett/troupe-core`, `-cluster`, ...) | Cleaner dependency boundaries, but more versions to keep in step and more release work. It can be split later if a driver's weight demands it. |

## Evidence

The user chose it on 2026-11-20.

## Consequences

- One version number and one changelog.
- Every subpath needs its own package test, which checks that importing the core never loads a driver.
- `exports`, `files` and the build must grow together as entry points are added.
