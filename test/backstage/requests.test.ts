import { describe, expect, it } from 'vitest';
import { narrator } from '../../examples/box-office/narrate.ts';
import { runScenario } from '../../examples/box-office/scenario.ts';
import { actor } from '../../src/actor.js';
import { backstage } from '../../src/backstage/source.js';
import type { BackstageResponse, BackstageSource, Frame } from '../../src/backstage/types.js';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import type { Persistence } from '../../src/persistence/types.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';
import { account } from '../helpers/account.js';
import { faultyJournal } from '../helpers/faulty-journal.js';

const plain = actor<never, { seats: Map<string, number>; name: string }>({
  initial: () => ({ seats: new Map([['A1', 1]]), name: 'plain' }),
  receive: (s) => s,
});

/** A system with a plain actor and an account that made `deposits` deposits. */
async function setup(deposits: number, persistence: Persistence = inMemoryPersistence()) {
  const kit = createTestKit();
  const source = backstage(kit.system);
  kit.system.spawn(plain, 'plain');
  const ref = kit.system.spawn(account(persistence, { tags: () => ['money'] }), 'account');
  const probe = kit.probe<unknown>();
  for (let i = 1; i <= deposits; i++) ref.tell({ type: 'deposit', amount: i, replyTo: probe.ref });
  await kit.settle();
  return { kit, source, persistence };
}

const error = (name: string) => ({
  ok: false,
  error: { name, message: expect.any(String) as string },
});

/** A timeline response's events, failing the test for any other response. */
function eventsOf(response: BackstageResponse) {
  if (!response.ok || response.type !== 'timeline') throw new Error('not a timeline');
  return response.events;
}

describe('backstage requests', () => {
  it('state gives the current state, encoded, and a persistent actor’s seq with it', async () => {
    const { source } = await setup(3);
    expect(await source.request({ type: 'state', path: '/user/plain' })).toStrictEqual({
      ok: true,
      type: 'state',
      path: '/user/plain',
      state: { seats: { $value: 'Map(1)' }, name: 'plain' },
    });
    expect(await source.request({ type: 'state', path: '/user/account' })).toStrictEqual({
      ok: true,
      type: 'state',
      path: '/user/account',
      state: { seq: 3, state: { balance: 6, closed: false } },
    });
  });

  it('timeline gives stored events from fromSeq, at most limit, with tags and lastSeq', async () => {
    const { source, kit } = await setup(5);
    const response = await source.request({
      type: 'timeline',
      path: '/user/account',
      fromSeq: 2,
      limit: 2,
    });
    expect(response).toStrictEqual({
      ok: true,
      type: 'timeline',
      path: '/user/account',
      persistenceId: 'account-1',
      events: [2, 3].map((seq) => ({
        seq,
        offset: seq,
        event: { type: 'deposited', amount: seq },
        version: 1,
        tags: ['money'],
        timestamp: expect.any(Number) as number,
      })),
      lastSeq: 5,
    });
    const tail = await source.request({
      type: 'timeline',
      path: '/user/account',
      fromSeq: 4,
      limit: 10,
    });
    expect(tail).toMatchObject({ ok: true, lastSeq: 5 });
    expect(eventsOf(tail).map((e) => e.seq)).toEqual([4, 5]);
    // One past the end is an empty page, so an inspector can ask what comes next.
    expect(
      await source.request({ type: 'timeline', path: '/user/account', fromSeq: 6, limit: 10 }),
    ).toMatchObject({ ok: true, events: [], lastSeq: 5 });
    expect(
      await source.request({ type: 'timeline', path: '/user/account', fromSeq: 7, limit: 10 }),
    ).toStrictEqual(error('RangeError'));
    // Reading changed nothing.
    const events = kit.events.length;
    await source.request({ type: 'timeline', path: '/user/account', fromSeq: 1, limit: 256 });
    expect(kit.events).toHaveLength(events);
  });

  it('timeline finds lastSeq past a page, and gives 0 for an empty stream', async () => {
    const persistence = inMemoryPersistence();
    const many = Array.from({ length: 600 }, () => ({
      event: { type: 'deposited', amount: 1 },
      version: 1,
      tags: [],
    }));
    await persistence.journal.append('account-1', 0, many);
    const { source } = await setup(0, persistence);
    for (const fromSeq of [1, 255, 256, 257, 600]) {
      const response = await source.request({
        type: 'timeline',
        path: '/user/account',
        fromSeq,
        limit: 1,
      });
      expect(response, `fromSeq ${String(fromSeq)}`).toMatchObject({ ok: true, lastSeq: 600 });
    }
    const full = await source.request({
      type: 'timeline',
      path: '/user/account',
      fromSeq: 300,
      limit: 256,
    });
    expect(full).toMatchObject({ ok: true, lastSeq: 600 });
    expect(eventsOf(full)).toHaveLength(256);

    const empty = await setup(0);
    expect(
      await empty.source.request({ type: 'timeline', path: '/user/account', fromSeq: 1, limit: 5 }),
    ).toMatchObject({ ok: true, events: [], lastSeq: 0 });
  });

  it('stateAt gives the state after each event, and an error past the end', async () => {
    const { source } = await setup(4);
    const balances = [0, 1, 3, 6, 10];
    for (const [seq, balance] of balances.entries()) {
      expect(await source.request({ type: 'stateAt', path: '/user/account', seq })).toStrictEqual({
        ok: true,
        type: 'stateAt',
        path: '/user/account',
        seq,
        state: { balance, closed: false },
      });
    }
    expect(await source.request({ type: 'stateAt', path: '/user/account', seq: 5 })).toStrictEqual(
      error('RangeError'),
    );
  });

  it('gives an error response for an unknown path or a plain actor', async () => {
    const { source } = await setup(1);
    for (const type of ['state', 'stateAt', 'timeline'] as const) {
      const req =
        type === 'state'
          ? { type, path: '/user/nobody' }
          : type === 'stateAt'
            ? { type, path: '/user/nobody', seq: 0 }
            : { type, path: '/user/nobody', fromSeq: 1, limit: 1 };
      expect(await source.request(req), type).toStrictEqual(error('NotFoundError'));
    }
    expect(await source.request({ type: 'stateAt', path: '/user/plain', seq: 0 })).toStrictEqual(
      error('NotPersistentError'),
    );
    expect(
      await source.request({ type: 'timeline', path: '/user/plain', fromSeq: 1, limit: 1 }),
    ).toStrictEqual(error('NotPersistentError'));
  });

  it('gives a TypeError or RangeError response for a request that isn’t one', async () => {
    const { source } = await setup(1);
    const path = '/user/account';
    const cases: [unknown, string][] = [
      [null, 'TypeError'],
      ['state', 'TypeError'],
      [[], 'TypeError'],
      [{ type: 'stop', path }, 'TypeError'],
      [{ type: 'toString', path }, 'TypeError'],
      [{ type: 'state' }, 'TypeError'],
      [{ type: 'state', path: 1 }, 'TypeError'],
      [{ type: 'state', path, extra: true }, 'TypeError'],
      [{ type: 'stateAt', path, seq: 1.5 }, 'TypeError'],
      [{ type: 'stateAt', path, seq: '1' }, 'TypeError'],
      [{ type: 'stateAt', path, seq: -1 }, 'RangeError'],
      [{ type: 'timeline', path, fromSeq: 0, limit: 1 }, 'RangeError'],
      [{ type: 'timeline', path, fromSeq: 1, limit: 0 }, 'RangeError'],
      [{ type: 'timeline', path, fromSeq: 1, limit: 257 }, 'RangeError'],
      [{ type: 'timeline', path, fromSeq: 1 }, 'TypeError'],
    ];
    for (const [req, name] of cases) {
      expect(await source.request(req as never), JSON.stringify(req)).toStrictEqual(error(name));
    }
  });

  it('turns a journal failure into an error response, never a rejection', async () => {
    const journal = faultyJournal(inMemoryPersistence().journal);
    const { source } = await setup(2, { journal, snapshots: inMemoryPersistence().snapshots });
    journal.failReads(new TypeError('journal down'));
    expect(
      await source.request({ type: 'timeline', path: '/user/account', fromSeq: 1, limit: 5 }),
    ).toStrictEqual({ ok: false, error: { name: 'TypeError', message: 'journal down' } });
    journal.failReads('a string, not an error');
    expect(await source.request({ type: 'stateAt', path: '/user/account', seq: 1 })).toStrictEqual({
      ok: false,
      error: { name: 'Error', message: '"a string, not an error"' },
    });
  });
});

