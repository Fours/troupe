// Keep the majority (decision 0042): when a node would down members it can't reach, it first
// counts its side. A pure function of one node's view, so every node on a side, seeing the same
// reachability, decides the same way, and the sides of a clean partition decide opposite ways.

/** A member as the downing decision sees it: up or leaving, and whether this node hears it. */
export interface Side {
  readonly address: string;
  readonly reachable: boolean;
}

/**
 * What a node does about the members it can't reach, from its own view of the members that are
 * up or leaving, itself included and reachable. `others` downs the unreachable ones; `self`
 * downs this node, which then leaves and comes back only as a new incarnation.
 *
 * The side this node can reach keeps the cluster if it's more than half the members. At exactly
 * half, the side holding `first`, the first of the seeds that's a member, keeps it, or the side
 * with the lowest address if no seed is, so two halves never both stay or both go. Seeds, not
 * addresses: every node has the same list, and a client such as `crowd` sorts before `node-1`.
 * But a side of one never keeps it, unless `alone` says this node may form a cluster on its own,
 * as the only seed: a node by itself can't tell a dead peer from a partition, and a view of two
 * can be a join that hadn't spread yet. One that goes rejoins through its seeds, where a lone
 * survivor would down the rest for good, since neither side listens to a member it has downed.
 */
export function decideDowning(
  members: readonly Side[],
  alone = false,
  first?: string,
): 'others' | 'self' {
  let reachable = 0;
  let lowest: Side | undefined;
  for (const m of members) {
    if (m.reachable) reachable += 1;
    if (lowest === undefined || m.address < lowest.address) lowest = m;
  }
  if (reachable === 1 && members.length > 1 && !alone) return 'self';
  const twice = reachable * 2;
  if (twice > members.length) return 'others';
  if (twice < members.length) return 'self';
  const decider = members.find((m) => m.address === first) ?? lowest;
  return decider?.reachable === true ? 'others' : 'self';
}
