import { expect, test, type Page } from '@playwright/test';
import { SERVER_URL } from './site.ts';

// Backstage served from Node: examples/backstage runs opening night on real time and SQLite with
// serveBackstage, and the same UI as the demo page follows it over server-sent events and posts.

const SERVER_HOST = new URL(SERVER_URL).host;
const SHOWS = ['hamlet', 'macbeth', 'othello', 'lear'];

const row = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Actors' })
    .getByRole('treeitem', { name: new RegExp(`^${name}, `) });

test('shows opening night live from Node, over HTTP', async ({ page }) => {
  const offsite: string[] = [];
  const errors: string[] = [];
  // The page needs nothing but the server: record and block anything else.
  await page.route(
    (url) => url.host !== SERVER_HOST,
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  page.on('pageerror', (err) => errors.push(err.message));
  // A Content-Security-Policy violation shows up only as a console error.
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');
  await expect(page).toHaveTitle('Backstage · Troupe');
  await expect(page.getByRole('status')).toHaveText('Live');

  // The tree, from the hello and the stream of events after it.
  for (const name of ['box-office', ...SHOWS, 'sales-board', 'feed', 'crowd']) {
    await expect(row(page, name)).toBeVisible();
  }
  await expect(
    page
      .getByRole('tree', { name: 'Actors' })
      .getByRole('treeitem', { name: /^customer-\d+, / })
      .first(),
  ).toBeVisible();

  // A show's state, from a request.
  await row(page, 'hamlet').click();
  const details = page.getByRole('region', { name: 'Details: hamlet' });
  await expect(details.locator('.bs-value').first()).toContainText('sold');

  // The example sends hamlet one bad request ten seconds in. A page opened later still sees it,
  // in the hello's history.
  const failures = details.getByRole('list').filter({ hasText: 'RangeError' });
  await expect(failures).toContainText(/Restarted after \d+ ms \(attempt 1\)/, {
    timeout: 20_000,
  });

  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});
