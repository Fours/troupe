import { expect, panel, row, test } from './fixtures.ts';

// At 375 px (open question 4): Backstage shows one panel at a time, behind tabs, under the demo's
// controls, and nothing scrolls sideways. Runs in the phone project only.

test('shows one Backstage panel at a time, picked with tabs', async ({ demo: page }) => {
  const tabs = page.getByRole('tablist', { name: 'Backstage panels' });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'Actors' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page, 'Actors')).toBeVisible();
  await expect(panel(page, /^Details/)).toBeHidden();
  await expect(panel(page, 'Timeline')).toBeHidden();

  // Picking an actor shows its details.
  await row(page, 'macbeth').click();
  await expect(tabs.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page, 'Details: macbeth')).toBeVisible();
  await expect(panel(page, 'Actors')).toBeHidden();

  await tabs.getByRole('tab', { name: 'Timeline' }).click();
  await expect(panel(page, 'Timeline')).toBeVisible();
  await expect(panel(page, 'Timeline').getByRole('slider', { name: 'Event' })).toBeVisible();
  await expect(panel(page, /^Details/)).toBeHidden();

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});

test('the controls work at phone width', async ({ demo: page }) => {
  await page.getByRole('button', { name: 'Bad request' }).click();
  await expect(row(page, 'hamlet')).toContainText('×1');
});
