import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLanesAligned } from './rehearsal.ts';
import { SITE_HOST } from './site.ts';

// Rehearsal, at rehearsal/ (milestone 5, T8): seeds run in the browser, in a worker; one run is
// drawn, with a scrubber and the log in plain words; and each planted bug's recorded failing run
// is drawn with the moment it broke marked. rehearsal-phone.spec.ts checks it at phone width, and
// frames.spec.ts that running seeds keeps every frame under budget.

const PLANTS = [
  'late-deadline',
  'early-release',
  'grants-held',
  'greets-once',
  'routes-unreachable',
  'early-reply',
];

/** Opens the page with nothing leaving the site, and checks afterwards that nothing failed. */
async function open(page: Page) {
  const offsite: string[] = [];
  const errors: string[] = [];
  await page.route(
    (url) => url.hostname !== SITE_HOST,
    async (route) => {
      offsite.push(route.request().url());
      await route.abort();
    },
  );
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('rehearsal/');
  await expect(page.getByRole('heading', { level: 1, name: 'Rehearsal' })).toBeVisible();
  return { offsite, errors };
}

const count = async (output: Locator): Promise<number> =>
  Number(((await output.textContent()) ?? '').replace(/,/g, ''));

const seconds = (shown: string | null): number => {
  const [m = '0', s = '0'] = (shown ?? '0:0').split(':');
  return Number(m) * 60 + Number(s);
};

test('runs seeds in the browser, and stops', async ({ page }) => {
  const { offsite, errors } = await open(page);
  const runs = page.getByLabel('Runs', { exact: true });
  await page.getByRole('button', { name: 'Run seeds' }).click();
  await expect.poll(() => count(runs), { timeout: 20_000 }).toBeGreaterThanOrEqual(10);
  expect(await count(page.getByLabel('Runs a second'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Keep going' })).toBeVisible();
  const stopped = await count(runs);
  expect(await count(page.getByLabel('Next seed'))).toBe(stopped + 1);
  // The real code finds nothing wrong with festival night.
  expect(await count(page.getByLabel('Problems found'))).toBe(0);
  await expect(page.getByRole('list', { name: 'Seeds that broke something' })).toHaveCount(0);
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('draws one run, and the scrubber steps through it', async ({ page }) => {
  await open(page);
  const run = page.getByRole('figure', { name: 'One run: seed 1' });
  await expect(run).toBeVisible({ timeout: 20_000 });
  const log = run.getByRole('region', { name: 'What happened' }).getByRole('listitem');
  const slider = run.getByRole('slider', { name: 'Time in the run' });
  // It opens at the end, with the whole log.
  await expect(run.getByLabel('Time shown')).toHaveText('1:00.0');
  const whole = await log.count();
  expect(whole).toBeGreaterThan(3);
  await expect(log.last()).toContainText('The run ends.');

  await slider.fill('20000');
  await expect(run.getByLabel('Time shown')).toHaveText('0:20.0');
  const early = await log.count();
  expect(early).toBeLessThan(whole);
  for (const time of await log.locator('time').allTextContents()) {
    expect(seconds(time)).toBeLessThanOrEqual(20);
  }
  await expect(run.getByText(/^At 0:20\.0: node-1 /)).toBeVisible();

  await slider.fill('0');
  await expect(log).toHaveCount(1);
  await expect(log.first()).toContainText('form a cluster');

  // Another seed, drawn on request.
  await page.getByRole('spinbutton', { name: 'Seed' }).fill('2');
  await page.getByRole('button', { name: 'Draw it' }).click();
  await expect(page.getByRole('figure', { name: 'One run: seed 2' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('figure', { name: 'One run: seed 2' })).toContainText(
    'Seed 2, contract mode',
  );
});

for (const plant of PLANTS) {
  test(`draws ${plant}'s failing run, with the moment it broke marked`, async ({ page }) => {
    await open(page);
    const run = page.getByRole('figure', { name: `Planted: ${plant}` });
    await run.scrollIntoViewIfNeeded();
    const mark = run.getByRole('img', { name: /^The moment it broke, at / });
    await expect(mark).toBeVisible();
    await expectLanesAligned(run);
    await expect(run.getByText(/^It broke at \d+:\d\d\.\d\./)).toBeVisible();
    const at = ((await mark.getAttribute('aria-label')) ?? '').replace(
      'The moment it broke, at ',
      '',
    );

    // Away from the moment, then back to it.
    await run.getByRole('slider', { name: 'Time in the run' }).fill('0');
    const log = run.getByRole('region', { name: 'What happened' }).getByRole('listitem');
    await expect(log.filter({ hasText: 'It broke:' })).toHaveCount(0);
    await run.getByRole('button', { name: 'Go to the moment it broke' }).click();
    await expect(run.getByLabel('Time shown')).toHaveText(at);
    await expect(log.filter({ hasText: 'It broke:' })).toHaveCount(1);
  });
}

test('says why one planted bug is no longer found', async ({ page }) => {
  await open(page);
  await expect(
    page.getByRole('article', { name: 'Gossip merge lets a status go backwards' }),
  ).toContainText('Not found, and that’s now expected');
});

test('runs a bug the hunt found on today’s code, which heals', async ({ page }) => {
  await open(page);
  const bug = page.getByRole('listitem', { name: 'split brain' });
  await expect(bug).toContainText('Keep the majority');
  await bug.getByRole('button', { name: 'Run it on today’s code' }).click();
  const run = bug.getByRole('figure', { name: 'Found: split brain, on today’s code' });
  await expect(run).toBeVisible({ timeout: 20_000 });
  await expect(run.getByRole('img', { name: /^The moment it broke/ })).toHaveCount(0);
  await expect(run.getByRole('region', { name: 'What went wrong on purpose' })).toContainText(
    'can’t reach',
  );
});

test('the site bar links the page, and the page loads its own code only', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'script') scripts.push(new URL(req.url()).pathname);
  });
  await open(page);
  await expect(
    page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Rehearsal' }),
  ).toHaveAttribute('aria-current', 'page');
  expect(scripts.some((s) => s.includes('/rehearsal-'))).toBe(true);
  expect(
    scripts.filter((s) => ['/demo-', '/cluster-', '/stage-'].some((n) => s.includes(n))),
  ).toEqual([]);
});
