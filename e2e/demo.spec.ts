import { expect, test, type Page } from '@playwright/test';
import { SITE_HOST } from './site.ts';

// A smoke test of the built demo in a real browser: the system runs, each button does what it
// says, and pausing stops time. T5 replaces the log with Backstage and grows this suite.

const offsite: string[] = [];
const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  offsite.length = 0;
  errors.length = 0;
  // The demo has no backend: record and block anything that leaves the site.
  await page.route(
    (url) => url.hostname !== SITE_HOST,
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Rush' })).toBeEnabled();
  // Fast, so each test sees a lot happen in a few seconds.
  await page.getByRole('radio', { name: '4×' }).check();
});

test.afterEach(async ({ page }) => {
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

const log = (page: Page) => page.getByRole('list', { name: "What's happening" });
const logLine = (page: Page, text: string | RegExp) =>
  log(page).getByRole('listitem').filter({ hasText: text });

test('opens the box office, and customers arrive', async ({ page }) => {
  await expect(logLine(page, 'hamlet opens with an empty journal')).toHaveCount(1);
  await expect(logLine(page, /customer-\d+ holds/).first()).toBeVisible();
});

test('Rush sends a crowd', async ({ page }) => {
  await page.getByRole('button', { name: 'Rush' }).click();
  // The steady stream never has more than 12 at once, so customer-30 means the rush came.
  await expect(logLine(page, /customer-3\d /).first()).toBeVisible();
});

test('Bad request crashes hamlet, and its supervisor restarts it', async ({ page }) => {
  await page.getByRole('button', { name: 'Bad request' }).click();
  await expect(logLine(page, 'hamlet failed: RangeError')).toHaveCount(1);
  await expect(logLine(page, /hamlet restarts after \d+ ms \(attempt 1\)/)).toHaveCount(1);
});

test('Journal down fails the shows, and up lets them recover', async ({ page }) => {
  // Some sales first, so there's something to recover.
  await expect(logLine(page, /customer-\d+ holds/).nth(2)).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Journal down' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Rush' }).click();
  await expect(logLine(page, /failed: JournalDownError/).first()).toBeVisible();
  await expect(logLine(page, /restarts after \d+ ms \(attempt 2\)/).first()).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // The longest backoff is about 6 s of virtual time: 1.5 s at 4×.
  await expect(logLine(page, /recovers \d+ events? from the journal/).first()).toBeVisible();
});

test('Restart the system starts every show again from the journal', async ({ page }) => {
  await expect(logLine(page, /customer-\d+ holds/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Restart the system' }).click();
  // Once when the page opened, and once after the restart. A show nobody has visited yet has an
  // empty journal.
  for (const show of ['hamlet', 'macbeth', 'othello', 'lear']) {
    const recovery = new RegExp(`${show} (opens with an empty journal|recovers \\d+ events?)`);
    await expect(logLine(page, recovery)).toHaveCount(2);
  }
  await expect(logLine(page, /recovers \d+ events? from the journal/).first()).toBeVisible();
});

test('Paused stops the clock, and ¼× runs it slower', async ({ page }) => {
  const showtime = page.getByLabel('Showtime');
  await page.getByRole('radio', { name: 'Paused' }).check();
  const paused = await showtime.textContent();
  await page.waitForTimeout(500);
  await expect(showtime).toHaveText(paused ?? '');

  await page.getByRole('radio', { name: '¼×' }).check();
  await expect(showtime).not.toHaveText(paused ?? '');
});
