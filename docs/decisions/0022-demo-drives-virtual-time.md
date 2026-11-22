# 0022. The demo drives virtual time from animation frames, so pausing pauses the system

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

The demo runs a whole Troupe system in the visitor's browser (0004). Visitors need to pause it, slow it down to follow a crash, and speed it up to see a rush drain. A real-time system can't pause: its timers keep firing while the UI is frozen. The system also has to tell the same story for the same seed, so a bug seen once can be seen again, and so the unit tests describe what the page does.

Every clock and coin flip in the core is already injected (0003), and the testkit's `ManualScheduler` moves time only when told. The open question was how to move it from the page. `advanceTo` runs timers synchronously, but the in-memory journal resolves on microtasks, so a write started at one due time hasn't finished when `advanceTo` runs the next one.

## Decision

- **The system runs on a `ManualScheduler` and `seededRandom`.** Nothing in the demo's domain reads real time or real chance, and lint enforces that in `demo/src/domain/`.
- **The page moves virtual time from `requestAnimationFrame`.** Each frame passes its real elapsed time to `DrivenClock.tick`, which multiplies it by the speed (paused, ¼×, 1× or 4×), keeps whole milliseconds and carries the fraction. Paused, time doesn't move, so the system is frozen, not just the UI. One frame counts at most 250 ms, so a backgrounded tab doesn't fast-forward when it comes back.
- **Time moves one due time at a time, settling at each,** as the testkit's `advance` does. The clock advances to the next timer that falls due within the frame, then settles: it runs what's ready, yields one turn of the event loop so every pending promise settles, and repeats until a turn passes with nothing new ready. Only then does it go on to the next due time, and finally to the frame's end.
- **The page yields through a `MessageChannel`.** Browsers clamp nested `setTimeout(0)` to 4 ms, and a frame at 4× can hold dozens of settles. The yield is passed into the clock, so the domain doesn't depend on the browser, and tests pass `setImmediate`.
- **Everything that touches the system runs in the clock's turn.** Ticks, button presses, asks and restarts queue on the clock, and none starts until the one before has finished. A press lands between due times, never in the middle of a settle. So the story depends only on the seed and the virtual times of the presses, not on how real time was cut into frames.
- **The system exists before its actors spawn.** They spawn in the clock's first turn, so a subscriber or an inspector attached at once sees every spawn.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Real time, with the UI paused | Timers keep firing behind a frozen picture. Holds expire and backoffs elapse while "paused", which is the opposite of what a visitor asked for |
| One `advanceTo` per frame | Fires later timers before earlier writes resolve. In the probe below, about four in five asks timed out against a journal that answers at once |
| Steps of at most 10 ms (the spec's first plan) | Still fires two due times in one step without settling between them, and the steps fall wherever frames do, so the same seed tells a different story at a different frame rate |
| `createTestKit` in the page | Its `advance` is the right algorithm, but the kit keeps every event and log in arrays that grow forever, and settles through `setTimeout(0)`, which browsers clamp |

## Evidence

**The probe (T4).** A persistent counter on the in-memory journal, and a driver that asks it with a 1 ms timeout on seeded timers 1 to 9 ms apart. It was driven through 1,920 ms of virtual time, about 380 asks, three ways, each with frames of 16 ms, 32 ms, and a mix of 7, 25, 13 and 19 ms. It ran on Node 24 against `dist/`.

| Stepping | Asks timed out, per frame cut | Same story for every frame cut |
| --- | --- | --- |
| One jump per frame | 309, 317, 305 | No |
| At most 10 ms per step | 283, 281, 279 | No |
| Each due time, settling at each | 0, 0, 0 | Yes |

Settling after one due time took two turns of the event loop that did work, the write and then the reply it queued, and a third to see that nothing more was ready.

**The tests,** in `test/demo/`:

- `clock.test.ts` turns the probe into tests: no write loses to a later timer, the story is identical for frames of 16 ms, 33 ms, a mix and 250 ms, and the one-jump counter-example does time out. It also covers pause, ¼× with carried fractions, 4×, the 250 ms cap, the order of queued calls, and a settle that never ends.
- `opening-night.test.ts` runs the whole demo twice with the same seed and the same presses at the same virtual times, with frames of 16 ms and of 7, 33, 250 and 1 ms. The encoded event lists match event for event, over 1,000 events, and another seed differs. A press made while a tick is still settling lands at the tick's end.
- `e2e/demo.spec.ts` checks in Chromium that pausing stops the clock and that ¼× starts it again.

## Consequences

- Pausing, slowing down and speeding up are exact, and the unit tests on the testkit describe the page's behaviour, since both step the same way.
- A frame at 4× during a rush runs many settles, each a few event-loop turns. That's cheap with a `MessageChannel`. T5's 50 ms frame budget will show whether it stays cheap with Backstage drawing too.
- The domain can't use anything that resolves on real time, such as a real network call, since a settle assumes everything finishes within a few turns. It throws `SettleError` after 1,000 turns rather than hang.
- Recording a run and replaying it from its seed (milestone 5) needs only the seed and the presses' virtual times.
