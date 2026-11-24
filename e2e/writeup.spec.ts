import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { SITE_HOST } from './site.ts';

// The write-up, "How Troupe works", at how-it-works/ (milestone 3, T8). It opens with a summary,
// cites a decision record in every section, draws its four charts, and loads none of the demo.
// writeup-phone.spec.ts checks it at phone width.

const RECORD_IDS = readdirSync(fileURLToPath(new URL('../docs/decisions/', import.meta.url)))
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .map((f) => f.slice(0, 4))
  .sort();

const RECORD_URL =
  /^https:\/\/github\.com\/Fours\/troupe\/blob\/main\/docs\/decisions\/(\d{4})-[a-z0-9-]+\.md$/;

/** Opens the write-up with nothing leaving the site, and records the scripts it loads. */
async function open(page: Page) {
  const offsite: string[] = [];
  const scripts: string[] = [];
  const errors: string[] = [];
  await page.route(
    (url) => url.hostname !== SITE_HOST,
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  page.on('request', (req) => {
    if (req.resourceType() === 'script') scripts.push(new URL(req.url()).pathname);
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('how-it-works/');
  await expect(page.getByRole('heading', { level: 1, name: 'How Troupe works' })).toBeVisible();
  return { offsite, scripts, errors };
}

test('opens with a summary, before the first section', async ({ page }) => {
  const { offsite, errors } = await open(page);
  await expect(page).toHaveTitle('How Troupe works');
  const summary = page.getByRole('region', { name: 'In short' });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('actors');
  // The summary is for anyone: no code in it but the install command.
  await expect(summary.locator('code')).toHaveText(['npm install @kylewillett/troupe']);
  const order = await page.locator('article h2').evaluateAll((hs) => hs.map((h) => h.textContent));
  expect(order[0]).toBe('In short');
  expect(order).toHaveLength(10);
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('cites a decision record in every section, and every record somewhere', async ({ page }) => {
  await open(page);
  const sections = page.locator('article section[id]');
  await expect(sections).toHaveCount(9);
  for (const section of await sections.all()) {
    await expect(section.locator('a[data-record]').first()).toBeAttached();
  }
  const links = await page
    .locator('a[data-record]')
    .evaluateAll((as) => as.map((a) => [a.getAttribute('data-record'), a.getAttribute('href')]));
  for (const [id, href] of links) {
    const match = RECORD_URL.exec(href ?? '');
    expect(match?.[1], String(href)).toBe(id);
  }
  expect([...new Set(links.map(([id]) => id))].sort()).toEqual(RECORD_IDS);
});

test('the contents link to every section', async ({ page }) => {
  await open(page);
  const contents = page.getByRole('navigation', { name: 'Contents' }).getByRole('link');
  await expect(contents).toHaveCount(9);
  for (const link of await contents.all()) {
    const target = (await link.getAttribute('href')) ?? '';
    await expect(page.locator(`section${target}`)).toHaveCount(1);
  }
});

test('draws four charts, each with its numbers in a table', async ({ page }) => {
  await open(page);
  const figures = page.locator('figure[data-figure]');
  await expect(figures).toHaveCount(4);
  for (const figure of await figures.all()) {
    const chart = figure.getByRole('img');
    await expect(chart).toHaveAttribute('aria-label', /\d/);
    const table = figure.getByRole('table');
    await expect(table).toBeHidden();
    await figure.getByText('Show the numbers').click();
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveCount(4);
    await expect(figure.locator('figcaption a[data-record]')).toHaveCount(1);
  }
  // The log-scale chart draws a dot per row, the others bars.
  await expect(page.locator('[data-figure="backends"] circle.mark')).toHaveCount(6);
  await expect(page.locator('[data-figure="lock"] path.mark')).toHaveCount(3);
});

test('a chart row shows its median and range on hover', async ({ page }) => {
  await open(page);
  const chart = page.locator('[data-figure="lock"] .chart');
  await chart.locator('.chart-row').first().hover();
  await expect(chart.locator('.chart-tip')).toContainText('Median 1,551');
});

test('loads none of the demo', async ({ page }) => {
  const { scripts } = await open(page);
  expect(scripts.some((s) => s.includes('/howItWorks-'))).toBe(true);
  expect(scripts.filter((s) => s.includes('/demo-') || s.includes('/cluster-'))).toEqual([]);
});

test('the site bar links the pages', async ({ page }) => {
  await open(page);
  const bar = page.getByRole('navigation', { name: 'Site' });
  await expect(bar.getByRole('link', { name: 'How it works' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await bar.getByRole('link', { name: 'Opening night' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Opening night' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Site' })
    .getByRole('link', { name: 'How it works' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'How Troupe works' })).toBeVisible();
});

test('works from the keyboard', async ({ page }) => {
  await open(page);
  const toggle = page.locator('[data-figure="yield"] summary');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-figure="yield"]').getByRole('table')).toBeVisible();
});
