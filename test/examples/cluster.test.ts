// The festival-night example's pieces that don't need processes: the show entity, how a process
// reads its environment, and the journal checks the multi-process tests end with (milestone 4, T8).
import { afterEach, describe, expect, it } from 'vitest';
import { crowdEnv, nodeEnv } from '../../examples/cluster/env.ts';
import { showEntity, SHOWS, type BuyReply } from '../../examples/cluster/show.ts';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import { journalProblems, missingSales, type JournalRow } from '../multiprocess/journal.js';

const kits: TestKit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((k) => k.shutdown()));
});

describe('a show', () => {
  it('sells only once the sale is written, and stamps each event with its incarnation', async () => {
    const kit = createTestKit();
    kits.push(kit);
    const persistence = inMemoryPersistence({ clock: () => 0 });
    const entity = showEntity(persistence, '127.0.0.1:2552#7');
    const probe = kit.probe<BuyReply>();

    const first = kit.system.spawn(entity('hamlet'), 'first');
    first.tell({ type: 'buy', customer: 'ada', seats: 2, replyTo: probe.ref });
    await kit.settle();
    expect(probe.expectMessage()).toEqual({
      ok: true,
      saleId: 'hamlet-1',
      inc: '127.0.0.1:2552#7:1',
    });
    first.tell({ type: 'buy', customer: 'ada', seats: 0, replyTo: probe.ref });
    await kit.settle();
    expect(probe.expectMessage()).toMatchObject({ ok: false, inc: '127.0.0.1:2552#7:1' });
    kit.system.stop(first);
    await kit.settle();

    // The next incarnation recovers the first's sale, and numbers its own after it.
    const second = kit.system.spawn(entity('hamlet'), 'second');
    second.tell({ type: 'buy', customer: 'bo', seats: 1, replyTo: probe.ref });
    await kit.settle();
    expect(probe.expectMessage()).toEqual({
      ok: true,
      saleId: 'hamlet-2',
      inc: '127.0.0.1:2552#7:2',
    });
    const events = await persistence.journal.read('show-hamlet', 1, 10);
    expect(events.map((e) => e.event)).toEqual([
      { type: 'sold', saleId: 'hamlet-1', customer: 'ada', seats: 2, inc: '127.0.0.1:2552#7:1' },
      { type: 'sold', saleId: 'hamlet-2', customer: 'bo', seats: 1, inc: '127.0.0.1:2552#7:2' },
    ]);
  });

  it('has twelve shows, each an actor name', () => {
    expect(SHOWS).toHaveLength(12);
    for (const show of SHOWS) expect(show).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe('the environment', () => {
  it('needs only the secret, and fills in the rest', () => {
    expect(() => nodeEnv({})).toThrow('CLUSTER_SECRET must be set');
    expect(nodeEnv({ CLUSTER_SECRET: 's' })).toEqual({
      secret: 's',
      clusterName: 'festival-night',
      port: 2552,
      host: '127.0.0.1',
      advertise: '127.0.0.1:2552',
      seeds: ['127.0.0.1:2552'],
      postgresUrl: 'postgres://troupe:troupe@localhost:5440/troupe',
      schema: 'troupe',
      shardCount: 32,
      clusterTimings: {},
      shardingTimings: {},
    });
  });

  it('splits TIMINGS between joinCluster and sharding.init, and refuses what it can’t use', () => {
    const env = nodeEnv({
      CLUSTER_SECRET: 's',
      NODE_PORT: '2600',
      SEEDS: ' 10.0.0.1:2552, 10.0.0.2:2552 ,',
      TIMINGS: JSON.stringify({ heartbeatMs: 200, leases: { ttlMs: 2_000 }, rebalanceMs: 500 }),
    });
    expect(env.advertise).toBe('127.0.0.1:2600');
    expect(env.seeds).toEqual(['10.0.0.1:2552', '10.0.0.2:2552']);
    expect(env.clusterTimings).toEqual({ heartbeatMs: 200, leases: { ttlMs: 2_000 } });
    expect(env.shardingTimings).toEqual({ rebalanceMs: 500 });
    expect(() => nodeEnv({ CLUSTER_SECRET: 's', TIMINGS: '{"tick":1}' })).toThrow(
      'unknown key: tick',
    );
    expect(() => nodeEnv({ CLUSTER_SECRET: 's', TIMINGS: '[]' })).toThrow('JSON object');
    expect(() => nodeEnv({ CLUSTER_SECRET: 's', NODE_PORT: 'x' })).toThrow('NODE_PORT');
  });

  it('gives the crowd its shows and pace', () => {
    const env = crowdEnv({ CLUSTER_SECRET: 's', CROWD_SHOWS: '3', CUSTOMERS_PER_SHOW: '0' });
    expect(env.shows).toEqual(['hamlet', 'macbeth', 'othello']);
    expect(env.customersPerShow).toBe(1);
    expect(env.askTimeoutMs).toBe(2_000);
    expect(env.pauseMs).toBe(100);
    expect(() => crowdEnv({ CLUSTER_SECRET: 's', CROWD_SHOWS: '13' })).toThrow('CROWD_SHOWS');
  });
});

describe('the journal checks', () => {
  const row = (id: string, seq: number, inc: string, saleId = `${id.slice(5)}-${String(seq)}`) =>
    ({ id, seq, event: { saleId, inc } }) satisfies JournalRow;

  it('pass a stream whose incarnations each wrote one unbroken run', () => {
    const rows = [
      row('show-hamlet', 3, 'b:1'),
      row('show-hamlet', 1, 'a:1'),
      row('show-hamlet', 2, 'a:1'),
      row('show-macbeth', 1, 'a:2'),
    ];
    expect(journalProblems(rows)).toEqual([]);
    expect(missingSales(rows, ['hamlet-1', 'macbeth-1'])).toEqual([]);
  });

  it('find an incarnation that wrote after a later one, a gap, and a sale out of place', () => {
    expect(
      journalProblems([
        row('show-hamlet', 1, 'a:1'),
        row('show-hamlet', 2, 'b:1'),
        row('show-hamlet', 3, 'a:1'),
      ]),
    ).toEqual(['show-hamlet: a:1 wrote seq 3 after a later incarnation had written']);
    expect(journalProblems([row('show-hamlet', 2, 'a:1')])).toEqual([
      'show-hamlet: seq 2 at position 1',
    ]);
    expect(journalProblems([row('show-hamlet', 1, 'a:1', 'hamlet-9')])).toEqual([
      'show-hamlet: seq 1 is sale hamlet-9',
    ]);
    expect(missingSales([row('show-hamlet', 1, 'a:1')], ['hamlet-1', 'hamlet-2'])).toEqual([
      'hamlet-2',
    ]);
  });
});
