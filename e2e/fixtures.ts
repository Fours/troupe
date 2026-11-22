// What every test of the demo shares: the page opened with nothing leaving the site, at 4× so a
// lot happens in a few seconds, and checks afterwards that nothing failed.
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { SITE_HOST } from './site.ts';

export { expect };

export const test = base.extend<{ demo: Page }>({
  demo: async ({ page }, use) => {
    const offsite: string[] = [];
    const errors: string[] = [];
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
    await page.getByRole('radio', { name: '4×' }).check();

    await use(page);

    expect(offsite).toEqual([]);
    expect(errors).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  },
});

/** The narrated log. */
export const log = (page: Page) => page.getByRole('list', { name: "What's happening" });

/** Lines of the narrated log that match `text`. */
export const logLine = (page: Page, text: string | RegExp) =>
  log(page).getByRole('listitem').filter({ hasText: text });

/** Backstage's actor tree. */
export const tree = (page: Page) => page.getByRole('tree', { name: 'Actors' });

/** The tree's row for the actor called `name`, whatever its phase. */
export const row = (page: Page, name: string): Locator =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}, `) });

/** One of Backstage's panels, by its heading. */
export const panel = (page: Page, heading: string | RegExp): Locator =>
  page.getByRole('region', { name: heading });
