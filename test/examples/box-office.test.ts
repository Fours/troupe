import { describe, expect, it } from 'vitest';
import { narrator } from '../../examples/box-office/narrate.ts';
import { runScenario } from '../../examples/box-office/scenario.ts';
import { inMemoryPersistence } from '../../src/persistence/memory.js';
import { createTestKit, type TestKit } from '../../src/testkit/kit.js';

/**
 * Runs the example's scenario on virtual time, with one kit per act on one in-memory backend, and
 * returns the narration.
 */
async function run(seed = 1) {
  const persistence = inMemoryPersistence({ clock: () => 0 });
  const kits: TestKit[] = [];
  const lines: string[] = [];
  await runScenario({
    open: () => {
      const kit = createTestKit({ seed, system: { name: 'box-office' } });
      kits.push(kit);
      return {
        system: kit.system,
        persistence,
        narrator: narrator(
          () => kit.scheduler.now(),
          (line) => lines.push(line),
        ),
        sleep: (ms) => kit.advance(ms),
        shutdown: () => kit.shutdown(),
      };
    },
  });
  const [first, second] = kits;
  if (first === undefined || second === undefined) throw new Error('expected two acts');
  return { first, second, lines, persistence };
}

/** The events in a show's stream, as `persist` got them. */
async function stream(persistence: ReturnType<typeof inMemoryPersistence>, show: string) {
  const stored = await persistence.journal.read(`show-${show}`, 1, 100);
  return stored.map((e) => e.event);
}

