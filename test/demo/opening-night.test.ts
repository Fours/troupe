import type { SystemEvent } from '@kylewillett/troupe';
import { encode } from '@kylewillett/troupe/backstage';
import { describe, expect, it } from 'vitest';
import { RUSH_SIZE } from '../../demo/src/domain/crowd.ts';
import { JournalDownError } from '../../demo/src/domain/faulty-persistence.ts';
import { narrate } from '../../demo/src/domain/narrate.ts';
import { DEFAULT_TARGET, type OpeningNight } from '../../demo/src/domain/opening-night.ts';
import { SHOWS, type StatusReply } from '../../demo/src/domain/shows.ts';
import { answered, nextTurn, only, testNight } from './helpers.ts';

const showPath = (show: string) => `/user/box-office/${show}`;
const NAMES = Object.keys(SHOWS);

async function sold(night: OpeningNight): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const show of NAMES) {
    const reply: StatusReply = await answered(night.clock, night.status(show));
    if (!reply.ok) throw new Error(reply.reason);
    out[show] = reply.sold;
  }
  return out;
}

async function held(night: OpeningNight, show: string): Promise<number> {
  const reply = await answered(night.clock, night.status(show));
  if (!reply.ok) throw new Error(reply.reason);
  return reply.held;
}

const sum = (record: Readonly<Record<string, number>>) =>
  Object.values(record).reduce((a, b) => a + b, 0);

