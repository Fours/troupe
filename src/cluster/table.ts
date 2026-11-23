// The member table as a plain value (decision 0028). One entry per incarnation of a node, keyed by
// its address and uid, since uids are random and can't say which incarnation came later. A status
// only moves forward, so merging two tables keeps each entry's furthest status: commutative,
// associative and idempotent, and gossip converges in any order with no coordinator.

/**
 * Where an incarnation is in its life, in the order it moves through them. `removed` is a
 * tombstone: hidden from `members()`, but kept so stale gossip can't bring the entry back.
 */
export type Status = 'up' | 'leaving' | 'down' | 'removed';

/** One incarnation of one node. */
export interface Entry {
  readonly address: string;
  readonly uid: number;
  readonly status: Status;
}

/** Entries by key, sorted by address, then uid, so every node walks them in the same order. */
export type Table = ReadonlyMap<string, Entry>;

const RANK: Readonly<Record<Status, number>> = { up: 0, leaving: 1, down: 2, removed: 3 };

/** An entry's key: `address#uid`, as a lease holder is named. */
export function keyOf(address: string, uid: number): string {
  return `${address}#${String(uid)}`;
}

/** Whether `a` is further along than `b`. */
export function isAfter(a: Status, b: Status): boolean {
  return RANK[a] > RANK[b];
}

/** A table of `entries`, sorted. A key given twice keeps its furthest status. */
export function tableOf(entries: Iterable<Entry>): Table {
  const byKey = new Map<string, Entry>();
  for (const entry of entries) {
    const key = keyOf(entry.address, entry.uid);
    const known = byKey.get(key);
    if (known === undefined || isAfter(entry.status, known.status)) byKey.set(key, entry);
  }
  const sorted = [...byKey.values()].sort(compare);
  return new Map(sorted.map((e) => [keyOf(e.address, e.uid), e]));
}

/** Every entry of both tables, each with the furthest status either has for it. */
export function merge(a: Table, b: Table): Table {
  return tableOf([...a.values(), ...b.values()]);
}

/** `table` with the entry at `key` moved to `status`, if that's further along. */
export function advance(table: Table, entry: Entry): Table {
  const known = table.get(keyOf(entry.address, entry.uid));
  if (known !== undefined && !isAfter(entry.status, known.status)) return table;
  return tableOf([...table.values(), entry]);
}

/** Whether two tables hold the same entries. */
export function sameTable(a: Table, b: Table): boolean {
  if (a.size !== b.size) return false;
  for (const [key, entry] of a) {
    if (b.get(key)?.status !== entry.status) return false;
  }
  return true;
}

/** A table as gossip carries it: `[address, uid, status]` triples. */
export function encodeTable(table: Table): [string, number, Status][] {
  return [...table.values()].map((e) => [e.address, e.uid, e.status]);
}

/** A table from gossip, or `undefined` if `value` isn't one. */
export function decodeTable(value: unknown, isAddress: (a: string) => boolean): Table | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Entry[] = [];
  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || item.length !== 3) return undefined;
    const [address, uid, status] = item as unknown[];
    if (typeof address !== 'string' || !isAddress(address)) return undefined;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) return undefined;
    if (typeof status !== 'string' || !Object.hasOwn(RANK, status)) return undefined;
    entries.push({ address, uid, status: status as Status });
  }
  return tableOf(entries);
}

function compare(a: Entry, b: Entry): number {
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return a.uid - b.uid;
}
