// realScheduler runs on the host's real clock and event loop, so these tests use real time.
// AGENTS.md allows that here only. Waits stay at a few ms.
import { describe, expect, it } from 'vitest';
import { realScheduler } from '../src/scheduler.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('realScheduler', () => {
  it('runs runSoon tasks in FIFO order, after the current task', async () => {
    const scheduler = realScheduler();
    const order: string[] = [];
    order.push('start');
    scheduler.runSoon(() => order.push('first'));
    scheduler.runSoon(() => order.push('second'));
    order.push('end');
    expect(order).toEqual(['start', 'end']);
    await Promise.resolve();
    expect(order).toEqual(['start', 'end', 'first', 'second']);
  });

  it('fires a timer after its delay', async () => {
    const scheduler = realScheduler();
    const start = scheduler.now();
    let firedAt: number | undefined;
    scheduler.setTimer(() => (firedAt = scheduler.now()), 5);
    await sleep(30);
    expect(firedAt).toBeDefined();
    // Timers may fire a hair early against performance.now(), so allow a millisecond.
    expect((firedAt ?? 0) - start).toBeGreaterThanOrEqual(4);
  });

  it('cancels a timer, and cancelling twice is harmless', async () => {
    const scheduler = realScheduler();
    let fired = false;
    const cancel = scheduler.setTimer(() => (fired = true), 5);
    cancel();
    cancel();
    await sleep(30);
    expect(fired).toBe(false);
  });

  it('reads a monotonic clock in milliseconds', async () => {
    const scheduler = realScheduler();
    const a = scheduler.now();
    await sleep(5);
    expect(scheduler.now()).toBeGreaterThan(a);
  });

  it('reads whole milliseconds, never a fraction, and never goes back', async () => {
    const scheduler = realScheduler();
    // performance.now() almost always has a fraction, so this many readings would catch one.
    let last = scheduler.now();
    for (let i = 0; i < 200; i++) {
      const now = scheduler.now();
      expect(Number.isInteger(now)).toBe(true);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
      if (i % 50 === 0) await sleep(1);
    }
  });
});
