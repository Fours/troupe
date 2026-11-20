# 0007. The dispatcher wakes on a microtask and yields on a macrotask

- **Status:** Proposed
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

## Consequences

- Latency stays low for light traffic, and busy systems still let I/O through.
- `throughput` and `yieldAfter` are knobs that users can get wrong. Their defaults should come from benchmark numbers by milestone 3.
