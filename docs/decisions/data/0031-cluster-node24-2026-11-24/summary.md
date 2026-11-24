# Benchmark: v24.22.3

`npm run bench -- --only ping-pong,journal-postgres-100,entity-tell,remote,failover,handoff,cluster-appends --out docs/decisions/data/0031-cluster-node24-2026-11-24` on Apple M5 Pro, commit d9fd655 (src/ at d9fd655). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong | messages 1,000,000 | 10 | 467,630 msg/s | 452,659 | 536,288 | 17.9% |  |  |  |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,293,064 msg/s | 4,151,880 | 4,467,480 | 7.4% |  |  |  |
| journal-postgres-100 | streams 100, appendsPerStream 20 | 10 | 1,921 appends/s | 1,840 | 1,986 | 7.6% |  |  |  |
| journal-postgres-100-nolock | streams 100, appendsPerStream 20 | 10 | 7,894 appends/s | 7,254 | 8,049 | 10.1% |  |  |  |
| entity-tell-local | messages 200,000 | 10 | 182,719 msg/s | 179,543 | 200,444 | 11.4% |  |  |  |
| entity-tell-local-noyield | messages 200,000 | 10 | 1,271,680 msg/s | 1,216,776 | 1,289,394 | 5.7% |  |  |  |
| entity-tell-remote | messages 100,000 | 10 | 58,542 msg/s | 57,051 | 59,654 | 4.4% |  |  |  |
| remote-ping-pong | messages 100,000 | 10 | 67,281 msg/s | 62,236 | 68,600 | 9.5% |  |  |  |
| remote-ask | asks 10,000 | 10 | 32,018 asks/s | 29,692 | 32,871 | 9.9% | 29.31 µs (29–30.42) | 66.37 µs (48.38–105.92) | 392.27 µs (339.38–568.63) |
| failover | kills 20 | 1 | — | — | — | — | 10,648 ms (10,648–10,648) | 11,542 ms (11,542–11,542) | 11,542 ms (11,542–11,542) |
| handoff | shards 64 | 10 | — | — | — | — | 18 ms (11–23) | 18 ms (11–23) | 18 ms (11–23) |
| cluster-appends-postgres | entities 100, buysPerEntity 20 | 10 | 1,595 appends/s | 1,194 | 1,673 | 30.1% |  |  |  |
