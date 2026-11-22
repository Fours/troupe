import type { StandardSchemaV1 } from './standard-schema.js';

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

/**
 * The reason a command or a recovery fails when an event doesn't pass its schema. On write it's
 * thrown before the append, so nothing was written. On recovery it names the stored event.
 */
export class EventValidationError extends Error {
  /** Always `"EventValidationError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'EventValidationError';
  /** The stream the event belongs to. */
  readonly persistenceId: string;
  /** The stored event's sequence number, on recovery. Undefined on write. */
  readonly seq: number | undefined;
  /** What the schema found wrong, as it reported it. */
  readonly issues: readonly StandardSchemaV1.Issue[];

  /** Creates the error for an event of `persistenceId`, at `seq` when it was read. */
  constructor(
    persistenceId: string,
    seq: number | undefined,
    issues: readonly StandardSchemaV1.Issue[],
  ) {
    const where = seq === undefined ? 'a new event' : `event ${String(seq)}`;
    const first = issues[0]?.message ?? 'no issues reported';
    super(`${where} of "${persistenceId}" failed its schema: ${first}`);
    this.persistenceId = persistenceId;
    this.seq = seq;
    this.issues = issues;
  }
}

/**
 * The reason recovery fails when a stored event's version is newer than the actor's. It usually
 * means an older deployment is reading events a newer one wrote.
 */
export class EventVersionError extends Error {
  /** Always `"EventVersionError"`, so the error can be recognized without `instanceof`. */
  override readonly name = 'EventVersionError';
  /** The stream being read. */
  readonly persistenceId: string;
  /** The stored event's sequence number. */
  readonly seq: number;
  /** The stored event's version. */
  readonly version: number;

  /** Creates the error for event `seq` of `persistenceId`, stored at `version`. */
  constructor(persistenceId: string, seq: number, version: number, current: number) {
    super(
      `event ${String(seq)} of "${persistenceId}" has version ${String(version)}, ` +
        `newer than this actor's ${String(current)}`,
    );
    this.persistenceId = persistenceId;
    this.seq = seq;
    this.version = version;
  }
}
