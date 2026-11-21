import { describe, expect, it } from 'vitest';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { supervise } from '../../src/supervision.js';
import { createTestKit } from '../../src/testkit/kit.js';
import type { SystemEvent } from '../../src/types.js';
import { account, type Receipt } from '../helpers/account.js';

/**
 * Two writers to one account under jittered backoff: persists, a conflict that restarts the loser,
 * a crash that restarts the winner, and recovery in both.
 */
async function scenario(seed: number) {
  const kit = createTestKit({ seed });
  const persistence = inMemoryPersistence({ clock: () => 0 });
  const receipts = kit.probe<Receipt>('receipts');
  const balances = kit.probe<number>('balances');
  const supervision = supervise.restartWithBackoff({ minMs: 100, maxMs: 1000, randomFactor: 0.5 });
  const a = kit.system.spawn(account(persistence), 'a', { supervision });
  const b = kit.system.spawn(account(persistence), 'b', { supervision });
  await kit.settle();

  a.tell({ type: 'deposit', amount: 10, replyTo: receipts.ref });
  await kit.advance(10);
  b.tell({ type: 'deposit', amount: 5, replyTo: receipts.ref });
  await kit.advance(2000);
  b.tell({ type: 'deposit', amount: 5, replyTo: receipts.ref });
  a.tell({ type: 'crash' });
  await kit.advance(2000);
  a.tell({ type: 'balance', replyTo: balances.ref });
  b.tell({ type: 'balance', replyTo: balances.ref });
  await kit.advance(10);
  await kit.shutdown();
  return {
    events: plain(kit.events),
    receipts: receipts.messages(),
    balances: balances.messages(),
    journal: persistence.events().map((e) => [e.seq, e.event]),
  };
}

/** Events as plain data, so two runs compare by content: errors by name and message. */
function plain(events: readonly SystemEvent[]): SystemEvent[] {
  return JSON.parse(
    JSON.stringify(events, (_key, value: unknown) =>
      value instanceof Error ? `${value.name}: ${value.message}` : value,
    ),
  ) as SystemEvent[];
}

const delays = (events: readonly SystemEvent[]) =>
  events.flatMap((e) => (e.type === 'restarted' ? [e.delayMs] : []));

describe('persistent actor determinism', () => {
  it('replays persists, a conflict and restarts under backoff to identical events', async () => {
    const first = await scenario(1);
    const second = await scenario(1);
    expect(second).toEqual(first);

    // The scenario really did what it claims.
    const failures = first.events.flatMap((e) => (e.type === 'failed' ? [e.error] : []));
    expect(failures).toEqual([
      expect.stringMatching(/^JournalConflictError/),
      'Error: crash requested',
    ]);
    expect(delays(first.events)).toHaveLength(2);
    expect(first.events.filter((e) => e.type === 'recovered')).toHaveLength(4);
    expect(first.balances).toEqual([15, 15]);
    expect(first.journal).toEqual([
      [1, { type: 'deposited', amount: 10 }],
      [2, { type: 'deposited', amount: 5 }],
    ]);
  });

  it('changes the backoff delays with a different seed', async () => {
    const one = await scenario(1);
    const two = await scenario(2);
    expect(delays(two.events)).not.toEqual(delays(one.events));
  });
});
