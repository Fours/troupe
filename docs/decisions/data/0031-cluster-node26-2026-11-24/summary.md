# Benchmark: v26.12.1

`npm run bench -- --only ping-pong,journal-postgres-100,entity-tell,remote,failover,handoff,cluster-appends --out docs/decisions/data/0031-cluster-node26-2026-11-24` on Apple M5 Pro, commit d9fd655 (src/ at d9fd655). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong | messages 1,000,000 | 10 | 530,769 msg/s | 476,243 | 732,843 | 48.3% |  |  |  |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,136,612 msg/s | 3,829,936 | 20,016,764 | 391.3% |  |  |  |
| journal-postgres-100 | streams 100, appendsPerStream 20 | 10 | 1,855 appends/s | 1,687 | 1,979 | 15.7% |  |  |  |
| journal-postgres-100-nolock | streams 100, appendsPerStream 20 | 10 | 7,333 appends/s | 6,769 | 8,214 | 19.7% |  |  |  |
| entity-tell-local | messages 200,000 | 10 | 198,935 msg/s | 180,512 | 322,792 | 71.5% |  |  |  |
| entity-tell-local-noyield | messages 200,000 | 10 | 1,173,427 msg/s | 891,775 | 1,227,639 | 28.6% |  |  |  |
| entity-tell-remote | messages 100,000 | 10 | 59,194 msg/s | 56,216 | 60,320 | 6.9% |  |  |  |
| remote-ping-pong | messages 100,000 | 10 | 60,759 msg/s | 56,271 | 68,257 | 19.7% |  |  |  |
| remote-ask | asks 10,000 | 10 | 31,777 asks/s | 29,480 | 33,131 | 11.5% | 29.33 µs (28.83–30.13) | 65.73 µs (48.54–112.12) | 411.81 µs (365.58–15,363.21) |
| failover | kills 20 | 1 | — | — | — | — | 11,019 ms (11,019–11,019) | 11,680 ms (11,680–11,680) | 11,680 ms (11,680–11,680) |
| handoff | shards 64 | 10 | — | — | — | — | 19 ms (11–22) | 19 ms (11–22) | 19 ms (11–22) |
| cluster-appends-postgres | entities 100, buysPerEntity 20 | 10 | 1,384 appends/s | 1,153 | 1,544 | 28.3% |  |  |  |
