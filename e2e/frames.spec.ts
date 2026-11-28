import { card, expect, test } from './fixtures.ts';

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

// Festival night runs four or five systems in the page. Killing a node at 4×, through its
// failover, with Backstage drawing node-1, keeps the same budget.
test(`a kill at 4× on festival night keeps every frame under ${String(BUDGET_MS)} ms`, async ({
  festival: page,
}) => {
  // Past the start, once the shows have spread out.
  await expect
    .poll(
      async () => {
        const [m = '0', sec = '0'] = (
          (await page.getByLabel('Showtime').textContent()) ?? '0:0'
        ).split(':');
        return Number(m) * 60 + Number(sec);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(13);
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { longFrames: number[] }).longFrames = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen.push(Math.round(entry.duration));
    }).observe({ type: 'long-animation-frame' });
  });
  await card(page, 'node-2').getByRole('button', { name: 'Kill node' }).click();
  // Long enough at 4× for the leases to run out and the shows to come back elsewhere.
  await page.waitForTimeout(5_000);
  const long = await page.evaluate(
    () => (window as unknown as { longFrames: number[] }).longFrames,
  );
  expect(long).toEqual([]);
});

// Rehearsal runs its seeds in a worker, so running them flat out costs the page nothing but
// drawing the counts, and the recorded runs it draws on the way.
test(`running seeds on the rehearsal page keeps every frame under ${String(BUDGET_MS)} ms`, async ({
  page,
}) => {
  await page.goto('rehearsal/');
  await expect(page.getByRole('figure', { name: 'One run: seed 1' })).toBeVisible({
    timeout: 20_000,
  });
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { longFrames: number[] }).longFrames = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen.push(Math.round(entry.duration));
    }).observe({ type: 'long-animation-frame' });
  });
  await page.getByRole('button', { name: 'Run seeds' }).click();
  // Scroll through every drawing while the seeds run.
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(500);
  }
  await expect
    .poll(async () => Number(await page.getByLabel('Runs', { exact: true }).textContent()))
    .toBeGreaterThan(10);
  const long = await page.evaluate(
    () => (window as unknown as { longFrames: number[] }).longFrames,
  );
  expect(long).toEqual([]);
});
