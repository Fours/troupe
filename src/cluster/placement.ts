// Where entities and shards go (decision 0030). An entity id hashes to a shard, and a shard's
// desired owner is the candidate with the highest rendezvous score for it. Pure functions of their
// arguments, so every node computes the same answer from the same members, with no coordinator
// and no table to keep. Placement only says where a shard should be: the lease says where it is.
import { fnv1a, mix32 } from '../hash.js';

/** The shard an entity id belongs to: its 32-bit FNV-1a hash, modulo the type's shard count. */
export function shardOf(id: string, shardCount: number): number {
  return fnv1a(id) % shardCount;
}

/** How much `address` wants `shard`. Mixed, so similar addresses and shard names spread evenly. */
export function score(shard: string, address: string): number {
  return mix32(fnv1a(`${shard}@${address}`));
}

/**
 * The candidate with the highest score for `shard`, the lower address on a tie, or `undefined`
 * when there are none. Adding a candidate moves to it only the shards it now tops, about one in
 * N, and removing one moves only its own.
 */
export function desiredOwner(shard: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const address of candidates) {
    const s = score(shard, address);
    if (s > bestScore || (s === bestScore && best !== undefined && address < best)) {
      best = address;
      bestScore = s;
    }
  }
  return best;
}
