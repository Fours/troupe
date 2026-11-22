import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, LOCAL, SERVER_URL } from './e2e/site.ts';

// The built demo in Chromium, and Backstage served from Node by examples/backstage.
// `npm run test:e2e` builds both first. With E2E_BASE_URL set, the demo's tests run against that
// site instead, and nothing is served locally.
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
      testIgnore: [/phone\.spec/, /frames\.spec/, /server\.spec/],
    },
    // The phone width from milestone 3's open question 4.
    {
      name: 'phone',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
      testMatch: /phone\.spec/,
    },
    // serveBackstage, over HTTP, against the example's Node process.
    ...(LOCAL
      ? [
          {
            name: 'server',
            use: { ...devices['Desktop Chrome'], baseURL: SERVER_URL },
            testMatch: /server\.spec/,
          },
        ]
      : []),
    // The frame budget, measured once the others are done, since frames slow down for want of a
    // CPU while other tests run beside it, with none of the time spent in the page's own work.
    {
      name: 'frames',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /frames\.spec/,
      dependencies: ['chromium', 'phone', ...(LOCAL ? ['server'] : [])],
    },
  ],
  webServer: LOCAL
    ? [
        {
          command: 'npm run demo:preview -- --port 4173 --strictPort',
          url: BASE_URL,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 30_000,
        },
        {
          command: `node examples/backstage/main.ts --port ${new URL(SERVER_URL).port}`,
          url: SERVER_URL,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 30_000,
        },
      ]
    : [],
});
