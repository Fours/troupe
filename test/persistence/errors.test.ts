import { describe, expect, it } from 'vitest';
import { JournalConflictError, JournalSequenceError } from '@kylewillett/troupe/persistence';

describe('persistence errors', () => {
  it('JournalConflictError carries the stream and the expected sequence number', () => {
    const error = new JournalConflictError('account-42', 3);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'JournalConflictError', persistenceId: 'account-42' });
    expect(error.expectedSeq).toBe(3);
    expect(error.message).toBe(
      'append to "account-42" expected sequence number 3, but another writer appended first',
    );
  });

  it('JournalSequenceError carries the stream, and the sequence numbers expected and got', () => {
    const error = new JournalSequenceError('account-42', 4, 6);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'JournalSequenceError',
      persistenceId: 'account-42',
      expected: 4,
      got: 6,
    });
    expect(error.message).toBe('read of "account-42" expected sequence number 4, got 6');
  });
});
