import { expect, panel, row, test, tree } from './fixtures.ts';

// Backstage on the demo page: the live tree, the selected actor's details and failures, each
// button as Backstage shows it, and the timeline from the mouse and the keyboard.

const SHOWS = ['hamlet', 'macbeth', 'othello', 'lear'];

test('shows the tree live, with customers coming and going', async ({ demo: page }) => {
  for (const name of ['box-office', ...SHOWS, 'sales-board', 'feed', 'crowd']) {
    await expect(row(page, name)).toBeVisible();
  }
  await expect(row(page, 'hamlet')).toHaveAttribute('aria-level', '2');
  await expect(
    tree(page)
      .getByRole('treeitem', { name: /^customer-\d+, running/ })
      .first(),
  ).toBeVisible();
  // A customer who leaves fades out before it goes.
  await expect(
    tree(page)
      .getByRole('treeitem', { name: /^customer-\d+, stopped/ })
      .first(),
  ).toBeAttached();
});

test("shows the selected actor's state, mailbox and messages", async ({ demo: page }) => {
  const details = panel(page, 'Details: hamlet');
  await expect(details.locator('.bs-value').first()).toContainText('sold');
  await expect(details.getByRole('img', { name: /Mailbox depth/ })).toBeVisible();
  await expect(details.getByRole('row').nth(1)).toBeVisible();
  await expect(details.getByText("None. It hasn't failed.")).toBeVisible();

  await row(page, 'crowd').click();
  const crowd = panel(page, 'Details: crowd');
  await expect(crowd.locator('.bs-value').first()).toContainText('sent');
  await expect(row(page, 'crowd')).toHaveAttribute('aria-selected', 'true');
});

test('the sales board hears each sale from its feed', async ({ demo: page }) => {
  await row(page, 'sales-board').click();
  const sale = panel(page, 'Details: sales-board')
    .getByRole('row')
    .filter({ hasText: 'type: "sale"' })
    .first();
  // A sale needs a customer to hold and then buy, which takes a few seconds even at 4×.
  await expect(sale.getByRole('cell').nth(1)).toHaveText('feed', { timeout: 15_000 });
});

test('Bad request shows the failure, the restart and its backoff', async ({ demo: page }) => {
  await page.getByRole('button', { name: 'Bad request' }).click();
  await expect(row(page, 'hamlet')).toContainText('×1');
  const failures = panel(page, 'Details: hamlet')
    .getByRole('list')
    .filter({ hasText: 'RangeError' });
  await expect(failures).toContainText(/Restarted after \d+ ms \(attempt 1\)/);
});

test('Bad request goes to the show picked in the tree', async ({ demo: page }) => {
  await row(page, 'lear').click();
  await expect(page.getByText('sends lear a hold for -1 seats')).toBeVisible();
  await page.getByRole('button', { name: 'Bad request' }).click();
  await expect(row(page, 'lear')).toContainText('×1');
  await expect(row(page, 'hamlet')).not.toContainText('×');
});

test('Rush fills the tree with customers', async ({ demo: page }) => {
  await page.getByRole('button', { name: 'Rush' }).click();
  // The steady stream never has more than 12 at once.
  await expect
    .poll(() =>
      tree(page)
        .getByRole('treeitem', { name: /^customer-/ })
        .count(),
    )
    .toBeGreaterThan(20);
});

test('Journal down fails every show, and up lets them recover', async ({ demo: page }) => {
  const toggle = page.getByRole('button', { name: 'Journal down' });
  await toggle.click();
  await page.getByRole('button', { name: 'Rush' }).click();
  for (const show of SHOWS) await expect(row(page, show)).toContainText(/×[2-9]/);
  await expect(panel(page, 'Details: hamlet').getByText('JournalDownError').first()).toBeVisible();

  await toggle.click();
  // Recovered: running again, with no failure waiting for its restart.
  for (const show of SHOWS) {
    await expect(row(page, show)).toHaveAttribute('data-phase', 'running', { timeout: 10_000 });
  }
});

