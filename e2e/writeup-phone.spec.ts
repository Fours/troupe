import { expect, test } from '@playwright/test';

// The write-up at 375 px (milestone 3, open question 4): nothing scrolls sideways, tables
// included, and each chart puts its labels above its bars. Runs in the phone project only.

test('fits a phone, with its tables open', async ({ page }) => {
  await page.goto('how-it-works/');
  await expect(page.getByRole('region', { name: 'In short' })).toBeVisible();
  for (const summary of await page.getByText('Show the numbers').all()) await summary.click();
  await expect(page.getByRole('table')).toHaveCount(4);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});

test('charts fit the screen and stack their labels', async ({ page }) => {
  await page.goto('how-it-works/');
  for (const chart of await page.locator('.chart svg').all()) {
    const box = await chart.boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(375);
    // Stacked, every label starts at the chart's left edge.
    const anchors = await chart
      .locator('.chart-row .axis-label')
      .evaluateAll((ts) => ts.map((t) => t.getAttribute('text-anchor')));
    expect(new Set(anchors)).toEqual(new Set(['start']));
  }
});
