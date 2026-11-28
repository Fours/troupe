import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { LOCAL } from './site.ts';

// The published /backstage/ui, as a page that isn't built with React would use it: the built
// dist/backstage/ui/index.js, imported by a plain module script beside dist/'s core and
// /backstage, on real actor systems in the page (decision 0045). The demo's pages import the UI
// from source, so this is the test of the file that ships. Nothing but the page and dist/ is
// served, and anything else is blocked.

const ORIGIN = 'http://embed.test';
const DIST = new URL('../dist/', import.meta.url);

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Embedded Backstage</title></head>
  <body>
    <main id="here"><p id="own">The page's own words.</p></main>
    <script type="module" src="/page.js"></script>
  </body>
</html>`;

// The page: a system with one actor, Backstage mounted on it with the selection kept by the page,
// and a restart that replaces the system, as the demo's "Restart the system" does.
const SCRIPT = `
import { actor, createActorSystem, silentLogger } from '/dist/index.js';
import { backstage } from '/dist/backstage/index.js';
import { mountBackstage } from '/dist/backstage/ui/index.js';

const greeter = actor({ initial: 0, receive: (count) => count + 1 });
const start = (name) => {
  const system = createActorSystem({ name, logger: silentLogger });
  system.spawn(greeter, 'greeter-' + name);
  return system;
};

