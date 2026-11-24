# Benchmark: v22.23.5

`npm run bench -- --only ping-pong,journal-postgres-100,entity-tell,remote,failover,handoff,cluster-appends --out docs/decisions/data/0031-cluster-node22-2026-11-24` on Apple M5 Pro, commit d9fd655 (src/ at d9fd655). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong | messages 1,000,000 | 10 | 449,040 msg/s | 439,881 | 486,834 | 10.5% |  |  |  |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,214,042 msg/s | 2,435,816 | 4,599,239 | 51.3% |  |  |  |
| journal-postgres-100 | streams 100, appendsPerStream 20 | 10 | 1,821 appends/s | 1,561 | 2,017 | 25.1% |  |  |  |
| journal-postgres-100-nolock | streams 100, appendsPerStream 20 | 10 | 7,361 appends/s | 5,313 | 8,156 | 38.6% |  |  |  |
| entity-tell-local | messages 200,000 | 10 | 197,859 msg/s | 188,209 | 211,314 | 11.7% |  |  |  |
| entity-tell-local-noyield | messages 200,000 | 10 | 1,270,705 msg/s | 1,231,127 | 1,316,349 | 6.7% |  |  |  |
| entity-tell-remote | messages 100,000 | 10 | 59,095 msg/s | 56,000 | 60,756 | 8% |  |  |  |
| remote-ping-pong | messages 100,000 | 10 | 64,248 msg/s | 63,083 | 65,278 | 3.4% |  |  |  |
| remote-ask | asks 10,000 | 10 | 29,838 asks/s | 28,639 | 31,208 | 8.6% | 30.94 µs (30.5–31.67) | 74.98 µs (53.75–96.54) | 466.42 µs (362.46–585.54) |
| failover | kills 20 | 1 | — | — | — | — | 10,437 ms (10,437–10,437) | 11,650 ms (11,650–11,650) | 11,650 ms (11,650–11,650) |
| handoff | shards 64 | 10 | — | — | — | — | 22 ms (9–25) | 22 ms (9–25) | 22 ms (9–25) |
| cluster-appends-postgres | entities 100, buysPerEntity 20 | 10 | 1,483 appends/s | 1,284 | 1,562 | 18.7% |  |  |  |
