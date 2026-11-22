import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { createTestKit } from '@kylewillett/troupe/testkit';
import { describe, expect, it } from 'vitest';
import { salesBoard } from '../../demo/src/domain/sales-board.ts';
import { SALE_TAG, showId } from '../../demo/src/domain/shows.ts';

const sale = (seats: number) => ({
  event: { type: 'confirmed', holdId: 'x', seats },
  version: 1,
  tags: [SALE_TAG],
});

function setup(journal = inMemoryPersistence().journal) {
  const kit = createTestKit();
  const board = kit.system.spawn(
    salesBoard({ journal, offsets: inMemoryPersistence().offsets }),
    'sales-board',
  );
  const totals = async () => {
    const probe = kit.probe<Readonly<Record<string, number>>>();
    board.tell({ type: 'totals', replyTo: probe.ref });
    await kit.settle();
    return probe.expectMessage();
  };
  return { kit, board, journal, totals };
}

describe('the sales board', () => {
  it('counts the seats sold per show, from the journal', async () => {
    const { kit, journal, totals } = setup();
    await journal.append(showId('hamlet'), 0, [sale(2), sale(3)]);
    await journal.append(showId('lear'), 0, [sale(1)]);
    // Not a sale, so not tagged.
    await journal.append(showId('lear'), 1, [{ event: { type: 'held' }, version: 1, tags: [] }]);
    await kit.advance(250);
    expect(await totals()).toEqual({ hamlet: 5, lear: 1 });

    await journal.append(showId('hamlet'), 2, [sale(4)]);
    await kit.advance(250);
    expect(await totals()).toEqual({ hamlet: 9, lear: 1 });
  });

  it('takes a return off its show', async () => {
    const { kit, journal, totals } = setup();
    await journal.append(showId('hamlet'), 0, [
      sale(4),
      { event: { type: 'returned', customer: 'zoe', seats: 3 }, version: 1, tags: [SALE_TAG] },
    ]);
    await kit.advance(250);
    expect(await totals()).toEqual({ hamlet: 1 });
  });

  it('counts a sale once, however often its feed sends it', async () => {
    const { kit, board, totals } = setup();
    await kit.settle();
    for (const offset of [1, 2, 2, 1, 3])
      board.tell({ type: 'sale', offset, show: 'hamlet', seats: 1 });
    expect(await totals()).toEqual({ hamlet: 3 });
  });

  it('starts complete on a new system, since its offsets are its own', async () => {
    const journal = inMemoryPersistence().journal;
    await journal.append(showId('othello'), 0, [sale(2), sale(2)]);
    const first = setup(journal);
    await first.kit.advance(250);
    expect(await first.totals()).toEqual({ othello: 4 });
    await first.kit.shutdown();

    const second = setup(journal);
    await second.kit.advance(250);
    expect(await second.totals()).toEqual({ othello: 4 });
  });

  it('ignores a tagged event that is not a sale of a show', async () => {
    const { kit, journal, totals } = setup();
    await journal.append('till-1', 0, [sale(5)]);
    await journal.append(showId('lear'), 0, [
      { event: { type: 'odd' }, version: 1, tags: [SALE_TAG] },
    ]);
    await kit.advance(250);
    expect(await totals()).toEqual({});
  });
});