let system = start('first');
const options = (client) => ({
  client,
  onSelect: (path) => window.picks.push(path),
  explain: { tree: 'Words from the page.' },
});
window.picks = [];
window.mountBackstage = mountBackstage;
window.options = () => options(backstage(system));
window.ui = mountBackstage(document.getElementById('here'), window.options());
window.restart = () => {
  void system.terminate();
  system = start('second');
  window.ui.update({ client: backstage(system) });
};
window.ready = true;
`;

declare global {
  interface Window {
    ready: boolean;
    picks: string[];
    mountBackstage: typeof import('@kylewillett/troupe/backstage/ui').mountBackstage;
    options: () => import('@kylewillett/troupe/backstage/ui').BackstageUiOptions;
    ui: import('@kylewillett/troupe/backstage/ui').MountedBackstage;
    restart: () => void;
  }
}

const row = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Actors' })
    .getByRole('treeitem', { name: new RegExp(`^${name}, `) });

/** The page, served with dist/, with anything else recorded and blocked. */
async function opened(page: Page, use: () => Promise<void>) {
  const offsite: string[] = [];
  const errors: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      offsite.push(url.href);
      await route.abort();
    } else if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: PAGE });
    } else if (url.pathname === '/page.js') {
      await route.fulfill({ contentType: 'text/javascript', body: SCRIPT });
    } else if (url.pathname.startsWith('/dist/')) {
      const file = new URL(url.pathname.slice('/dist/'.length), DIST);
      await route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.ready);

  await use();

  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
}

test.skip(!LOCAL, 'tests the built package, not a deployed site');

test('mounts in the element the page gives it, beside what was there', async ({ page }) => {
  await opened(page, async () => {
    await expect(row(page, 'greeter-first')).toBeVisible();
    await expect(page.locator('#here > #own')).toHaveText("The page's own words.");
    await expect(page.locator('#here > div > .backstage')).toBeVisible();
    // The page's words after Backstage's own, under the panel they're for.
    await expect(page.getByRole('region', { name: 'Actors' })).toContainText(
      'Words from the page.',
    );
    // Its styles came with it: the grid lays the panels out side by side.
    await expect(page.locator('style[data-troupe-backstage]')).toHaveCount(1);
    await expect(page.locator('.bs-grid')).toHaveCSS('display', 'grid');
  });
});

test('the page owns the selection', async ({ page }) => {
  await opened(page, async () => {
    await row(page, 'greeter-first').click();
    expect(await page.evaluate(() => window.picks)).toEqual(['/user/greeter-first']);
    // Picked, but not selected until the page says so.
    await expect(row(page, 'greeter-first')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.ui.update({ selected: '/user/greeter-first' });
    });
    await expect(row(page, 'greeter-first')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Details: greeter-first' })).toBeVisible();

    await page.evaluate(() => {
      window.ui.update({ selected: undefined });
    });
    await expect(row(page, 'greeter-first')).toHaveAttribute('aria-selected', 'false');
    // The words the page set are still there: an update changes only what it names.
    await expect(page.getByRole('region', { name: 'Actors' })).toContainText(
      'Words from the page.',
    );
  });
});

test('a new client starts over on the new system', async ({ page }) => {
  await opened(page, async () => {
    await expect(row(page, 'greeter-first')).toBeVisible();
    await page.evaluate(() => {
      window.restart();
    });
    await expect(row(page, 'greeter-second')).toBeVisible();
    await expect(row(page, 'greeter-first')).toHaveCount(0);
  });
});

test('unmounts, with its styles, and mounts again in the same element', async ({ page }) => {
  await opened(page, async () => {
    await expect(row(page, 'greeter-first')).toBeVisible();
    const twice = await page.evaluate(() => {
      try {
        window.mountBackstage(document.body.querySelector('#here') as Element, window.options());
        return 'mounted';
      } catch (err) {
        return `${(err as Error).name}: ${(err as Error).message}`;
      }
    });
    expect(twice).toBe('Error: mountBackstage: Backstage is already mounted in this element');

    const after = await page.evaluate(() => {
      window.ui.unmount();
      window.ui.unmount();
      try {
        window.ui.update({ selected: undefined });
        return 'updated';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(after).toBe('MountedBackstage.update: Backstage was unmounted');
    await expect(page.locator('#here > *')).toHaveCount(1);
    await expect(page.locator('#here > #own')).toBeVisible();
    await expect(page.locator('style[data-troupe-backstage]')).toHaveCount(0);

    await page.evaluate(() => {
      window.ui = window.mountBackstage(
        document.body.querySelector('#here') as Element,
        window.options(),
      );
    });
    await expect(row(page, 'greeter-first')).toBeVisible();
    await expect(page.locator('style[data-troupe-backstage]')).toHaveCount(1);
  });
});

test('puts its styles in a shadow root when it is mounted in one', async ({ page }) => {
  await opened(page, async () => {
    const styles = await page.evaluate(() => {
      const host = document.createElement('div');
      document.body.append(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const inner = document.createElement('div');
      shadow.append(inner);
      const ui = window.mountBackstage(inner, window.options());
      const counts = {
        shadow: shadow.querySelectorAll('style[data-troupe-backstage]').length,
        document: document.querySelectorAll('style[data-troupe-backstage]').length,
      };
      ui.unmount();
      return { ...counts, after: shadow.querySelectorAll('style[data-troupe-backstage]').length };
    });
    expect(styles).toEqual({ shadow: 1, document: 1, after: 0 });
  });
});

test('throws on invalid options as they are passed in', async ({ page }) => {
  await opened(page, async () => {
    const errors = await page.evaluate(() => {
      const element = document.createElement('div');
      const good = window.options();
      const attempt = (run: () => unknown): string => {
        try {
          run();
          return 'no error';
        } catch (err) {
          return `${(err as Error).name}: ${(err as Error).message}`;
        }
      };
      // Wrong on purpose, so cast past the types, as a page in plain JavaScript could pass them.
      const mount = window.mountBackstage as (element: unknown, options: unknown) => unknown;
      return [
        attempt(() => mount('#here', good)),
        attempt(() => mount(element, { ...good, client: {} })),
        attempt(() => mount(element, { ...good, selected: 7 })),
        attempt(() => mount(element, { ...good, onSelect: undefined })),
        attempt(() => mount(element, { ...good, explain: { sidebar: 'no such panel' } })),
        attempt(() => mount(element, { ...good, explain: { tree: 7 } })),
        attempt(() => mount(element, { ...good, selection: '/user/a' })),
        attempt(() => {
          window.ui.update({ client: null } as unknown as { client: never });
        }),
        // A failed update changes nothing, and the element took no Backstage of its own.
        String(element.childElementCount),
      ];
    });
    expect(errors).toEqual([
      'TypeError: mountBackstage: element must be an element',
      'TypeError: mountBackstage: client must be a BackstageClient, with connect and request',
      "TypeError: mountBackstage: selected must be an actor's path or undefined",
      'TypeError: mountBackstage: onSelect must be a function',
      'TypeError: mountBackstage: explain has no panel sidebar',
      'TypeError: mountBackstage: explain.tree must be text',
      'TypeError: mountBackstage: unknown option selection',
      'TypeError: MountedBackstage.update: client must be a BackstageClient, with connect and request',
      '0',
    ]);
    await expect(row(page, 'greeter-first')).toBeVisible();
  });
});
