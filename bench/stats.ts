// The benchmark's arithmetic, kept pure so its definitions are pinned by tests (decision 0019).

/** The middle value of `values`. With an even count, the mean of the middle two. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Both indexes are in range: sorted has at least one value, and mid is at most its last index.
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

/**
 * The nearest-rank percentile: the `ceil(p/100 × n)`-th smallest value, so it's a value some
 * sample actually had, with no interpolation.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('percentile of no values');
  if (!(p > 0 && p <= 100))
    throw new RangeError(`percentile must be in (0, 100], got ${String(p)}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] as number;
}

/** One metric across a scenario's runs. */
export interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  /** `(max - min) / median`, as a percentage. */
  readonly spreadPct: number;
}

/** The median, range and relative spread of one metric across runs. */
export function spread(values: readonly number[]): Spread {
  const m = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { median: m, min, max, spreadPct: m === 0 ? 0 : ((max - min) / m) * 100 };
}

/** Operations per second, from a count and a duration in ms. */
export function perSecond(ops: number, ms: number): number {
  if (!(ms > 0)) throw new RangeError(`duration must be positive, got ${String(ms)}`);
  return (ops / ms) * 1000;
}

/** Whether `value` falls inside a recorded range, ends included. */
export function within(value: number, range: Pick<Spread, 'min' | 'max'>): boolean {
  return value >= range.min && value <= range.max;
}