describe('opening night', () => {
  it('opens every show, the sales board and the crowd', async () => {
    const { night, events } = testNight();
    await night.clock.advance(0);
    const spawned = only(events, 'spawned').map((e) => e.path);
    expect(spawned).toEqual(
      expect.arrayContaining([
        '/user/box-office',
        ...NAMES.map(showPath),
        '/user/sales-board',
        '/user/sales-board/feed',
        '/user/crowd',
      ]),
    );
    expect(only(events, 'recovered').map((e) => e.path)).toEqual(NAMES.map(showPath));
    await night.dispose();
  });

  it('sells seats as customers come and go, and the sales board keeps count', async () => {
    const { night, events } = testNight();
    await night.clock.advance(30_000);
    const bySpawn = only(events, 'spawned').filter((e) => e.path.startsWith('/user/crowd/'));
    const byStop = only(events, 'stopped').filter((e) => e.path.startsWith('/user/crowd/'));
    expect(bySpawn.length).toBeGreaterThan(20);
    expect(byStop.length).toBeGreaterThan(10);

    const counts = await sold(night);
    expect(sum(counts)).toBeGreaterThan(0);
    // The board polls every 250 ms, so it has caught up within that.
    await night.clock.advance(300);
    const totals = await answered(night.clock, night.totals());
    expect(sum(totals)).toBe(sum(await sold(night)));
  });

  describe('Rush', () => {
    it(`sends ${String(RUSH_SIZE)} customers at once, and mailboxes fill, then drain`, async () => {
      const { night, events } = testNight({ arrivals: false });
      await night.clock.advance(0);
      await night.rush();
      await night.clock.advance(0);
      const customers = only(events, 'spawned').filter((e) => e.path.startsWith('/user/crowd/'));
      expect(customers).toHaveLength(RUSH_SIZE);

      const delivered = only(events, 'delivered');
      const deepest = (path: string) =>
        Math.max(0, ...delivered.filter((e) => e.path === path).map((e) => e.depth));
      expect(deepest('/user/box-office')).toBeGreaterThanOrEqual(RUSH_SIZE / 2);
      expect(Math.max(...NAMES.map((show) => deepest(showPath(show))))).toBeGreaterThan(1);

      await night.clock.advance(10_000);
      for (const show of NAMES) {
        const last = only(events, 'processed')
          .filter((e) => e.path === showPath(show))
          .at(-1);
        expect(last?.depth).toBe(0);
      }
    });
  });

  describe('Bad request', () => {
    it(`crashes ${DEFAULT_TARGET}, which restarts after about 200 ms with its holds`, async () => {
      const { night, events } = testNight({ arrivals: false });
      await night.rush();
      await night.clock.advance(400);
      const before = await held(night, DEFAULT_TARGET);
      expect(before).toBeGreaterThan(0);

      await night.badRequest();
      await night.clock.advance(0);
      const failed = only(events, 'failed');
      expect(failed.map((e) => e.path)).toEqual([showPath(DEFAULT_TARGET)]);
      expect(failed[0]?.error).toBeInstanceOf(RangeError);
      await night.clock.advance(250);
      const restarted = only(events, 'restarted');
      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.delayMs).toBeGreaterThanOrEqual(200);
      expect(restarted[0]?.delayMs).toBeLessThanOrEqual(240);
      expect(only(events, 'recovered').at(-1)?.path).toBe(showPath(DEFAULT_TARGET));
      expect(await held(night, DEFAULT_TARGET)).toBe(before);
    });

    it('goes to the show it is given', async () => {
      const { night, events } = testNight({ arrivals: false });
      await night.clock.advance(0);
      await night.badRequest('lear');
      await night.clock.advance(0);
      expect(only(events, 'failed').map((e) => e.path)).toEqual([showPath('lear')]);
    });
  });

  describe('Journal down, then up', () => {
    it('makes every show fail and back off, and each recovers with its sales', async () => {
      const { night, events } = testNight({ arrivals: false });
      await night.rush();
      // Long enough for every customer of the rush to be done.
      await night.clock.advance(10_000);
      const before = await sold(night);
      expect(sum(before)).toBeGreaterThan(0);

      await night.journalDown();
      expect(night.persistence.isDown).toBe(true);
      const downAt = night.clock.now();
      await night.rush();
      await night.clock.advance(15_000);
      for (const show of NAMES) {
        const path = showPath(show);
        const failures = only(events, 'failed').filter((e) => e.path === path && e.at >= downAt);
        expect(failures.length).toBeGreaterThan(3);
        for (const failure of failures) expect(failure.error).toBeInstanceOf(JournalDownError);
        // Each wait is longer than the one before, up to the cap.
        const delays = only(events, 'restarted')
          .filter((e) => e.path === path && e.at >= downAt)
          .map((e) => e.delayMs);
        expect(delays.slice(0, 4)).toEqual([...delays.slice(0, 4)].sort((a, b) => a - b));
        expect(delays[3]).toBeGreaterThan((delays[0] ?? 0) * 4);
      }

      await night.journalUp();
      const upAt = night.clock.now();
      // The longest backoff is 5 s, plus jitter.
      await night.clock.advance(7_000);
      for (const show of NAMES) {
        expect(
          only(events, 'recovered').some((e) => e.path === showPath(show) && e.at >= upAt),
        ).toBe(true);
      }
      // Nobody could buy while it was down, and the rush has gone home.
      expect(await sold(night)).toEqual(before);
      await night.clock.advance(300);
      expect(await answered(night.clock, night.totals())).toEqual(before);
    });
  });

  describe('Restart the system', () => {
    it('starts a new system on the same journal, and every show recovers its sales', async () => {
      const { night, events } = testNight();
      await night.clock.advance(20_000);
      const before = await sold(night);
      const old = night.system;

      await night.restart();
      expect(night.generation).toBe(1);
      expect(night.system).not.toBe(old);
      const restartedAt = night.clock.now();
      await night.clock.advance(0);
      const recovered = only(events, 'recovered').filter((e) => e.at >= restartedAt);
      expect(recovered.map((e) => e.path)).toEqual(NAMES.map(showPath));
      for (const e of recovered) expect(e.lastSeq).toBeGreaterThan(0);
      // Pass no time, so nobody new buys anything.
      const asked = Promise.all(NAMES.map((show) => night.status(show)));
      await night.clock.settle();
      const now = await asked;
      expect(Object.fromEntries(now.map((r, i) => [NAMES[i], r.ok ? r.sold : -1]))).toEqual(before);
      await night.clock.advance(300);
      expect(sum(await answered(night.clock, night.totals()))).toBeGreaterThanOrEqual(sum(before));
    });
  });

  it('runs a press made during a tick after it, at the virtual time it ends', async () => {
    const { night, events } = testNight({ arrivals: false });
    await night.clock.advance(0);
    // A click on the page can come between two turns of a tick's settling.
    const tick = night.clock.advance(1_000);
    await nextTurn();
    await nextTurn();
    const press = night.rush();
    await Promise.all([tick, press]);
    await night.clock.settle();
    const customers = only(events, 'spawned').filter((e) => e.path.startsWith('/user/crowd/'));
    expect(customers).toHaveLength(RUSH_SIZE);
    for (const spawned of customers) expect(spawned.at).toBe(1_000);
  });

  describe('determinism', () => {
    // The same button presses at the same virtual times, with frames cut differently.
    async function story(seed: number, frames: readonly number[]) {
      const { night, events } = testNight({ seed });
      const script = new Map<number, () => Promise<void> | void>([
        [3_000, () => night.rush()],
        [5_000, () => night.badRequest()],
        [8_000, () => night.journalDown()],
        [14_000, () => night.journalUp()],
        [22_000, () => night.restart()],
      ]);
      for (const [at, press] of script) {
        // Frame by frame up to the press, landing on it exactly, as a page would at that time.
        for (let i = 0; night.clock.now() < at; i++) {
          const frame = frames[i % frames.length] ?? 16;
          await night.clock.advance(Math.min(frame, at - night.clock.now()));
        }
        await press();
      }
      await night.clock.advance(5_000);
      await night.dispose();
      return events.map((e) => JSON.stringify(encode(e)));
    }

    it('tells the same story, event for event, for the same seed', async () => {
      const first = await story(5, [16]);
      const second = await story(5, [7, 33, 250, 1]);
      expect(first.length).toBeGreaterThan(1_000);
      expect(second).toEqual(first);
    });

    it('tells another story for another seed', async () => {
      expect(await story(6, [16])).not.toEqual(await story(5, [16]));
    });
  });
});

