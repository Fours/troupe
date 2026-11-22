# Benchmark: v22.23.5

`npm run bench -- --out docs/decisions/data/0019-baseline-node22-2026-11-22` on Apple M5 Pro, commit 4003682 (src/ at dbf9ad9). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong | messages 1,000,000 | 10 | 448,800 msg/s | 443,760 | 458,164 | 3.2% |  |  |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,503,322 msg/s | 3,726,908 | 4,665,881 | 20.9% |  |  |
| ask | asks 100,000 | 10 | 1,677,551 asks/s | 1,610,792 | 1,694,257 | 5% | 0.46 (0.42–0.46) | 1.46 (1.38–1.63) |
| fan-out | children 10,000, rounds 100 | 10 | 530,004 msg/s | 492,278 | 615,818 | 23.3% |  |  |
| fan-out-noyield | children 10,000, rounds 100 | 10 | 13,814,294 msg/s | 11,655,258 | 16,211,418 | 33% |  |  |
| spawn-stop | actors 10,000 | 10 | 224,666 actors/s | 180,584 | 233,844 | 23.7% |  |  |
| events-none | messages 1,000,000 | 10 | 4,534,862 msg/s | 4,242,669 | 4,684,046 | 9.7% |  |  |
| events-plain | messages 1,000,000 | 10 | 4,583,666 msg/s | 4,191,355 | 4,726,563 | 11.7% |  |  |
| journal-memory-1 | streams 1, appendsPerStream 10,000 | 10 | 1,860,271 appends/s | 1,396,201 | 1,966,262 | 30.6% |  |  |
| journal-memory-100 | streams 100, appendsPerStream 100 | 10 | 1,656,115 appends/s | 1,499,044 | 1,721,899 | 13.5% |  |  |
| journal-sqlite-1 | streams 1, appendsPerStream 2,000 | 10 | 20,158 appends/s | 17,872 | 25,688 | 38.8% |  |  |
| journal-sqlite-100 | streams 100, appendsPerStream 20 | 10 | 24,670 appends/s | 15,479 | 25,455 | 40.4% |  |  |
| journal-postgres-1 | streams 1, appendsPerStream 2,000 | 10 | 1,552 appends/s | 1,470 | 1,681 | 13.6% |  |  |
| journal-postgres-100 | streams 100, appendsPerStream 20 | 10 | 2,109 appends/s | 1,981 | 2,169 | 8.9% |  |  |
| journal-postgres-100-nolock | streams 100, appendsPerStream 20 | 10 | 8,551 appends/s | 7,975 | 8,764 | 9.2% |  |  |
