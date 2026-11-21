import { describe, expect, it } from 'vitest';
import { narrator } from '../../examples/box-office/narrate.ts';
import { runScenario } from '../../examples/box-office/scenario.ts';
import { createTestKit } from '../../src/testkit/kit.js';

/** Runs the example's scenario on virtual time, and returns the narration. */
async function run(seed = 1) {
  const kit = createTestKit({ seed, system: { name: 'box-office' } });
  const lines: string[] = [];
  await runScenario({
    system: kit.system,
    narrator: narrator(
      () => kit.scheduler.now(),
      (line) => lines.push(line),
    ),
    sleep: (ms) => kit.advance(ms),
    shutdown: () => kit.shutdown(),
  });
  return { kit, lines };
}

describe('the box office example', () => {
  it('tells the same story every time, on virtual time', async () => {
    const { lines } = await run();
    expect(lines).toEqual([
      ' 0.00s  · /user/box-office started',
      ' 0.00s  · /user/box-office/hamlet started',
      ' 0.00s  · /user/box-office/macbeth started',
      ' 0.00s  alice asks to hold 2 seats for hamlet',
      ' 0.00s  alice holds hamlet-1 for 1000 ms',
      ' 0.00s  alice confirms hamlet-1',
      ' 0.00s  alice bought 2 seats',
      ' 0.00s  bob asks to hold 2 seats for macbeth',
      ' 0.00s  bob holds macbeth-1 for 1000 ms',
      ' 0.00s  dave asks to hold 1 seat for macbeth',
      ' 0.00s  dave is turned away: sold out',
      ' 0.00s  bob gets distracted for 1100 ms',
      ' 1.10s  bob confirms macbeth-1',
      " 1.10s  bob can't buy: no such hold",
      ' 1.10s  dave asks to hold 1 seat for macbeth',
      ' 1.10s  dave holds macbeth-2 for 1000 ms',
      ' 1.10s  carol asks to hold 1 seat for hamlet',
      ' 1.10s  carol holds hamlet-2 for 1000 ms',
      ' 1.10s  mallory sends a malformed request to hamlet, for -1 seats',
      ' 1.10s  · /user/box-office/hamlet failed with RangeError: seats must be a positive integer, got -1, so its parent will restart it',
      ' 1.32s  · /user/box-office/hamlet restarted after a 225 ms backoff (attempt 1)',
      ' 1.70s  mallory never hears back: AskTimeoutError: ask to /user/box-office got no reply within 500 ms',
      ' 1.70s  carol confirms hamlet-2',
      " 1.70s  carol can't buy: no such hold",
      " 1.70s  hamlet's restart wiped its holds and sales. Persistent actors, in milestone 2, fix that.",
      ' 1.70s  · /user/box-office/hamlet stopped',
      ' 1.70s  · /user/box-office/macbeth stopped',
      ' 1.70s  · /user/box-office stopped',
      ' 1.70s  the box office is closed',
    ]);
  });

  it('restarts the crashed show with backoff, and leaves nothing behind', async () => {
    const { kit } = await run();
    const restarts = kit.events.filter((e) => e.type === 'restarted');
    expect(restarts).toMatchObject([{ path: '/user/box-office/hamlet', attempt: 1 }]);
    const delay = restarts[0]?.type === 'restarted' ? restarts[0].delayMs : 0;
    // minMs 200, with the default 0.2 jitter.
    expect(delay).toBeGreaterThanOrEqual(200);
    expect(delay).toBeLessThanOrEqual(240);
    expect(kit.events.filter((e) => e.type === 'failed')).toMatchObject([
      { path: '/user/box-office/hamlet', directive: 'restart' },
    ]);
    // Nothing is left behind: every actor stopped, and no message was lost along the way.
    expect(kit.events.filter((e) => e.type === 'deadLetter')).toEqual([]);
    expect(kit.scheduler.pendingTimers()).toBe(0);
  });

  it('gives a different backoff with a different seed', async () => {
    const one = await run(1);
    const two = await run(2);
    const restartLine = (lines: string[]) => lines.find((line) => line.includes('restarted'));
    expect(restartLine(two.lines)).not.toEqual(restartLine(one.lines));
  });
});
