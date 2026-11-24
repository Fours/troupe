import type { Page } from '@playwright/test';
import { card, expect, logLine, panel, row, showsOn, test, tree } from './fixtures.ts';

// Festival night at /cluster/ (milestone 4, T9): three nodes selling seats, each button, the node
// picker and Backstage's cluster panel, in Chromium at 4×.

/** At 4×, a failover's few virtual seconds are about two real ones, plus the page's own pace. */
const FAILOVER = { timeout: 20_000 };

/** Showtime, in virtual seconds. */
async function showtime(page: Page): Promise<number> {
  const text = (await page.getByLabel('Showtime').textContent()) ?? '0:00.0';
  const [minutes = '0', seconds = '0'] = text.split(':');
  return Number(minutes) * 60 + Number(seconds);
}

/** Waits until the shows have spread out over the first three nodes, about 12 virtual seconds in. */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => showtime(page), FAILOVER).toBeGreaterThan(13);
}

test('three nodes sell seats for a dozen shows between them', async ({ festival: page }) => {
  for (const address of ['node-1', 'node-2', 'node-3']) {
    await expect(card(page, address)).toContainText('up');
  }
  // Every show opens at once, and spreads out as the nodes find each other.
  await expect(async () => {
    const counts = await Promise.all(
      ['node-1', 'node-2', 'node-3'].map((a) => showsOn(page, a).count()),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(12);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  }).toPass(FAILOVER);
  await expect(logLine(page, /bought \d seats? for/).first()).toBeVisible(FAILOVER);
  await expect(card(page, 'node-4')).toHaveCount(0);
});

test('Kill node strands its shows, then they fail over to the others', async ({
  festival: page,
}) => {
  // Settled on its desired nodes: node-2's shows are its own from here on.
  await settled(page);
  await expect(showsOn(page, 'node-2').first()).toBeVisible();
  await card(page, 'node-2').getByRole('button', { name: 'Kill node' }).click();
  const node2 = card(page, 'node-2');
  await expect(node2).toHaveAttribute('data-state', 'killed');
  await expect(node2.locator('.stranded').first()).toBeVisible();
  await expect(logLine(page, 'You pull the plug on node-2')).toBeVisible();

  await expect(logLine(page, 'node-2 has stopped answering.')).toBeVisible(FAILOVER);
  await expect(
    logLine(page, /fails? over to node-[13], \d\.\d s after node-2 went/).first(),
  ).toBeVisible(FAILOVER);
  await expect(logLine(page, /is back on node-[13]/).first()).toBeVisible(FAILOVER);
  await expect(node2).toContainText('No shows.', FAILOVER);
  await expect(logLine(page, "Nobody has heard from node-2: it's declared down.")).toBeVisible(
    FAILOVER,
  );
  // Every show is running again, on the two that are left.
  await expect(async () => {
    const counts = await Promise.all(['node-1', 'node-3'].map((a) => showsOn(page, a).count()));
    expect((counts[0] ?? 0) + (counts[1] ?? 0)).toBe(12);
  }).toPass(FAILOVER);
});

test('Restart node brings it back, and its shows move back to it', async ({ festival: page }) => {
  await settled(page);
  const node2 = card(page, 'node-2');
  await node2.getByRole('button', { name: 'Kill node' }).click();
  await expect(node2).toContainText('No shows.', FAILOVER);
  await node2.getByRole('button', { name: 'Restart node' }).click();
  await expect(logLine(page, 'node-2 starts again')).toBeVisible();
  await expect(node2).toHaveAttribute('data-state', 'up', FAILOVER);
  await expect(node2).toContainText('start 2');
  await expect(logLine(page, 'node-2 is up again.')).toBeVisible(FAILOVER);
  await expect(logLine(page, / to node-2\.$/).first()).toBeVisible(FAILOVER);
  await expect(showsOn(page, 'node-2').first()).toBeVisible(FAILOVER);
});

test('Add a node moves some shows to it, up to five nodes', async ({ festival: page }) => {
  const add = page.getByRole('button', { name: 'Add a node' });
  await add.click();
  await expect(card(page, 'node-4')).toBeVisible();
  await expect(logLine(page, 'node-4 joins the festival.')).toBeVisible();
  await expect(logLine(page, / to node-4\.$/).first()).toBeVisible(FAILOVER);
  await expect(showsOn(page, 'node-4').first()).toBeVisible(FAILOVER);
  await add.click();
  await expect(card(page, 'node-5')).toBeVisible();
  await expect(add).toBeDisabled();
});

test('Leave gracefully hands every show off, and no customer gives up', async ({
  festival: page,
}) => {
  await settled(page);
  const node3 = card(page, 'node-3');
  await page.getByRole('button', { name: 'Rush' }).click();
  await node3.getByRole('button', { name: 'Leave gracefully' }).click();
  await expect(logLine(page, 'node-3 is leaving.')).toBeVisible();
  await expect(logLine(page, 'node-3 has left.')).toBeVisible(FAILOVER);
  await expect(node3).toHaveAttribute('data-state', 'left', FAILOVER);
  await expect(node3).toContainText('No shows.');
  await expect(node3.getByRole('button', { name: 'Restart node' })).toBeVisible();
  await expect(logLine(page, 'A rush: 30 customers arrive at once.')).toBeVisible();
  // Long enough for any ask the leave lost to have timed out, at 3 virtual seconds.
  await page.waitForTimeout(2_000);
  await expect(logLine(page, 'gave up waiting')).toHaveCount(0);
});

test('the node picker shows Backstage for one node at a time', async ({ festival: page }) => {
  // node-1 to begin with: its cluster panel and its sharding tree.
  await expect(panel(page, 'Cluster: node-1')).toBeVisible();
  const members = panel(page, 'Cluster: node-1').getByRole('table', { name: 'Members' });
  await expect(members.getByRole('row')).toHaveCount(5);
  await expect(members).toContainText('this node');
  await expect(
    panel(page, 'Cluster: node-1').getByRole('list', { name: 'show shards' }).getByRole('listitem'),
  ).toHaveCount(32);
  await expect(row(page, 'show')).toBeVisible();
  await expect(
    tree(page)
      .getByRole('treeitem', { name: /^shard \d+, / })
      .first(),
  ).toBeVisible();

  const picker = page.getByRole('group', { name: 'Look inside' });
  await picker.getByRole('radio', { name: 'node-3' }).check();
  await expect(panel(page, 'Cluster: node-3')).toBeVisible();
  await picker.getByRole('radio', { name: "the crowd's node" }).check();
  await expect(panel(page, 'Cluster: crowd')).toBeVisible();
  await expect(row(page, 'crowd')).toBeVisible();
  await expect(row(page, 'box-office')).toBeVisible();
  await expect(panel(page, 'Cluster: crowd')).toContainText('this node only routes');

  // A killed node can't be picked, and one that's picked freezes as it was.
  await picker.getByRole('radio', { name: 'node-2' }).check();
  await expect(panel(page, 'Cluster: node-2')).toBeVisible();
  await card(page, 'node-2').getByRole('button', { name: 'Kill node' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'node-2 was killed' })).toBeVisible();
  await expect(picker.getByRole('radio', { name: 'node-2' })).toBeDisabled();
  await expect(panel(page, 'Cluster: node-2')).toBeVisible();

  // From another node, node-2 goes unreachable, then down, and its shards move.
  await picker.getByRole('radio', { name: 'node-1' }).check();
  const node2Row = panel(page, 'Cluster: node-1')
    .getByRole('table', { name: 'Members' })
    .getByRole('row', { name: /node-2/ });
  await expect(node2Row).toHaveAttribute('data-status', 'down', FAILOVER);
  await expect(node2Row).toHaveAttribute('data-reachable', 'false');
});

test('the site bar links every page, and the page loads none of opening night', async ({
  festival: page,
}) => {
  const scripts = await page
    .locator('script[src], link[rel="modulepreload"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? ''));
  expect(scripts.some((s) => s.includes('/cluster-'))).toBe(true);
  expect(scripts.filter((s) => s.includes('/demo-') || s.includes('/howItWorks-'))).toEqual([]);
  await expect(page).toHaveTitle('Troupe · Festival night');

  const bar = page.getByRole('navigation', { name: 'Site' });
  await expect(bar.getByRole('link', { name: 'Festival night' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await bar.getByRole('link', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'How Troupe works' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Site' })
    .getByRole('link', { name: 'Festival night' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Festival night' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Site' })
    .getByRole('link', { name: 'Opening night' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Opening night' })).toBeVisible();
});
