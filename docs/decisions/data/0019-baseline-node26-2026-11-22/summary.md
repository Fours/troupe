# Benchmark: v26.12.1

`npm run bench -- --out docs/decisions/data/0019-baseline-node26-2026-11-22` on Apple M5 Pro, commit 4003682 (src/ at dbf9ad9). Medians of 10 runs, each in a fresh process after 3 warm-ups there, with the lowest and highest run. Spread is (max − min) / median.

| Scenario | Size | Runs | Median | Min | Max | Spread | p50 µs | p99 µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ping-pong | messages 1,000,000 | 10 | 453,635 msg/s | 432,245 | 488,067 | 12.3% |  |  |
| ping-pong-noyield | messages 1,000,000 | 10 | 4,554,886 msg/s | 4,173,922 | 20,551,200 | 359.6% |  |  |
| ask | asks 100,000 | 10 | 1,707,099 asks/s | 1,672,555 | 1,814,687 | 8.3% | 0.42 (0.42–0.42) | 1.37 (1.08–1.42) |
| fan-out | children 10,000, rounds 100 | 10 | 531,070 msg/s | 481,619 | 597,532 | 21.8% |  |  |
| fan-out-noyield | children 10,000, rounds 100 | 10 | 16,377,058 msg/s | 12,539,250 | 18,932,820 | 39% |  |  |
| spawn-stop | actors 10,000 | 10 | 201,270 actors/s | 170,440 | 221,603 | 25.4% |  |  |
| events-none | messages 1,000,000 | 10 | 4,642,459 msg/s | 3,936,162 | 4,780,642 | 18.2% |  |  |
| events-plain | messages 1,000,000 | 10 | 4,474,274 msg/s | 3,513,188 | 4,636,623 | 25.1% |  |  |
| journal-memory-1 | streams 1, appendsPerStream 10,000 | 10 | 1,858,769 appends/s | 1,741,238 | 1,899,847 | 8.5% |  |  |
| journal-memory-100 | streams 100, appendsPerStream 100 | 10 | 1,896,393 appends/s | 1,637,041 | 2,307,316 | 35.3% |  |  |
| journal-sqlite-1 | streams 1, appendsPerStream 2,000 | 10 | 20,339 appends/s | 12,725 | 24,734 | 59% |  |  |
| journal-sqlite-100 | streams 100, appendsPerStream 20 | 10 | 24,773 appends/s | 22,684 | 25,993 | 13.4% |  |  |
| journal-postgres-1 | streams 1, appendsPerStream 2,000 | 10 | 1,575 appends/s | 1,541 | 1,648 | 6.8% |  |  |
| journal-postgres-100 | streams 100, appendsPerStream 20 | 10 | 2,247 appends/s | 2,072 | 2,285 | 9.5% |  |  |
| journal-postgres-100-nolock | streams 100, appendsPerStream 20 | 10 | 8,747 appends/s | 7,313 | 9,165 | 21.2% |  |  |