test('Restart the system reconnects Backstage to the new one', async ({ demo: page }) => {
  const backstage = page.locator('.backstage');
  await expect(backstage).toHaveAttribute('data-connection', '1');
  await page.getByRole('button', { name: 'Bad request' }).click();
  await expect(row(page, 'hamlet')).toContainText('×1');

  await page.getByRole('button', { name: 'Restart the system' }).click();
  await expect(backstage).toHaveAttribute('data-connection', '2');
  // A new system: its hamlet hasn't failed, and it still holds what the journal kept.
  await expect(row(page, 'hamlet')).toBeVisible();
  await expect(row(page, 'hamlet')).not.toContainText('×');
  await expect(panel(page, 'Details: hamlet').locator('.bs-value').first()).toContainText('sold');
});

test.describe('the timeline', () => {
  test.beforeEach(async ({ demo: page }) => {
    // Enough of hamlet's journal to scrub, then paused, so it holds still.
    await expect(panel(page, 'Timeline').getByText(/^([4-9]|\d\d+) events/)).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('radio', { name: 'Paused' }).check();
  });

  test('scrubs with the mouse, highlights the change, and goes back to Live', async ({
    demo: page,
  }) => {
    const timeline = panel(page, 'Timeline');
    const slider = timeline.getByRole('slider', { name: 'Event' });
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    if (box === null) throw new Error('the slider has no box');
    // Drag from the live end back to the start.
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(timeline.getByRole('heading', { name: /^State after event 1,/ })).toBeVisible();
    // The first event is a hold, which adds one.
    await expect(timeline.locator('mark.bs-changed').first()).toContainText('customer');

    await timeline.getByRole('button', { name: /^3 / }).click();
    await expect(timeline.getByRole('heading', { name: /^State after event 3,/ })).toBeVisible();
    await expect(slider).toHaveAttribute('aria-valuetext', /^Event 3 of \d+/);

    await timeline.getByRole('button', { name: 'Live' }).click();
    await expect(timeline.getByRole('heading', { name: 'State now' })).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'Live' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('scrubs from the keyboard', async ({ demo: page }) => {
    const timeline = panel(page, 'Timeline');
    const slider = timeline.getByRole('slider', { name: 'Event' });
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(timeline.getByRole('heading', { name: /^State after event 1,/ })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(timeline.getByRole('heading', { name: /^State after event 2,/ })).toBeVisible();
    await expect(timeline.locator('.bs-changed, .bs-removed').first()).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(timeline.getByRole('heading', { name: /^State after event 1,/ })).toBeVisible();
  });
});

test('the tree works from the keyboard', async ({ demo: page }) => {
  await row(page, 'hamlet').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'macbeth')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'macbeth')).toBeFocused();
  await expect(panel(page, 'Details: macbeth')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'box-office')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(page, 'box-office')).toHaveAttribute('aria-selected', 'true');
});

test.describe('in a narrow tree', () => {
  // At 768 px the tree is under 20rem wide, the narrowest it gets beside the details panel.
  test.use({ viewport: { width: 768, height: 900 } });

  test('a restarting show keeps its name, phase, failures and waiting count in view', async ({
    demo: page,
  }) => {
    await page.getByRole('button', { name: 'Journal down' }).click();
    for (const show of SHOWS) await expect(row(page, show)).toContainText(/×[3-9]/);

    const treeRight = await tree(page).evaluate((el) => el.getBoundingClientRect().right);
    for (const show of SHOWS) {
      const showRow = row(page, show);
      await expect(showRow).toHaveAttribute('data-phase', /restarting|starting/);
      const fits = await showRow.evaluate((el) => {
        const part = (selector: string) => el.querySelector(selector)?.getBoundingClientRect();
        const fontSize = parseFloat(getComputedStyle(el).fontSize);
        return {
          overflows: el.scrollWidth > el.clientWidth,
          depthRight: part('.bs-depth')?.right ?? Infinity,
          nameEms: (part('.bs-name')?.width ?? 0) / fontSize,
        };
      });
      expect(fits.overflows, `${show}'s row overflows`).toBe(false);
      expect(fits.depthRight, `${show}'s waiting count`).toBeLessThanOrEqual(treeRight);
      // Whether a whole name fits depends on the platform's fonts: Linux's are wider than macOS's,
      // and can end "macbeth" in an ellipsis. Its start must always be readable.
      expect(fits.nameEms, `${show}'s name`).toBeGreaterThanOrEqual(2);
      // It makes room by dropping its journal tag.
      await expect(showRow.locator('.bs-tag')).toBeHidden();
      await expect(showRow.locator('.bs-phase')).toBeVisible();
      await expect(showRow.locator('.bs-failures')).toBeVisible();
    }
  });
});
