# 0007. The dispatcher wakes on a microtask and yields on a macrotask

- **Status:** Accepted
- **Date:** 2026-11-20
- **Milestone:** 1

## Context

The dispatcher runs actors' messages on a single thread, shared with I/O and timers. Waking on a microtask is fast, but actors that keep messaging each other would starve the event loop. Waking on a macrotask (`setTimeout(0)`) is fair, but slow: Node waits at least 1 ms, and browsers clamp nested timers to 4 ms.

## Decision

The dispatcher keeps a FIFO ready queue of actors. When work arrives and it's idle, it starts on a microtask (`scheduler.runSoon`). Each actor runs up to `throughput` messages per turn (default 10), then goes to the back of the queue. After `yieldAfter` messages in a row (default 1,000), the dispatcher yields with `scheduler.setTimer(fn, 0)`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Always waking on a microtask | Two actors that ping-pong would block I/O and timers forever. |
| Always waking on `setTimeout(0)` | Adds 1 to 4 ms of latency to every idle wake-up. |
| `MessageChannel` for yields | Unclamped and available everywhere, but in Node an open port keeps the process alive, and `unref()` is Node-only (0004). Worth measuring in milestone 3. |
| `setImmediate` | Node-only (0004). |

## Evidence

T2's test: a real `setTimeout(0)` fires while two actors ping-pong without end. Milestone 3's throughput benchmark will tune the defaults and compare `MessageChannel`.

**T2 (2026-11-20):**
- `test/dispatcher.real-time.test.ts`: on `realScheduler`, a real `setTimeout(0)` fires mid-rally while two actors ping-pong without end.
- `test/dispatcher.test.ts`, "yields to timers after yieldAfter messages in a row": on virtual time, with `yieldAfter: 50`, a timer queued before the rally fires after exactly 48 rallies. The first drain spends two steps on the actors' `initial`s.
- "interleaves busy actors throughput messages at a time": shows the ready queue's fairness, as A A B B A A B B with `throughput: 2`.
- Breaking the yield fails the virtual-time test. The real-time test hangs instead of failing, because a synchronous loop that never ends blocks the event loop, Vitest's own timeouts included. CI's job timeout would catch it, but the virtual-time test is the one that fails cleanly.

## Consequences

- Latency stays low for light traffic, and busy systems still let I/O through.
- `throughput` and `yieldAfter` are knobs that users can get wrong. Their defaults should come from benchmark numbers by milestone 3.
