import { expect, test } from '@playwright/test';
import { expectLanesAligned } from './rehearsal.ts';

// Rehearsal at 375 px (milestone 3, open question 4): nothing scrolls sideways, the lanes fit the
// screen, and the scrubber and the seeds still work. Runs in the phone project only.

test('fits a phone, and still runs and scrubs', async ({ page }) => {
  await page.goto('rehearsal/');
  const run = page.getByRole('figure', { name: 'Planted: grants-held' });
  await run.scrollIntoViewIfNeeded();
  await expect(run.getByRole('img', { name: /^The moment it broke/ })).toBeVisible();
  await expectLanesAligned(run);
  for (const lane of await run.locator('svg').all()) {
    const box = await lane.boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(375);
  }
  await run.getByRole('slider', { name: 'Time in the run' }).fill('0');
  await expect(run.getByLabel('Time shown')).toHaveText('0:00.0');

  await page.getByRole('button', { name: 'Run seeds' }).click();
  await expect
    .poll(async () => Number(await page.getByLabel('Runs', { exact: true }).textContent()), {
      timeout: 20_000,
    })
    .toBeGreaterThan(2);
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByRole('figure', { name: 'One run: seed 1' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});
