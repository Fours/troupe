import { expect, logLine, test } from './fixtures.ts';

// The demo in a real browser: the system runs, each button does what it says in the log, and
// pausing stops time. backstage.spec.ts covers what Backstage shows of the same.

test('opens the box office, and customers arrive', async ({ demo: page }) => {
  await expect(logLine(page, 'hamlet opens with an empty journal')).toHaveCount(1);
  await expect(logLine(page, /customer-\d+ holds/).first()).toBeVisible();
});

test('Rush sends a crowd', async ({ demo: page }) => {
  await page.getByRole('button', { name: 'Rush' }).click();
  // The steady stream never has more than 12 at once, so customer-30 means the rush came.
  await expect(logLine(page, /customer-3\d /).first()).toBeVisible();
});

test('Bad request crashes hamlet, and its supervisor restarts it', async ({ demo: page }) => {
  await page.getByRole('button', { name: 'Bad request' }).click();
  await expect(logLine(page, 'hamlet failed: RangeError')).toHaveCount(1);
  await expect(logLine(page, /hamlet restarts after \d+ ms \(attempt 1\)/)).toHaveCount(1);
});

test('Journal down fails the shows, and up lets them recover', async ({ demo: page }) => {
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

test('Restart the system starts every show again from the journal', async ({ demo: page }) => {
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

test('Paused stops the clock, and ¼× runs it slower', async ({ demo: page }) => {
  const showtime = page.getByLabel('Showtime');
  await page.getByRole('radio', { name: 'Paused' }).check();
  const paused = await showtime.textContent();
  await page.waitForTimeout(500);
  await expect(showtime).toHaveText(paused ?? '');

  await page.getByRole('radio', { name: '¼×' }).check();
  await expect(showtime).not.toHaveText(paused ?? '');
});
