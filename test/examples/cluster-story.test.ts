// Festival night's log in plain words (milestone 4, T10): the story narrate.ts tells from
// `docker compose logs`, and scripts/cluster-smoke.ts checks.
import { describe, expect, it } from 'vitest';
import { parseComposeLine } from '../../examples/cluster/compose.ts';
import { nodeName, Story, SUMMARY_EVERY_MS } from '../../examples/cluster/story.ts';

const ack = (show: string, sale: number, node: string, n = 1) =>
  JSON.stringify({
    ev: 'ack',
    show,
    saleId: `${show}-${String(sale)}`,
    inc: `${node}:2552#7:${String(n)}`,
    ms: 3,
  });
const timeout = (show: string) => JSON.stringify({ ev: 'timeout', show });
const member = (type: string, node: string, uid: number, extra: object = {}) =>
  JSON.stringify({ type, address: `${node}:2552`, uid, ev: type, ...extra });

/** Reads lines in order, each `[service, line, at]`, and returns every sentence. */
function tell(story: Story, lines: readonly (readonly [string, string, number])[]): string[] {
  return lines.flatMap(([service, text, at]) => story.read(service, text, at));
}

describe('the compose log', () => {
  it('gives the service, the time and the text', () => {
    expect(parseComposeLine('node-1-1  | 2026-11-24T16:19:59.444169553Z {"ev":"up"}')).toEqual({
      service: 'node-1',
      at: Date.parse('2026-11-24T16:19:59.444Z'),
      text: '{"ev":"up"}',
    });
    expect(parseComposeLine('crowd-1     | 2026-11-24T16:20:00.000Z hello')).toMatchObject({
      service: 'crowd',
      text: 'hello',
    });
  });

  it("skips compose's own lines", () => {
    expect(parseComposeLine(' Container troupe-festival-night-node-2-1 Killed')).toBeUndefined();
    expect(parseComposeLine('node-1-1  | not a time {"ev":"up"}')).toBeUndefined();
  });

  it('names a node by its host', () => {
    expect(nodeName('node-2:2552')).toBe('node-2');
    expect(nodeName('node-2:2552#3211561981:4')).toBe('node-2');
    expect(nodeName('127.0.0.1:2552#1:1')).toBe('127.0.0.1');
  });
});

