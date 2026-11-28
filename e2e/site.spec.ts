import { expect, test, type Page } from '@playwright/test';
import { LOCAL, SITE_HOST } from './site.ts';

// Every page as the deployed site serves them (milestone 3, T9): each names its own URL on
// troupe.kylewillett.com for search engines and link previews, and PostHog is a chunk of its own
// that no page waits for. Under automation it never loads.

const SITE = 'https://troupe.kylewillett.com/';
const PAGES = [
  { path: '/', url: SITE },
  { path: '/how-it-works/', url: `${SITE}how-it-works/` },
  { path: '/cluster/', url: `${SITE}cluster/` },
  { path: '/rehearsal/', url: `${SITE}rehearsal/` },
];

/** Opens a page with nothing leaving the site, and returns every URL it requested. */
async function open(page: Page, path: string) {
  const requested: string[] = [];
  await page.route(
    (url) => url.hostname !== SITE_HOST,
    (route) => route.abort(),
  );
  page.on('request', (req) => requested.push(req.url()));
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return requested;
}

for (const { path, url } of PAGES) {
  test(`${path} names its own URL in its canonical link and og:url`, async ({ page }) => {
    await open(page, path);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', url);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', url);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /\S/);
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /\S/);
  });

  test(`${path} loads PostHog's chunk lazily, and not at all under automation`, async ({
    page,
    request,
  }) => {
    const requested = await open(page, path);
    // Past the idle callback's 2 s timeout, when PostHog would have started.
    await page.waitForTimeout(2500);
    expect(requested.filter((u) => u.includes('posthog'))).toEqual([]);

    // The page preloads only what it runs at once, so PostHog isn't among its scripts or preloads.
    const scripts = await page
      .locator('script[src], link[rel="modulepreload"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? el.getAttribute('href')));
    expect(scripts.filter((s) => s?.includes('posthog'))).toEqual([]);

    // The chunk every page shares imports it dynamically.
    const site = scripts.find((s) => s !== null && /\/assets\/site-[\w-]+\.js$/.test(s));
    expect(site, 'the shared site chunk').toBeDefined();
    const code = await (await request.get(site ?? '')).text();
    expect(code).toMatch(/import\(`\.\/posthog-[\w-]+\.js`\)/);
    // The deployed site was built with demo/.env.local, so it counts visits. Local and CI builds
    // may have no key.
    if (!LOCAL) expect(code).toContain('phc_');
  });
}
