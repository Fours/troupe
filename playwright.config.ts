import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, LOCAL } from './e2e/site.ts';

// The built demo in Chromium. `npm run test:e2e` builds first. With E2E_BASE_URL set, the same
// tests run against that site instead, and nothing is served locally.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  use: { baseURL: BASE_URL },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/phone\.spec/, /frames\.spec/],
    },
    // The phone width from milestone 3's open question 4.
    {
      name: 'phone',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
      testMatch: /phone\.spec/,
    },
    // The frame budget, measured once the others are done, since frames slow down for want of a
    // CPU while other tests run beside it, with none of the time spent in the page's own work.
    {
      name: 'frames',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /frames\.spec/,
      dependencies: ['chromium', 'phone'],
    },
  ],
  webServer: LOCAL
    ? {
        command: 'npm run demo:preview -- --port 4173 --strictPort',
        url: BASE_URL,
        reuseExistingServer: process.env.CI === undefined,
        timeout: 30_000,
      }
    : [],
});
