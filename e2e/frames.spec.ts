import { expect, test } from './fixtures.ts';

// The page keeps up: a rush of 30 customers at 4×, with Backstage drawing, and no animation frame
// takes longer than 50 ms. Chromium's long-animation-frame entries time every frame that runs
// past 50 ms, from its first task to its paint, which is what a visitor would feel as a stutter.

/** The budget for one frame, in ms. */
const BUDGET_MS = 50;

test(`a rush at 4× keeps every frame under ${String(BUDGET_MS)} ms`, async ({ demo: page }) => {
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { longFrames: number[] }).longFrames = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen.push(Math.round(entry.duration));
    }).observe({ type: 'long-animation-frame' });
  });
  // The rush lands while the steady stream runs, and the details panel follows hamlet.
  await page.getByRole('button', { name: 'Rush' }).click();
  await page.waitForTimeout(5_000);
  const long = await page.evaluate(
    () => (window as unknown as { longFrames: number[] }).longFrames,
  );
  // Every entry is past 50 ms by definition, so there should be none.
  expect(long).toEqual([]);
});
