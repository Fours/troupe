import { describe, expect, it } from 'vitest';
import {
  EventValidationError,
  EventVersionError,
  JournalConflictError,
  JournalSequenceError,
} from '@kylewillett/troupe/persistence';

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

  it('EventValidationError carries the stream, the issues, and the seq only on read', () => {
    const issues = [{ message: 'expected a number', path: ['amount'] }];
    const onWrite = new EventValidationError('account-42', undefined, issues);
    expect(onWrite).toBeInstanceOf(Error);
    expect(onWrite).toMatchObject({ name: 'EventValidationError', persistenceId: 'account-42' });
    expect(onWrite.seq).toBeUndefined();
    expect(onWrite.issues).toBe(issues);
    expect(onWrite.message).toBe(
      'a new event of "account-42" failed its schema: expected a number',
    );
    const onRead = new EventValidationError('account-42', 7, []);
    expect(onRead.seq).toBe(7);
    expect(onRead.message).toBe('event 7 of "account-42" failed its schema: no issues reported');
  });

  it('EventVersionError carries the stream, the seq and the stored version', () => {
    const error = new EventVersionError('account-42', 3, 4, 2);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'EventVersionError',
      persistenceId: 'account-42',
      seq: 3,
      version: 4,
    });
    expect(error.message).toBe('event 3 of "account-42" has version 4, newer than this actor\'s 2');
  });
});
