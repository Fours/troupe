// The invariant across real processes (milestone 4, "The invariant"): 20 rounds of kill -9 and
// restart, on timings scaled down so the rounds take seconds, not minutes. Afterwards the journal
// must show no two incarnations of any show writing at once, no node may have logged a
// JournalConflictError, and every acknowledged sale must be there.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/testkit/random.js';
import { SHOWS } from '../../examples/cluster/show.ts';
import { journalProblems, missingSales } from './journal.js';
import { addressOf, shardOfShow, TestCluster } from './harness.js';

const KILLS = 20;
/** A tenth of the defaults, or so: still renewMs < ttlMs - marginMs, as 0029 requires. */
const TIMINGS = {
  heartbeatMs: 200,
  unreachableAfterMs: 1_000,
  downAfterMs: 2_000,
  seedTimeoutMs: 1_000,
  leases: { ttlMs: 2_000, renewMs: 500, marginMs: 500 },
  rebalanceMs: 500,
};

describe(`${String(KILLS)} kills`, () => {
  let cluster: TestCluster;
  const active = new Set(SHOWS.map(shardOfShow));

  beforeAll(async () => {
    cluster = await TestCluster.start({ timings: TIMINGS, askTimeoutMs: 1_000, pauseMs: 20 });
  }, 60_000);

  afterAll(async () => {
    await cluster.close();
  });

  it('never runs two incarnations of a show at once', async () => {
    await cluster.until('every shard placed', () => cluster.placed(active), 60_000);
    const random = seededRandom(8);
    for (let round = 1; round <= KILLS; round++) {
      const victim = cluster.nodes[Math.floor(random() * cluster.nodes.length)];
      if (victim === undefined) throw new Error('no nodes');
      const since = cluster.seen.length;
      await victim.kill();
      // Every show answers again, none of them from the dead node.
      await cluster.until(
        `round ${String(round)}: every show answered without ${victim.name}`,
        () =>
          SHOWS.every((show) =>
            cluster
              .acks(since)
              .some(
                (a) =>
                  a.line['show'] === show && addressOf(String(a.line['inc'])) !== victim.address,
              ),
          ),
        30_000,
      );
      await cluster.restart(victim);
      await cluster.until(
        `round ${String(round)}: every shard on its desired owner`,
        () => cluster.placed(active),
        30_000,
        () => cluster.misplaced(active),
      );
    }

    await cluster.stopAll();
    expect(cluster.conflicts()).toEqual([]);
    const rows = await cluster.journal();
    const acked = cluster.acks().map((a) => String(a.line['saleId']));
    expect(missingSales(rows, acked)).toEqual([]);
    expect(journalProblems(rows)).toEqual([]);
    // Each round's kill and restart made new incarnations: the check above had something to check.
    const incarnations = new Set(rows.map((r) => String(r.event['inc'])));
    expect(incarnations.size).toBeGreaterThan(KILLS);
  }, 600_000);
});
