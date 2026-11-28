# 0044. The Rehearsal page runs its seeds in a worker, and draws recorded runs built into the page

- **Status:** Accepted
- **Date:** 2026-11-28
- **Milestone:** 5

## Context

The site's fourth page, `/rehearsal/`, does three things: it runs festival night's scenario on seed after seed in the visitor's browser, it draws one run in detail, and it draws each planted bug's failing run with the moment it broke marked. The spec planned the seeds "between animation frames", on the page's own thread, as opening night and festival night run (0022), and the bugs' runs from histories in `docs/decisions/data/`, read when the site builds, as the write-up's charts are, so the page doesn't ship the bugs that made them.

Two things didn't fit. A minute of festival night takes about 55 ms of CPU in a Node worker process (0034), and festival night's pages already keep a 50 ms frame budget only because their work comes in small settles between frames. Rehearsal's run loop yields a macrotask whenever nothing is ready (0033), but it was built for speed, not for a frame budget. And a bug's whole history is large: the six planted runs' histories come to 2.4 MB.

## Decision

- **Seeds run in a dedicated Web Worker** (`demo/src/rehearsal/worker.ts`), on the real code, the real simulated network and database, and festival night's scenario (`demo/src/rehearsal/domain/festival.ts`), which the tests and `npm run rehearse` share. The worker does one thing at a time: a request to draw a run is taken before the next seed. It posts the counts after each seed, and a run as a drawing, never as its history. The page only draws.
- **A run is drawn by one pure function**, `draw(history, violation)` in `demo/src/rehearsal/domain/drawing.ts`, with no React and no clock: the worker draws live runs with it, and the site's build draws the recorded ones.
- **Recorded runs keep only what the drawing reads.** `scripts/record-runs.ts` replays each planted bug's line from `test/rehearsal/planted.ts` with the bug planted, checks it breaks the invariant the line recorded, and writes the history trimmed by `isDrawn` to `docs/decisions/data/0040-runs-<date>/<bug>.json`, with the replay line that gives the whole run back. A test checks a trimmed history draws the same as the whole one.
- **The build fails** if a recorded run is missing or malformed, or isn't the run the planted table (`0043-planted-2026-11-27.json`) found.
- **The hunt's real bugs aren't drawn failing.** Their fixes landed together in T7, and the code before them has every one of them at once, so earlier bugs hide later ones. The page lists each with its fix, and runs its shrunk plan on today's code on request, which heals.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Seeds on the main thread, between animation frames (the spec's plan) | Breaks the frame budget: with the runs moved onto the main thread, the frame test below fails |
| Seeds on the main thread, in slices that yield to `requestAnimationFrame` | The run loop would have to know about frames, and the core knows nothing of the browser (0004). A worker needs no change to `src/` |
| Whole histories in `docs/decisions/data/` | 2.4 MB, nearly all of it database calls, messages sent and journal contents the page never draws |
| Replaying the bugs in the browser from their lines | Ships the planted bugs, which are internal and never public (0040) |
| Planting each of the hunt's twenty real bugs, to draw them failing | Twenty more plants in `src/` for a picture, when each already has a regression plan |

## Evidence

- **The frame budget.** `e2e/frames.spec.ts` runs seeds on the page while scrolling through every drawing, and no animation frame takes 50 ms or more. With the worker swapped for the same `Runner` on the main thread, the same test fails with long frames.
- **The size.** Trimmed, the six recorded runs are 460 KB in `docs/decisions/data/0040-runs-2026-11-28/`, and their drawings, as the build inlines them, are under 100 KB (`test/demo/rehearsal-data.test.ts`).
- **The same picture.** `test/demo/rehearsal-drawing.test.ts` draws a hand-written history and a real festival run, each whole and trimmed, and gets the same drawing.
- **Speed.** About 30 runs a second in Chromium on an Apple M5 Pro, in contract mode.

## Consequences

- The page can run seeds flat out without costing a frame, and a visitor's count is real work on the real code.
- A change to `isDrawn` or to what a run draws needs the runs recorded again (`npm run build && node scripts/record-runs.ts`), and so does a change to the planted hunts' lines. The build says so.
- The worker is a separate bundle, so the page's main chunk stays small: the package's code loads only in the worker.
