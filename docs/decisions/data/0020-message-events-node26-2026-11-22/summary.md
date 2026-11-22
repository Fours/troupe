# Benchmark: v26.12.1

`npm run bench -- --only events,ping-pong-noyield --out docs/decisions/data/0020-message-events-node26-2026-11-22 --compare docs/decisions/data/0019-baseline-node26-2026-11-22` on Apple M5 Pro, commit 921fd59 (src/ at 921fd59). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,415,027 msg/s | 4,068,203 | 4,536,605 | 10.6% |  |  |
| events-none | messages 1,000,000 | 10 | 4,274,425 msg/s | 3,995,715 | 4,564,825 | 13.3% |  |  |
| events-plain | messages 1,000,000 | 10 | 4,344,139 msg/s | 4,166,393 | 4,479,026 | 7.2% |  |  |
| events-messages | messages 1,000,000 | 10 | 2,595,987 msg/s | 2,409,349 | 2,667,505 | 9.9% |  |  |
