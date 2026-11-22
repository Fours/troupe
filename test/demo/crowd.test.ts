import { inMemoryPersistence, type Persistence } from '@kylewillett/troupe/persistence';
import { createTestKit, seededRandom } from '@kylewillett/troupe/testkit';
import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_MS,
  ASK_TIMEOUT_MS,
  crowd,
  customer,
  MAX_LIVE,
  type Plan,
} from '../../demo/src/domain/crowd.ts';
import { faultyPersistence } from '../../demo/src/domain/faulty-persistence.ts';
import { boxOffice, HOLD_MS, type StatusReply } from '../../demo/src/domain/shows.ts';
import { only } from './helpers.ts';

function setup(persistence: Persistence = inMemoryPersistence(), capacity = 10) {
  const kit = createTestKit();
  const office = kit.system.spawn(boxOffice({ hamlet: capacity }, persistence), 'box-office');
  const status = async () => {
    const probe = kit.probe<StatusReply>();
    office.tell({ type: 'status', show: 'hamlet', replyTo: probe.ref });
    await kit.settle();
    return probe.expectMessage();
  };
  const visit = (name: string, plan: Partial<Plan> = {}) => {
    const full: Plan = { show: 'hamlet', seats: 2, thinkMs: 1_000, buys: true, ...plan };
    const ref = kit.system.spawn(customer(name, full, office), name);
    const watcher = kit.probe<never>();
    watcher.watch(ref);
    return { ref, watcher };
  };
  return { kit, office, status, visit };
}

describe('a customer', () => {
  it('holds, thinks, buys, and leaves', async () => {
    const { kit, status, visit } = setup();
    const { ref, watcher } = visit('alice', { seats: 3, thinkMs: 1_000 });
    await kit.settle();
    expect(await status()).toMatchObject({ sold: 0, held: 3 });
    await kit.advance(1_000);
    expect(await status()).toMatchObject({ sold: 3, held: 0 });
    watcher.expectTerminated(ref);
  });

  it('walks away, and the hold expires', async () => {
    const { kit, status, visit } = setup();
    const { ref, watcher } = visit('bob', { seats: 2, buys: false, thinkMs: 500 });
    await kit.advance(500);
    watcher.expectTerminated(ref);
    expect(await status()).toMatchObject({ sold: 0, held: 2 });
    await kit.advance(HOLD_MS);
    expect(await status()).toMatchObject({ sold: 0, held: 0 });
  });

  it('comes back too late when thinking outlasts the hold, and buys nothing', async () => {
    const { kit, status, visit } = setup();
    const { ref, watcher } = visit('carol', { thinkMs: HOLD_MS + 500 });
    await kit.advance(HOLD_MS + 500);
    watcher.expectTerminated(ref);
    expect(await status()).toMatchObject({ sold: 0, held: 0 });
  });

  it('leaves when turned away', async () => {
    const { kit, visit } = setup();
    const { ref, watcher } = visit('dave', { seats: 11 });
    await kit.settle();
    watcher.expectTerminated(ref);
  });

  it('gives up when the show does not answer in time', async () => {
    const persistence = faultyPersistence(() => 0);
    const { kit, visit } = setup(persistence);
    await kit.settle();
    persistence.down();
    const { ref, watcher } = visit('eve');
    await kit.advance(ASK_TIMEOUT_MS - 1);
    expect(() => {
      watcher.expectTerminated(ref);
    }).toThrow();
    await kit.advance(1);
    watcher.expectTerminated(ref);
  });
});

describe('the crowd', () => {
  const customers = (kit: ReturnType<typeof setup>['kit']) =>
    only(kit.events, 'spawned').filter((e) => e.path.startsWith('/user/crowd/'));

  it(`sends customers on its own, never more than ${String(MAX_LIVE)} at once`, async () => {
    // A house nobody fills, and arrivals far faster than customers leave, so the cap binds.
    const { kit, office } = setup(inMemoryPersistence(), 100_000);
    kit.system.spawn(
      crowd({
        office,
        shows: ['hamlet'],
        random: seededRandom(3),
        arrivalMs: { min: 10, max: 10 },
      }),
      'crowd',
    );
    let live = 0;
    let most = 0;
    kit.system.events.subscribe((event) => {
      if (!('path' in event) || !event.path.startsWith('/user/crowd/')) return;
      if (event.type === 'spawned') live++;
      if (event.type === 'stopped') live--;
      most = Math.max(most, live);
    });
    await kit.advance(30_000);
    expect(customers(kit).length).toBeGreaterThan(MAX_LIVE * 3);
    expect(most).toBe(MAX_LIVE);
  });

  it('sends a rush all at once, past the cap', async () => {
    const { kit, office } = setup();
    const people = kit.system.spawn(
      crowd({ office, shows: ['hamlet'], random: seededRandom(3), arrivals: false }),
      'crowd',
    );
    await kit.advance(ARRIVAL_MS.max * 2);
    expect(customers(kit)).toEqual([]);
    people.tell({ type: 'rush', count: 30 });
    await kit.settle();
    expect(customers(kit)).toHaveLength(30);
  });
});
