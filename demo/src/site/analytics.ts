// PostHog, the portfolio's way: posthog-js loads as its own async chunk on the next idle frame, so
// it stays off the critical path of both pages. The automatic pageview fires at init, so the first
// view is still captured, a moment after load.
//
// No DOM or Vite types here, so the tests can run it under Node. browser-analytics.ts fills in
// the environment from the page and the build.

/** The part of posthog-js that the site uses. */
export interface PostHog {
  init(key: string, options: Record<string, unknown>): unknown;
}

/** What startAnalytics reads: the build's key and host, the browser, and how to load and wait. */
export interface AnalyticsEnv {
  readonly key: string | undefined;
  readonly host: string | undefined;
  readonly webdriver: boolean;
  readonly load: () => Promise<PostHog>;
  readonly whenIdle: (start: () => void) => void;
}

/** Starts PostHog once the page is idle, unless there's no key or the browser is under automation. */
export function startAnalytics(env: AnalyticsEnv): void {
  // No key, as in CI and most local builds: nothing loads. Under automation (Playwright sets
  // navigator.webdriver) a build made with a key would send test runs to PostHog, and the e2e
  // fixture fails on any request that leaves the site.
  const key = env.key;
  if (key === undefined || key === '' || env.webdriver) return;

  env.whenIdle(() => {
    void env.load().then((posthog) => {
      posthog.init(key, {
        api_host: env.host ?? 'https://us.i.posthog.com',
        defaults: '2025-05-24',
        capture_pageview: true,
      });
    });
  });
}
