import { inMemoryPersistence } from '@kylewillett/troupe/persistence';
import { createTestKit } from '@kylewillett/troupe/testkit';
import { describe, expect, it } from 'vitest';
import {
  boxOffice,
  HOLD_MS,
  SALE_TAG,
  showId,
  type ConfirmReply,
  type HoldReply,
  type ReturnReply,
  type StatusReply,
} from '../../demo/src/domain/shows.ts';
import { only } from './helpers.ts';

// The shows on their own, on the testkit, with one small show so it sells out quickly.
function setup() {
  const kit = createTestKit();
  const persistence = inMemoryPersistence({ clock: () => kit.scheduler.now() });
  const office = kit.system.spawn(boxOffice({ hamlet: 4 }, persistence), 'box-office');
  const holds = kit.probe<HoldReply>('holds');
  const confirms = kit.probe<ConfirmReply>('confirms');
  const statuses = kit.probe<StatusReply>('statuses');
  const hold = (seats: number, customer = 'alice') => {
    office.tell({ type: 'hold', show: 'hamlet', customer, seats, replyTo: holds.ref });
  };
  const confirm = (holdId: string) => {
    office.tell({ type: 'confirm', show: 'hamlet', holdId, replyTo: confirms.ref });
  };
  const status = async () => {
    office.tell({ type: 'status', show: 'hamlet', replyTo: statuses.ref });
    await kit.settle();
    return statuses.expectMessage();
  };
  return { kit, persistence, office, holds, confirms, hold, confirm, status };
}

