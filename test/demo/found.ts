import type { FaultPlan, NetworkMode } from '@kylewillett/troupe/rehearsal';

/** One bug the hunt found (milestone 5, T7): the run that showed it, shrunk. */
export interface Found {
  /** A short name, as the write-up's list of bugs found has it. */
  readonly name: string;
  /** What went wrong, in a sentence. */
  readonly what: string;
  /** The fix. */
  readonly fix: string;
  /** The decision record the fix changed, if it changed one. */
  readonly record?: string;
  readonly mode: NetworkMode;
  /** The fault mix whose seed found it. */
  readonly mix: 'all' | 'nodes' | 'network' | 'clocks' | 'heavy';
  readonly seed: number;
  /** The invariant it broke. */
  readonly invariant: string;
  /** Its shrunk plan, which must run clean now. */
  readonly plan: FaultPlan;
}

/**
 * Every bug T7's hunt found in the real code, in the order it found them, each with the shrunk
 * plan of the run that showed it (docs/decisions/data/0043-hunt-2026-11-25.json has the runs).
 * Each plan broke its invariant before its fix and must run clean on festival night now.
 */
export const FOUND: readonly Found[] = [
  {
    name: 'split brain',
    what: 'When a partition cut both ways, each side downed the other, and the halves never merged',
    fix: 'Keep the majority: only a side with more than half the members downs the rest, and a smaller side downs itself and rejoins',
    record: '0042',
    mode: 'contract',
    mix: 'all',
    seed: 18,
    invariant: 'recovers',
    plan: [{ at: 32_668, partition: [['crowd'], ['node-1', 'node-2', 'node-3']], ms: 7_331 }],
  },
  {
    name: 'a lone first seed',
    what: 'A node that downed itself restarted while the partition held and, as the first seed, formed a cluster of its own that nothing ever merged',
    fix: 'A member keeps greeting the seeds it has no live member at, so two clusters formed apart merge once they can reach each other',
    record: '0042',
    mode: 'contract',
    mix: 'all',
    seed: 80,
    invariant: 'recovers',
    plan: [{ at: 32_237, partition: [['node-1'], ['node-2', 'node-3', 'crowd']], ms: 7_762 }],
  },
  {
    name: 'a lost hello',
    what: 'A dial across a partition had its open held and its hello lost, so the connection opened with no hello and remoting waited on it for good',
    fix: 'A connection without a hello after 5 s is closed, and dialed again',
    mode: 'chaos',
    mix: 'all',
    seed: 73,
    invariant: 'recovers',
    plan: [{ at: 33_211, partition: [['node-2', 'node-3', 'crowd'], ['node-1']], ms: 6_788 }],
  },
  {
    name: 'a lease renewed for good',
    what: 'The store renews every lease it has as a holder’s, so a lease whose release failed was renewed for good, and no other node could take its shard',
    fix: 'A lease the store renews that the holder doesn’t hold is given back',
    mode: 'contract',
    mix: 'all',
    seed: 1_529,
    invariant: 'recovers',
    plan: [{ at: 5_674, disk: 'error', node: 'node-1', rate: 0.28, ms: 401 }],
  },
  {
    name: 'a leave cut short',
    what: 'A leaving node stopped heartbeating, so a handoff longer than downing took got it downed halfway',
    fix: 'A leaving node heartbeats and gossips until it has left',
    mode: 'contract',
    mix: 'all',
    seed: 1_914,
    invariant: 'recovers',
    plan: [
      { at: 22_002, disk: 'hang', ms: 6_571 },
      { at: 28_582, leave: 'node-2', rejoinAfterMs: 1 },
    ],
  },
  {
    name: 'a leave that never ends',
    what: 'A shard that lost its lease in a database hang was still stopping when its node began to leave, and its stop never told the region it was done, so the node stayed leaving for good',
    fix: 'A leaving region checks whether it’s done whenever a shard stops, and waits for its acquires to be answered, handing on a shard granted after the leave began',
    mode: 'contract',
    mix: 'all',
    seed: 1_914,
    invariant: 'recovers',
    plan: [
      { at: 22_002, disk: 'hang', ms: 6_571 },
      { at: 28_576, leave: 'node-2', rejoinAfterMs: 1 },
    ],
  },
  {
    name: 'a message overtaken',
    what: 'A lookup for one shard named another’s holder while messages for that one still waited, so the next message went straight there and overtook them',
    fix: 'A region never routes a message past messages already waiting for its shard',
    mode: 'contract',
    mix: 'all',
    seed: 138,
    invariant: 'orderPerPair',
    plan: [{ at: 4_074, pause: 'node-1', ms: 2_681 }],
  },
  {
    name: 'an address never dialed',
    what: 'A node learned of an incarnation it had never connected to only as down, marked its address down, and never dialed it again, while the new incarnation there waited to be dialed',
    fix: 'Membership’s frames dial an address even while an old incarnation there is down; the hello says which uid answers',
    record: '0042',
    mode: 'contract',
    mix: 'all',
    seed: 1_970,
    invariant: 'recovers',
    plan: [
      { at: 27_176, join: 'node-4' },
      { at: 32_962, partition: [['crowd'], ['node-1', 'node-2', 'node-3', 'node-4']], ms: 6_969 },
      { at: 39_998, leave: 'node-4', rejoinAfterMs: 1 },
    ],
  },
  {
    name: 'a newcomer counted twice',
    what: 'A member let a newcomer in during a partition, so its side counted one more member than the far side knew of, and both sides thought they were the larger',
    fix: 'A node that can’t reach every member lets no one new in, and greets no missing seed, until it can',
    record: '0042',
    mode: 'chaos',
    mix: 'all',
    seed: 9_264,
    invariant: 'recovers',
    plan: [
      { at: 30_607, leave: 'node-1', rejoinAfterMs: 4_957 },
      {
        at: 35_494,
        partition: [
          ['node-2', 'node-3'],
          ['node-1', 'crowd'],
        ],
        ms: 4_426,
      },
    ],
  },
  {
    name: 'a lease given back twice',
    what: 'The first fix for a lease renewed for good raced the region: it learned the token and sent its release, the region’s own acquire got the same token back first, and the release freed a lease the region held, so another node ran the shard alongside it',
    fix: 'An acquire waits for a give-back of the same lease to finish',
    mode: 'contract',
    mix: 'all',
    seed: 9_886,
    invariant: 'oneLiveInstance',
    plan: [
      { at: 16_656, disk: 'hang', ms: 7_694 },
      { at: 25_142, disk: 'hang', ms: 5_060 },
      { at: 30_207, pause: 'node-1', ms: 5_887 },
      { at: 36_224, pause: 'node-2', ms: 3_776 },
    ],
  },
  {
    name: 'a side of one',
    what: 'The crowd knew only node-1 when a partition cut it off, won the tie on its address, and downed node-1 for good',
    fix: 'A side of one never keeps the cluster, unless that node is the only seed',
    record: '0042',
    mode: 'chaos',
    mix: 'network',
    seed: 710,
    invariant: 'recovers',
    plan: [{ at: 1_500, partition: [['node-1', 'node-2', 'node-3'], ['crowd']], ms: 5_671 }],
  },
  {
    name: 'two sides that downed each other',
    what: 'A partition came while a join was still spreading, so the two sides counted different members, each thought it the larger, and each downed the other',
    fix: 'Two nodes that downed each other settle it at their hello: the smaller side gives way and rejoins',
    record: '0042',
    mode: 'chaos',
    mix: 'network',
    seed: 7_270,
    invariant: 'recovers',
    plan: [
      {
        at: 1_500,
        partition: [
          ['node-2', 'node-3'],
          ['node-1', 'crowd'],
        ],
        ms: 4_299,
      },
    ],
  },
  {
    name: 'a join never finished',
    what: 'A node was let in, but a one-way partition lost its welcome, and it was downed before it heard; still joining, it ignored being told so, and tried to join as a downed uid for good',
    fix: 'A joining node told its uid is down gives up, and comes back as a new one',
    record: '0042',
    mode: 'chaos',
    mix: 'network',
    seed: 9_347,
    invariant: 'recovers',
    plan: [
      {
        at: 1_001,
        partition: [['node-1', 'node-2', 'crowd'], ['node-3']],
        oneWay: true,
        ms: 6_735,
      },
    ],
  },
  {
    name: 'a bounced message overtaken',
    what: 'A message sent to a stale holder came back to a region already holding a later message for the shard, rejoined the queue behind it, and was delivered second',
    fix: 'A message that comes back goes in ahead of everything that never left the queue, after anything that came back before it',
    mode: 'contract',
    mix: 'all',
    seed: 27_843,
    invariant: 'orderPerPair',
    plan: [
      { at: 15_534, kill: 'node-2', restartAfterMs: 7_219 },
      { at: 21_201, disk: 'hang', node: 'node-1', ms: 5_237 },
      { at: 25_550, disk: 'lostReplies', node: 'node-1', rate: 0.39, ms: 5_450 },
    ],
  },
  {
    name: 'a reply dropped at a down address',
    what: 'A node that restarted learned the crowd’s old incarnation only as removed, marked the crowd’s address down, and dropped its replies to the crowd’s new incarnation as unreachable',
    fix: 'A message for another incarnation than the one downed at its address waits for a connection, and dials, instead of being dropped',
    record: '0042',
    mode: 'contract',
    mix: 'all',
    seed: 70_628,
    invariant: 'failoverWithin',
    plan: [
      { at: 5_668, kill: 'node-3', restartAfterMs: 7_253 },
      { at: 17_609, partition: [['crowd'], ['node-1', 'node-2', 'node-3']], ms: 6_517 },
      { at: 31_178, kill: 'node-2', restartAfterMs: 5_647 },
    ],
  },
  {
    name: 'two clusters that never met',
    what: 'node-1 gave way to a cluster that had downed it and rejoined node-2, which had downed the other cluster too, but that cluster had never heard of either new incarnation, so neither side counted the other and they never merged',
    fix: 'Two nodes are in different clusters whenever one has the other down and the other doesn’t count it a member, and the smaller side gives way; ties go to the side with the earlier seed',
    record: '0042',
    mode: 'chaos',
    mix: 'all',
    seed: 162_500,
    invariant: 'recovers',
    plan: [
      { at: 2_364, partition: [['node-2'], ['node-1', 'node-3', 'crowd']], ms: 5_009 },
      {
        at: 8_001,
        partition: [
          ['node-3', 'crowd'],
          ['node-1', 'node-2'],
        ],
        ms: 6_253,
      },
      { at: 19_568, delay: 'node-3', latencyMs: [66, 92], ms: 3_497 },
    ],
  },
  {
    name: 'a lease given back too soon',
    what: 'A lease lost at its deadline while its show was still persisting a sale on a slow disk was given back at once; another node took the show and recovered before the sale landed, and answered a read from before it',
    fix: 'A lease is given back only a TTL after its holder let it go, as the store would have kept it had its renewals stopped',
    mode: 'contract',
    mix: 'nodes',
    seed: 37_436,
    invariant: 'noStaleReads',
    plan: [
      { at: 999, pause: 'node-3', ms: 1_931 },
      { at: 7_824, disk: 'slow', latencyMs: [147, 930], ms: 3_092 },
      { at: 11_430, leave: 'node-2', rejoinAfterMs: 1 },
    ],
  },
  {
    name: 'a release that landed late',
    what: 'A node handed a shard off on a slow disk and, alone in a partition, took it straight back; its acquire landed before its release and kept the token, then the release freed the lease it had just taken, and another node ran the show alongside it',
    fix: 'An acquire waits for a release of the same lease still on its way',
    mode: 'contract',
    mix: 'heavy',
    seed: 48_788,
    invariant: 'oneLiveInstance',
    plan: [
      { at: 6_285, partition: [['node-2'], ['node-1', 'node-3', 'crowd']], ms: 4_903 },
      { at: 6_940, disk: 'slow', latencyMs: [390, 1_615], ms: 717 },
    ],
  },
  {
    name: 'a leaving node that never stopped asking',
    what: 'A leaving node stopped checking who it could hear, so it went on asking a node that had downed itself to take its last shard, never finished leaving, and as the first seed let no one back in',
    fix: 'A leaving node still marks members unreachable, though it downs no one',
    record: '0042',
    mode: 'contract',
    mix: 'heavy',
    seed: 48_977,
    invariant: 'recovers',
    plan: [
      { at: 27_987, disk: 'lostReplies', rate: 0.43, ms: 727 },
      { at: 33_131, leave: 'node-1', rejoinAfterMs: 1 },
      {
        at: 33_281,
        partition: [
          ['node-1', 'node-2'],
          ['node-3', 'crowd'],
        ],
        ms: 6_719,
      },
      { at: 37_504, leave: 'node-2', rejoinAfterMs: 1 },
    ],
  },
  {
    name: 'a show forgotten after an error',
    what: 'A write recording a show as remembered failed on a database error and was only logged, so when its node was killed, its shard started elsewhere without it, and the one ask for it had gone to the dead node',
    fix: 'A remember that fails is tried again, with backoff, while its entity runs',
    mode: 'chaos',
    mix: 'all',
    seed: 120_717,
    invariant: 'failoverWithin',
    plan: [
      { at: 5_621, disk: 'error', rate: 0.61, ms: 842 },
      { at: 24_426, kill: 'node-2', restartAfterMs: 388 },
    ],
  },
];