describe('the box office example', () => {
  it('tells the same story every time, on virtual time', async () => {
    const { lines } = await run();
    expect(lines).toEqual([
      ' 0.00s  · /user/box-office started',
      ' 0.00s  · /user/box-office/hamlet started',
      ' 0.00s  · /user/box-office/macbeth started',
      ' 0.00s  · /user/box-office/hamlet recovered: its journal is empty',
      ' 0.00s  · /user/box-office/macbeth recovered: its journal is empty',
      ' 0.00s  alice asks to hold 2 seats for hamlet',
      ' 0.00s  · /user/box-office/hamlet persisted event 1',
      ' 0.00s  alice holds hamlet-1 for 1000 ms',
      ' 0.00s  alice confirms hamlet-1',
      ' 0.00s  · /user/box-office/hamlet persisted event 2',
      ' 0.00s  alice bought 2 seats',
      ' 0.00s  bob asks to hold 2 seats for macbeth',
      ' 0.00s  · /user/box-office/macbeth persisted event 1',
      ' 0.00s  bob holds macbeth-1 for 1000 ms',
      ' 0.00s  dave asks to hold 1 seat for macbeth',
      ' 0.00s  dave is turned away: sold out',
      ' 0.00s  bob gets distracted for 1100 ms',
      ' 1.00s  · /user/box-office/macbeth persisted event 2',
      ' 1.10s  bob confirms macbeth-1',
      " 1.10s  bob can't buy: no such hold",
      ' 1.10s  dave asks to hold 1 seat for macbeth',
      ' 1.10s  · /user/box-office/macbeth persisted event 3',
      ' 1.10s  dave holds macbeth-2 for 1000 ms',
      ' 1.10s  carol asks to hold 1 seat for hamlet',
      ' 1.10s  · /user/box-office/hamlet persisted event 3',
      ' 1.10s  carol holds hamlet-2 for 1000 ms',
      ' 1.10s  mallory sends a malformed request to hamlet, for -1 seats',
      ' 1.10s  · /user/box-office/hamlet failed with RangeError: seats must be a positive integer, got -1, so its parent will restart it',
      ' 1.32s  · /user/box-office/hamlet restarted after a 225 ms backoff (attempt 1)',
      ' 1.32s  · /user/box-office/hamlet recovered to event 3',
      ' 1.70s  mallory never hears back: AskTimeoutError: ask to /user/box-office got no reply within 500 ms',
      ' 1.70s  carol confirms hamlet-2',
      ' 1.70s  · /user/box-office/hamlet persisted event 4',
      ' 1.70s  carol bought 1 seat',
      " 1.70s  hamlet's restart replayed its journal, so carol's hold survived the crash",
      ' 1.70s  · /user/box-office/hamlet stopped',
      ' 1.70s  · /user/box-office/macbeth stopped',
      ' 1.70s  · /user/box-office stopped',
      ' 1.70s  the box office closes for the night',
      ' 0.00s  the next morning, a new system opens the same journal',
      ' 0.00s  · /user/box-office started',
      ' 0.00s  · /user/box-office/hamlet started',
      ' 0.00s  · /user/box-office/macbeth started',
      ' 0.00s  · /user/box-office/hamlet recovered to event 4',
      ' 0.00s  · /user/box-office/macbeth recovered to event 3',
      ' 0.00s  hamlet has sold 3 of 4 seats, with 0 held',
      ' 0.00s  macbeth has sold 0 of 2 seats, with 1 held',
      " 0.00s  dave's recovered hold gets a fresh 1000 ms, and he never comes back",
      ' 1.00s  · /user/box-office/macbeth persisted event 4',
      ' 1.10s  macbeth has sold 0 of 2 seats, with 0 held',
      ' 1.10s  · /user/box-office/hamlet stopped',
      ' 1.10s  · /user/box-office/macbeth stopped',
      ' 1.10s  · /user/box-office stopped',
      ' 1.10s  the box office is closed',
    ]);
  });

  it("keeps carol's hold in the journal, so the restarted show can sell it", async () => {
    const { first, persistence } = await run();
    expect(await stream(persistence, 'hamlet')).toEqual([
      { type: 'held', holdId: 'hamlet-1', customer: 'alice', seats: 2 },
      { type: 'confirmed', holdId: 'hamlet-1' },
      { type: 'held', holdId: 'hamlet-2', customer: 'carol', seats: 1 },
      { type: 'confirmed', holdId: 'hamlet-2' },
    ]);
    // The restarted incarnation recovered carol's hold before her confirm ran.
    expect(
      first.events.filter((e) => e.type === 'recovered' && e.path.endsWith('/hamlet')),
    ).toMatchObject([{ lastSeq: 0 }, { lastSeq: 3 }]);
  });

  it('brings every show back in a new system, where act 1 left it', async () => {
    const { first, second } = await run();
    const lastPersisted = new Map<string, number>();
    for (const e of first.events) if (e.type === 'persisted') lastPersisted.set(e.path, e.toSeq);
    const recovered = second.events.filter((e) => e.type === 'recovered');
    expect(recovered.map((e) => [e.path, e.lastSeq])).toEqual([
      ['/user/box-office/hamlet', lastPersisted.get('/user/box-office/hamlet')],
      ['/user/box-office/macbeth', lastPersisted.get('/user/box-office/macbeth')],
    ]);
    expect(recovered.map((e) => e.lastSeq)).toEqual([4, 3]);
  });

  it('gives a recovered hold a fresh timer, from when the show recovered', async () => {
    const { second, persistence } = await run();
    const released = second.events.filter((e) => e.type === 'persisted');
    expect(released).toMatchObject([
      { path: '/user/box-office/macbeth', fromSeq: 4, toSeq: 4, at: 1000 },
    ]);
    expect((await stream(persistence, 'macbeth')).at(-1)).toEqual({
      type: 'released',
      holdId: 'macbeth-2',
    });
  });

  it('restarts the crashed show with backoff, and leaves nothing behind', async () => {
    const { first, second } = await run();
    const restarts = first.events.filter((e) => e.type === 'restarted');
    expect(restarts).toMatchObject([{ path: '/user/box-office/hamlet', attempt: 1 }]);
    const delay = restarts[0]?.type === 'restarted' ? restarts[0].delayMs : 0;
    // minMs 200, with the default 0.2 jitter.
    expect(delay).toBeGreaterThanOrEqual(200);
    expect(delay).toBeLessThanOrEqual(240);
    expect(first.events.filter((e) => e.type === 'failed')).toMatchObject([
      { path: '/user/box-office/hamlet', directive: 'restart' },
    ]);
    // Nothing is left behind: every actor stopped, and no message was lost along the way.
    for (const kit of [first, second]) {
      expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([]);
      expect(kit.scheduler.pendingTimers()).toBe(0);
    }
    expect(second.events.filter((e) => e.type === 'failed')).toEqual([]);
  });

  it('gives a different backoff with a different seed', async () => {
    const one = await run(1);
    const two = await run(2);
    const restartLine = (lines: string[]) => lines.find((line) => line.includes('restarted'));
    expect(restartLine(two.lines)).not.toEqual(restartLine(one.lines));
  });
});
