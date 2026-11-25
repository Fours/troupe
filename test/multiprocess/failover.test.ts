// Festival night on real processes with the default timings: a kill -9 fails over within 15 s,
// a restart moves the node's shards back, and a graceful leave loses no ask (milestone 4, T8).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desiredOwner } from '../../src/cluster/placement.js';
import { SHOWS } from '../../examples/cluster/show.ts';
import { journalProblems, missingSales } from './journal.js';
import { addressOf, shardOfShow, TestCluster, TYPE, type Proc } from './harness.js';

/** The longest a show may go unanswered after its node is killed, with the defaults. */
const FAILOVER_LIMIT_MS = 15_000;

describe('three nodes and a crowd, with the default timings', () => {
  let cluster: TestCluster;
  const active = new Set(SHOWS.map(shardOfShow));

  beforeAll(async () => {
    cluster = await TestCluster.start();
  }, 60_000);

  afterAll(async () => {
    await cluster.close();
  });

  /** The shows whose shards `node` holds now. */
  const showsOn = (node: Proc): string[] => {
    const holders = cluster.holders();
    return SHOWS.filter((show) => holders.get(shardOfShow(show)) === node.key);
  };

  /** Whether every show has an ack since `since`, from a node other than `not`. */
  const answeredSince = (since: number, not?: string): boolean =>
    SHOWS.every((show) =>
      cluster
        .acks(since)
        .some((a) => a.line['show'] === show && addressOf(String(a.line['inc'])) !== not),
    );

  it('fails over, moves shards back, leaves gracefully, and keeps every sale', async () => {
    await cluster.until(
      'every show answered from its desired owner',
      () => answeredSince(0) && cluster.placed(active),
      60_000,
      () => cluster.misplaced(active),
    );

    // Kill the node with the most shows, with no warning.
    const victim = [...cluster.nodes].sort((a, b) => showsOn(b).length - showsOn(a).length)[0];
    if (victim === undefined) throw new Error('no nodes');
    const victimShows = showsOn(victim);
    expect(victimShows.length).toBeGreaterThan(0);
    const before = cluster.holders();
    const victimShards = [...active].filter((shard) => before.get(shard) === victim.key);
    const killed = cluster.seen.length;
    const killedAt = performance.now();
    await victim.kill();

    const back = new Map<string, number>();
    await cluster.until(
      "the victim's shows answered from other nodes",
      () => {
        for (const ack of cluster.acks(killed)) {
          const show = String(ack.line['show']);
          if (back.has(show) || !victimShows.includes(show)) continue;
          if (addressOf(String(ack.line['inc'])) !== victim.address)
            back.set(show, ack.at - killedAt);
        }
        return back.size === victimShows.length;
      },
      FAILOVER_LIMIT_MS + 15_000,
    );
    console.info(
      `failover after kill -9, ms: ${[...back].map(([s, ms]) => `${s} ${String(Math.round(ms))}`).join(', ')}`,
    );
    for (const ms of back.values()) expect(ms).toBeLessThanOrEqual(FAILOVER_LIMIT_MS);

    // Restart it at the same address: a new incarnation, which takes back the shards it tops.
    const restarted = cluster.seen.length;
    await cluster.restart(victim);
    await cluster.until(
      'every shard on its desired owner again',
      () => cluster.placed(active),
      60_000,
      () => cluster.misplaced(active),
    );
    const addresses = cluster.nodes.map((n) => n.address);
    const expected = [...active].filter(
      (shard) => desiredOwner(`${TYPE}/${String(shard)}`, addresses) === victim.address,
    );
    const holders = cluster.holders();
    const moved = [...active].filter((shard) => holders.get(shard) === victim.key);
    expect(moved.sort()).toEqual(expected.sort());
    // Back at the same address, it tops the same shards, so it takes back exactly what it had.
    // Not a count near a third: ports are random, and with 9 shards in use the busiest of three
    // nodes, the one killed, holds more than half of them in about 1 run in 8.
    expect(moved).toEqual(victimShards.sort());
    // Each by handoff from the node that had it.
    const handedOff = cluster.seen
      .slice(restarted)
      .filter((s) => s.line.ev === 'shardReleased' && s.line['reason'] === 'handoff')
      .map((s) => s.line['shard']);
    for (const shard of moved) expect(handedOff).toContain(shard);

    // Stop another node gracefully: its shards are handed off, and no ask times out.
    const leaver = cluster.nodes
      .filter((n) => n !== victim)
      .sort((a, b) => showsOn(b).length - showsOn(a).length)[0];
    if (leaver === undefined) throw new Error('no nodes');
    const leaverShows = showsOn(leaver);
    expect(leaverShows.length).toBeGreaterThan(0);
    const stopped = cluster.seen.length;
    expect(await leaver.stop()).toBe(0);
    await cluster.until(
      'every show answered after the leave, from the nodes left',
      () => cluster.placed(active) && answeredSince(stopped, leaver.address),
      30_000,
      () => cluster.misplaced(active),
    );
    // Asks sent before the leave and answered after it count too: none may have timed out.
    const lost = cluster.seen
      .slice(stopped)
      .filter((s) => s.from === 'crowd' && (s.line.ev === 'timeout' || s.line.ev === 'error'));
    expect(lost).toEqual([]);
    const released = cluster.seen
      .slice(stopped)
      .filter((s) => s.from === leaver.name && s.line.ev === 'shardReleased');
    expect(released.map((s) => s.line['reason'])).toEqual(released.map(() => 'leaving'));

    // Every acknowledged sale is in the journal, and no two incarnations of a show overlapped.
    await cluster.stopAll();
    const rows = await cluster.journal();
    const acked = cluster.acks().map((a) => String(a.line['saleId']));
    expect(acked.length).toBeGreaterThan(100);
    expect(missingSales(rows, acked)).toEqual([]);
    expect(journalProblems(rows)).toEqual([]);
    expect(cluster.conflicts()).toEqual([]);
  }, 240_000);
});