describe('the story', () => {
  it('says who is up, with their Backstage', () => {
    const story = new Story();
    expect(
      tell(story, [
        ['node-1', '{"ev":"backstage","url":"http://127.0.0.1:7071/"}', 0],
        ['node-1', '{"ev":"up","node":"node-1:2552#1","host":true}', 500],
        ['crowd', '{"ev":"up","node":"crowd:2552#2","host":false}', 1500],
        ['postgres', 'LOG:  database system is ready', 1600],
      ]),
    ).toEqual([
      '   0.5s  node-1 is up, and can host shows. Backstage: http://127.0.0.1:7071/',
      '   1.5s  The crowd is in the cluster, and starts buying seats.',
    ]);
  });

  it('tells a failover: the silence, the node going quiet, and the show back with its sales', () => {
    const story = new Story();
    const sentences = tell(story, [
      ['crowd', ack('hamlet', 1, 'node-2'), 0],
      ['crowd', ack('hamlet', 2, 'node-2'), 1000],
      ['crowd', ack('macbeth', 1, 'node-1'), 1000],
      ['crowd', timeout('hamlet'), 3000],
      ['crowd', timeout('hamlet'), 5000],
      ['node-1', member('reachability', 'node-2', 9, { reachable: false }), 3200],
      ['crowd', member('reachability', 'node-2', 9, { reachable: false }), 3300],
      ['node-1', member('memberDown', 'node-2', 9), 8000],
      ['crowd', member('memberDown', 'node-2', 9), 8100],
      ['crowd', ack('hamlet', 4, 'node-3'), 11_500],
    ]);
    expect(sentences).toEqual([
      "   3.0s  hamlet didn't answer in time. The crowd keeps asking.",
      "   3.2s  node-2 stopped answering heartbeats. Its shows can't be reached.",
      '   8.0s  node-2 has been silent too long, and is marked down.',
      '  10.0s  3 sales in the last 10.0 s.',
      '  10.0s    node-1 has macbeth.',
      '  10.0s    Not answering: hamlet.',
      '  11.5s  hamlet answers again, now from node-3, 10.5 s after its last sale on node-2. It picked up at sale 4, so its 2 confirmed sales survived.',
    ]);
    expect(story.moves).toEqual([
      { show: 'hamlet', from: 'node-2', to: 'node-3', gapMs: 10_500, failover: true, at: 11_500 },
    ]);
    expect(story.shows.get('hamlet')).toMatchObject({ node: 'node-3', lastSale: 4, silent: false });
    expect(story.problems).toEqual([]);
  });

  it('tells a handoff, which has no silence', () => {
    const story = new Story();
    expect(
      tell(story, [
        ['crowd', ack('hamlet', 1, 'node-1'), 0],
        ['crowd', ack('hamlet', 2, 'node-2'), 300],
      ]),
    ).toEqual([
      '   0.3s  hamlet moved from node-1 to node-2 in 0.3 s. It picked up at sale 2, so its 1 confirmed sale survived.',
    ]);
    expect(story.moves[0]?.failover).toBe(false);
  });

  it('catches a show that answers without a sale it had confirmed', () => {
    const story = new Story();
    tell(story, [
      ['crowd', ack('hamlet', 5, 'node-1'), 0],
      ['crowd', timeout('hamlet'), 2000],
    ]);
    expect(story.read('crowd', ack('hamlet', 3, 'node-2'), 9000)[0]).toContain(
      'hamlet answered from node-2 with sale 3, but sale 5 had been acknowledged: sales were lost.',
    );
    expect(story.problems).toHaveLength(1);
  });

  it('says a show answers again from the same node after a slow spell', () => {
    const story = new Story();
    tell(story, [
      ['crowd', ack('hamlet', 1, 'node-1'), 0],
      ['crowd', timeout('hamlet'), 2000],
    ]);
    expect(story.read('crowd', ack('hamlet', 2, 'node-1'), 2500)).toEqual([
      '   2.5s  hamlet answers again, from node-1, 2.5 s after its last sale.',
    ]);
    expect(story.moves).toEqual([]);
  });

  it('tells a graceful leave and a restart, once each, however many nodes report them', () => {
    const story = new Story();
    expect(
      tell(story, [
        ['node-1', member('memberUp', 'node-2', 1), 0],
        ['node-3', member('memberUp', 'node-2', 1), 0],
        ['node-3', '{"ev":"leaving","node":"node-3:2552#5"}', 1000],
        ['node-3', '{"ev":"left","node":"node-3:2552#5"}', 1100],
        ['node-1', member('reachability', 'node-2', 1, { reachable: false }), 2000],
        ['node-1', member('reachability', 'node-2', 1, { reachable: true }), 2500],
        ['node-1', member('reachability', 'node-2', 1, { reachable: true }), 2600],
        ['node-1', member('memberUp', 'node-2', 2), 3000],
        ['crowd', member('memberUp', 'node-2', 2), 3000],
        ['node-2', '{"ev":"downed","node":"node-2:2552#2"}', 4000],
      ]),
    ).toEqual([
      '   1.0s  node-3 is leaving gracefully, handing its shows off first.',
      '   1.1s  node-3 has handed off its shows, and stopped.',
      "   2.0s  node-2 stopped answering heartbeats. Its shows can't be reached.",
      '   2.5s  node-2 is answering heartbeats again.',
      '   3.0s  node-2 is back, as a new incarnation. Shows will move to it, a few at a time.',
      '   4.0s  node-2 learned it was marked down, and restarts as a new node.',
    ]);
  });

  it('sums up every ten seconds, only when something sold', () => {
    const story = new Story();
    tell(story, [
      ['crowd', ack('hamlet', 1, 'node-1'), 0],
      ['crowd', ack('macbeth', 1, 'node-2'), 100],
      ['crowd', ack('othello', 1, 'node-1'), 200],
    ]);
    expect(story.read('crowd', '{"ev":"log","level":"warn","msg":"x"}', SUMMARY_EVERY_MS)).toEqual([
      '  10.0s  3 sales in the last 10.0 s.',
      '  10.0s    node-1 has hamlet, othello.',
      '  10.0s    node-2 has macbeth.',
    ]);
    // The same placement isn't said again.
    story.read('crowd', ack('hamlet', 2, 'node-1'), SUMMARY_EVERY_MS + 100);
    expect(
      story.read('crowd', '{"ev":"log","level":"warn","msg":"x"}', 2 * SUMMARY_EVERY_MS),
    ).toEqual(['  20.0s  1 sale in the last 10.0 s.']);
    // Nothing sold in the next ten seconds, so no summary.
    expect(
      story.read('crowd', '{"ev":"log","level":"warn","msg":"x"}', 3 * SUMMARY_EVERY_MS),
    ).toEqual([]);
  });

  it('passes on errors and failures, and ignores warnings', () => {
    const story = new Story();
    expect(
      tell(story, [
        ['node-1', '{"ev":"log","level":"error","msg":"postgres pool error"}', 0],
        ['node-1', '{"ev":"log","level":"warn","msg":"downed"}', 0],
        ['node-1', '{"ev":"failed","path":"/system/sharding/show/3/hamlet"}', 0],
        ['crowd', '{"ev":"error","show":"hamlet","message":"boom"}', 0],
        ['crowd', '{"ev":"refused","show":"hamlet","reason":"sold out"}', 0],
        ['crowd', '[1, 2]', 0],
      ]),
    ).toEqual([
      '   0.0s  node-1 logged an error: postgres pool error',
      '   0.0s  /system/sharding/show/3/hamlet failed on node-1.',
      '   0.0s  An ask to hamlet failed: boom.',
      '   0.0s  hamlet refused a sale: sold out.',
    ]);
  });
});
