// The one string hash in the package: 32-bit FNV-1a, over UTF-16 code units. Postgres's lock keys
// use it (decision 0016), and so does sharding, to place entity ids in shards (decision 0030).
// Computed here rather than by any runtime or database, so every process agrees on it.

/** A 32-bit FNV-1a hash of `text`, as an unsigned integer. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * MurmurHash3's finalizer: every input bit affects every output bit. FNV-1a alone changes little
 * in its high bits when only a string's end differs, so rendezvous scores mix it with this.
 */
export function mix32(hash: number): number {
  let h = hash >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
