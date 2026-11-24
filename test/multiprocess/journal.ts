// What the journal says about a run: checked after the processes have stopped, from the events
// alone, so it holds whatever the processes logged.

/** One event as the harness reads it back. */
export interface JournalRow {
  readonly id: string;
  readonly seq: number;
  readonly event: Readonly<Record<string, unknown>>;
}

/**
 * The ways a show's stream shows two incarnations live at once, or a sale out of order: an
 * incarnation that wrote again after a later one had written (its runs interleave), or a sale
 * whose number isn't its sequence number. Empty when the streams are clean.
 */
export function journalProblems(rows: readonly JournalRow[]): string[] {
  const problems: string[] = [];
  const byStream = new Map<string, JournalRow[]>();
  for (const row of rows) {
    const list = byStream.get(row.id) ?? [];
    list.push(row);
    byStream.set(row.id, list);
  }
  for (const [id, list] of byStream) {
    list.sort((a, b) => a.seq - b.seq);
    const show = id.replace(/^show-/, '');
    const finished = new Set<string>();
    let current: string | undefined;
    list.forEach((row, i) => {
      if (row.seq !== i + 1)
        problems.push(`${id}: seq ${String(row.seq)} at position ${String(i + 1)}`);
      const inc = String(row.event['inc']);
      if (inc !== current) {
        if (finished.has(inc)) {
          problems.push(
            `${id}: ${inc} wrote seq ${String(row.seq)} after a later incarnation had written`,
          );
        }
        if (current !== undefined) finished.add(current);
        current = inc;
      }
      const saleId = row.event['saleId'];
      if (saleId !== `${show}-${String(row.seq)}`) {
        problems.push(`${id}: seq ${String(row.seq)} is sale ${String(saleId)}`);
      }
    });
  }
  return problems;
}

/** The acknowledged sales the journal doesn't have. */
export function missingSales(rows: readonly JournalRow[], acked: Iterable<string>): string[] {
  const saved = new Set(rows.map((r) => String(r.event['saleId'])));
  return [...acked].filter((saleId) => !saved.has(saleId));
}