describe('the wire', () => {
  it('every frame and response survives JSON.parse(JSON.stringify(...)) unchanged', async () => {
    const persistence = inMemoryPersistence();
    const frames: Frame[] = [];
    const responses: BackstageResponse[] = [];
    const kits: TestKit[] = [];
    const sources: BackstageSource[] = [];
    await runScenario({
      open: () => {
        const kit = createTestKit({ system: { name: 'box-office' } });
        kits.push(kit);
        const source = backstage(kit.system);
        sources.push(source);
        source.connect((frame) => frames.push(frame));
        return {
          system: kit.system,
          persistence,
          narrator: narrator(
            () => kit.scheduler.now(),
            () => {},
          ),
          sleep: async (ms) => {
            await kit.advance(ms);
            // Ask about every actor as the story goes, as the UI would.
            const hello: Frame[] = [];
            source.connect((f) => hello.push(f))();
            frames.push(...hello);
            if (hello[0]?.type !== 'hello') return;
            for (const { path, persistenceId } of hello[0].actors) {
              responses.push(await source.request({ type: 'state', path }));
              if (persistenceId === undefined) continue;
              const timeline = await source.request({
                type: 'timeline',
                path,
                fromSeq: 1,
                limit: 256,
              });
              responses.push(timeline);
              if (!timeline.ok || timeline.type !== 'timeline') continue;
              for (let seq = 0; seq <= timeline.lastSeq; seq++) {
                responses.push(await source.request({ type: 'stateAt', path, seq }));
              }
            }
          },
          shutdown: () => kit.shutdown(),
        };
      },
    });
    // The story has every kind of frame and response in it.
    const types = new Set(frames.map((f) => (f.type === 'event' ? f.event.type : f.type)));
    for (const type of [
      'hello',
      'spawned',
      'delivered',
      'processed',
      'persisted',
      'recovered',
      'stopped',
    ]) {
      expect(types, type).toContain(type);
    }
    expect(new Set(responses.map((r) => (r.ok ? r.type : 'error')))).toEqual(
      new Set(['state', 'timeline', 'stateAt']),
    );
    for (const value of [...frames, ...responses]) {
      expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
    }
  });
});
