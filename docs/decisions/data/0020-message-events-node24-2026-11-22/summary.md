# Benchmark: v24.22.3

`npm run bench -- --only events,ping-pong-noyield --out docs/decisions/data/0020-message-events-node24-2026-11-22 --compare docs/decisions/data/0019-baseline-node24-2026-11-22` on Apple M5 Pro, commit 921fd59 (src/ at 921fd59). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,367,241 msg/s | 4,196,237 | 4,585,865 | 8.9% |  |  |
| events-none | messages 1,000,000 | 10 | 4,412,439 msg/s | 4,216,163 | 4,585,967 | 8.4% |  |  |
| events-plain | messages 1,000,000 | 10 | 4,432,083 msg/s | 4,271,406 | 4,652,569 | 8.6% |  |  |
| events-messages | messages 1,000,000 | 10 | 2,621,023 msg/s | 2,519,897 | 2,763,411 | 9.3% |  |  |
