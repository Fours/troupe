# Benchmark: v22.23.5

`npm run bench -- --only events,ping-pong-noyield --out docs/decisions/data/0020-message-events-node22-2026-11-22 --compare docs/decisions/data/0019-baseline-node22-2026-11-22` on Apple M5 Pro, commit 921fd59 (src/ at 921fd59). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,221,878 msg/s | 4,055,827 | 4,453,940 | 9.4% |  |  |
| events-none | messages 1,000,000 | 10 | 4,356,377 msg/s | 4,153,085 | 4,455,993 | 7% |  |  |
| events-plain | messages 1,000,000 | 10 | 4,206,250 msg/s | 3,981,802 | 4,509,166 | 12.5% |  |  |
| events-messages | messages 1,000,000 | 10 | 2,539,255 msg/s | 2,355,528 | 2,595,056 | 9.4% |  |  |