describe('a show', () => {
  it('holds seats, and sells them on confirm', async () => {
    const { kit, holds, confirms, hold, confirm, status } = setup();
    hold(3);
    await kit.settle();
    const reply = holds.expectMessage();
    expect(reply).toMatchObject({ kind: 'hold', ok: true, show: 'hamlet', seats: 3 });
    if (!reply.ok) throw new Error('expected a hold');
    expect(await status()).toEqual({ ok: true, capacity: 4, sold: 0, held: 3 });

    confirm(reply.holdId);
    await kit.settle();
    expect(confirms.expectMessage()).toEqual({
      kind: 'confirm',
      ok: true,
      show: 'hamlet',
      seats: 3,
    });
    expect(await status()).toEqual({ ok: true, capacity: 4, sold: 3, held: 0 });
  });

  it('turns a customer away when the seats are gone', async () => {
    const { kit, holds, hold } = setup();
    hold(3);
    hold(2, 'bob');
    hold(1, 'carol');
    hold(1, 'dave');
    await kit.settle();
    expect(holds.messages().map((r) => (r.ok ? r.seats : r.reason))).toEqual([
      3,
      'only 1 left',
      1,
      'sold out',
    ]);
  });

  it('lets a hold expire, putting its seats back on sale', async () => {
    const { kit, holds, confirms, hold, confirm, status } = setup();
    hold(4);
    await kit.settle();
    const reply = holds.expectMessage();
    if (!reply.ok) throw new Error('expected a hold');

    await kit.advance(HOLD_MS - 1);
    expect(await status()).toMatchObject({ held: 4 });
    await kit.advance(1);
    expect(await status()).toEqual({ ok: true, capacity: 4, sold: 0, held: 0 });

    confirm(reply.holdId);
    await kit.settle();
    expect(confirms.expectMessage()).toEqual({
      kind: 'confirm',
      ok: false,
      show: 'hamlet',
      reason: 'no such hold',
    });
  });

  it('crashes on a malformed hold, restarts with backoff, and keeps its holds', async () => {
    const { kit, holds, hold, status } = setup();
    hold(2);
    await kit.settle();
    holds.expectMessage();
    hold(-1, 'mallory');
    await kit.settle();

    const [failed] = only(kit.events, 'failed');
    expect(failed).toMatchObject({ path: '/user/box-office/hamlet', directive: 'restart' });
    expect(failed?.error).toBeInstanceOf(RangeError);
    // Nobody answers mallory.
    holds.expectNoMessage();

    await kit.advance(250);
    const [restarted] = only(kit.events, 'restarted');
    // 200 ms, plus up to 20% jitter.
    expect(restarted?.delayMs).toBeGreaterThanOrEqual(200);
    expect(restarted?.delayMs).toBeLessThanOrEqual(240);
    expect(only(kit.events, 'recovered').at(-1)).toMatchObject({ lastSeq: 1 });
    expect(await status()).toEqual({ ok: true, capacity: 4, sold: 0, held: 2 });
  });

  it('tags sales, and only sales', async () => {
    const { kit, persistence, holds, hold, confirm } = setup();
    hold(1);
    hold(2, 'bob');
    await kit.settle();
    const [first] = holds.messages();
    if (first?.ok !== true) throw new Error('expected a hold');
    confirm(first.holdId);
    await kit.advance(HOLD_MS);

    const stream = await persistence.journal.read(showId('hamlet'), 1, 10);
    expect(stream.map((e) => [(e.event as { type: string }).type, e.tags])).toEqual([
      ['held', []],
      ['held', []],
      ['confirmed', [SALE_TAG]],
      ['released', []],
    ]);
    const sales = await persistence.journal.readByTag(SALE_TAG, 0, 10);
    expect(sales.map((e) => e.event)).toEqual([
      { type: 'confirmed', holdId: first.holdId, seats: 1 },
    ]);
  });

  it('takes seats back, puts them on sale again, and tags the return', async () => {
    const { kit, persistence, office, holds, hold, confirm, status } = setup();
    const returns = kit.probe<ReturnReply>('returns');
    const giveBack = (seats: number) => {
      office.tell({ type: 'return', show: 'hamlet', customer: 'zoe', seats, replyTo: returns.ref });
    };
    giveBack(1);
    await kit.settle();
    expect(returns.expectMessage()).toEqual({
      kind: 'return',
      ok: false,
      show: 'hamlet',
      reason: 'nothing sold yet',
    });

    hold(4);
    await kit.settle();
    const reply = holds.expectMessage();
    if (!reply.ok) throw new Error('expected a hold');
    confirm(reply.holdId);
    await kit.settle();
    hold(1, 'bob');
    await kit.settle();
    expect(holds.expectMessage()).toMatchObject({ ok: false, reason: 'sold out' });

    // More than were sold gives back only what was.
    giveBack(3);
    giveBack(3);
    await kit.settle();
    expect(returns.messages()).toEqual([
      { kind: 'return', ok: true, show: 'hamlet', seats: 3 },
      { kind: 'return', ok: true, show: 'hamlet', seats: 1 },
    ]);
    expect(await status()).toEqual({ ok: true, capacity: 4, sold: 0, held: 0 });
    hold(2, 'carol');
    await kit.settle();
    expect(holds.expectMessage()).toMatchObject({ ok: true, seats: 2 });

    const sales = await persistence.journal.readByTag(SALE_TAG, 0, 10);
    expect(sales.map((e) => (e.event as { type: string }).type)).toEqual([
      'confirmed',
      'returned',
      'returned',
    ]);
  });

  it('answers a request for a show that is not on', async () => {
    const { kit, office, holds, confirms } = setup();
    office.tell({ type: 'hold', show: 'cats', customer: 'eve', seats: 1, replyTo: holds.ref });
    office.tell({ type: 'confirm', show: 'cats', holdId: 'cats-1', replyTo: confirms.ref });
    const statuses = kit.probe<StatusReply>();
    office.tell({ type: 'status', show: 'cats', replyTo: statuses.ref });
    await kit.settle();
    const reason = 'no show "cats"';
    expect(holds.expectMessage()).toEqual({ kind: 'hold', ok: false, show: 'cats', reason });
    expect(confirms.expectMessage()).toEqual({ kind: 'confirm', ok: false, show: 'cats', reason });
    expect(statuses.expectMessage()).toEqual({ ok: false, reason });
    const returns = kit.probe<ReturnReply>();
    office.tell({ type: 'return', show: 'cats', customer: 'eve', seats: 1, replyTo: returns.ref });
    await kit.settle();
    expect(returns.expectMessage()).toEqual({ kind: 'return', ok: false, show: 'cats', reason });
  });
});
