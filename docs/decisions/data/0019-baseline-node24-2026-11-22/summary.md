# Benchmark: v24.22.3

`npm run bench -- --out docs/decisions/data/0019-baseline-node24-2026-11-22` on Apple M5 Pro, commit 4003682 (src/ at dbf9ad9). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong | messages 1,000,000 | 10 | 480,679 msg/s | 448,638 | 522,248 | 15.3% |  |  |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,669,006 msg/s | 4,240,890 | 4,799,472 | 12% |  |  |
| ask | asks 100,000 | 10 | 1,682,002 asks/s | 1,663,145 | 1,702,986 | 2.4% | 0.42 (0.42–0.42) | 1.15 (1.08–1.21) |
| fan-out | children 10,000, rounds 100 | 10 | 541,748 msg/s | 523,352 | 566,516 | 8% |  |  |
| fan-out-noyield | children 10,000, rounds 100 | 10 | 13,920,975 msg/s | 13,040,084 | 14,625,933 | 11.4% |  |  |
| spawn-stop | actors 10,000 | 10 | 221,791 actors/s | 208,438 | 260,757 | 23.6% |  |  |
| events-none | messages 1,000,000 | 10 | 4,692,937 msg/s | 4,393,376 | 4,797,594 | 8.6% |  |  |
| events-plain | messages 1,000,000 | 10 | 4,682,802 msg/s | 4,533,852 | 4,784,236 | 5.3% |  |  |
| journal-memory-1 | streams 1, appendsPerStream 10,000 | 10 | 1,800,283 appends/s | 1,221,020 | 1,846,182 | 34.7% |  |  |
| journal-memory-100 | streams 100, appendsPerStream 100 | 10 | 1,725,501 appends/s | 1,126,459 | 1,787,456 | 38.3% |  |  |
| journal-sqlite-1 | streams 1, appendsPerStream 2,000 | 10 | 19,332 appends/s | 14,126 | 25,220 | 57.4% |  |  |
| journal-sqlite-100 | streams 100, appendsPerStream 20 | 10 | 24,361 appends/s | 20,396 | 24,954 | 18.7% |  |  |
| journal-postgres-1 | streams 1, appendsPerStream 2,000 | 10 | 1,551 appends/s | 1,501 | 1,630 | 8.3% |  |  |
| journal-postgres-100 | streams 100, appendsPerStream 20 | 10 | 2,165 appends/s | 2,043 | 2,190 | 6.8% |  |  |
| journal-postgres-100-nolock | streams 100, appendsPerStream 20 | 10 | 8,781 appends/s | 8,246 | 8,914 | 7.6% |  |  |