describe('the log', () => {
  const at = { seq: 1, at: 0 };
  const deliver = (path: string, message: unknown): SystemEvent => ({
    ...at,
    type: 'delivered',
    path,
    id: 1,
    message,
    depth: 1,
  });
  const customer = '/user/crowd/customer-7';
  const hold = { kind: 'hold', show: 'lear' } as const;
  const confirm = { kind: 'confirm', show: 'lear' } as const;

  it('tells what each customer does', () => {
    const lines = [
      { ok: true, value: { ...hold, ok: true, holdId: 'lear-1', seats: 1, expiresInMs: 4_000 } },
      { ok: true, value: { ...hold, ok: false, reason: 'sold out' } },
      { ok: false, error: new Error('timed out') },
      { type: 'decide', show: 'lear', buys: false },
      { type: 'decide', show: 'lear', buys: true },
      { ok: true, value: { ...confirm, ok: true, seats: 3 } },
      { ok: true, value: { ...confirm, ok: false, reason: 'no such hold' } },
      { ok: true, value: { ...confirm, ok: false, reason: 'closed' } },
    ].map((message) => narrate(deliver(customer, message)));
    expect(lines).toEqual([
      'customer-7 holds 1 seat for lear',
      'customer-7 is turned away from lear: sold out',
      'customer-7 gave up waiting for an answer',
      'customer-7 walks away, and the hold will expire',
      undefined,
      'customer-7 bought 3 seats for lear',
      'customer-7 came back too late: the hold on lear had expired',
      "customer-7 can't buy for lear: closed",
    ]);
  });

  it('tells failures, restarts and recoveries, and skips the rest', () => {
    const lines = [
      {
        ...at,
        type: 'failed',
        path: showPath('lear'),
        error: new RangeError('bad'),
        directive: 'restart',
      },
      {
        ...at,
        type: 'failed',
        path: '/user/sales-board/feed',
        error: 'down',
        directive: 'restart',
      },
      { ...at, type: 'restarted', path: showPath('lear'), attempt: 2, delayMs: 431 },
      {
        ...at,
        type: 'recovered',
        path: showPath('lear'),
        persistenceId: 'show-lear',
        snapshotSeq: 0,
        lastSeq: 1,
      },
      {
        ...at,
        type: 'recovered',
        path: showPath('lear'),
        persistenceId: 'show-lear',
        snapshotSeq: 0,
        lastSeq: 9,
      },
      {
        ...at,
        type: 'recovered',
        path: showPath('lear'),
        persistenceId: 'show-lear',
        snapshotSeq: 0,
        lastSeq: 0,
      },
      { ...at, type: 'failed', path: '/user/crowd', error: new Error('odd'), directive: 'stop' },
      { ...at, type: 'spawned', path: customer },
      deliver(showPath('lear'), { type: 'expire', holdId: 'lear-1' }),
    ].map((event) => narrate(event as SystemEvent));
    expect(lines).toEqual([
      'lear failed: RangeError: bad',
      'the sales board feed failed: down',
      'lear restarts after 431 ms (attempt 2)',
      'lear recovers 1 event from the journal',
      'lear recovers 9 events from the journal',
      'lear opens with an empty journal',
      '/user/crowd failed: Error: odd',
      undefined,
      undefined,
    ]);
  });
});
