/**
 * The reason `Journal.append` rejects when the stream's last sequence number isn't the expected
 * one: another writer got there first (decision 0013). Nothing was written. Backends throw it.
 */
export class JournalConflictError extends Error {
  /** Always `"JournalConflictError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'JournalConflictError';
  /** The stream the append was for. */
  readonly persistenceId: string;
  /** The sequence number the append expected to follow. */
  readonly expectedSeq: number;

  /** Creates the error for an append to `persistenceId` at `expectedSeq`. */
  constructor(persistenceId: string, expectedSeq: number) {
    super(
      `append to "${persistenceId}" expected sequence number ${String(expectedSeq)}, ` +
        'but another writer appended first',
    );
    this.persistenceId = persistenceId;
    this.expectedSeq = expectedSeq;
  }
}

/** The reason recovery fails when a backend returns an event out of sequence. */
export class JournalSequenceError extends Error {
  /** Always `"JournalSequenceError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'JournalSequenceError';
  /** The stream being read. */
  readonly persistenceId: string;
  /** The sequence number that should have come next. */
  readonly expected: number;
  /** The sequence number that came instead. */
  readonly got: number;

  /** Creates the error for a read of `persistenceId` that got `got` where `expected` was due. */
  constructor(persistenceId: string, expected: number, got: number) {
    super(
      `read of "${persistenceId}" expected sequence number ${String(expected)}, got ${String(got)}`,
    );
    this.persistenceId = persistenceId;
    this.expected = expected;
    this.got = got;
  }
}
