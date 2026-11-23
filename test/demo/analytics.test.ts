import { describe, expect, it, vi } from 'vitest';
import { startAnalytics, type AnalyticsEnv } from '../../demo/src/site/analytics.ts';

// Milestone 3, T9: PostHog on both pages, lazily, and never under automation or without a key.
// e2e/site.spec.ts checks the built pages: its own chunk, not preloaded, and never requested
// under Playwright.

function env(overrides: Partial<AnalyticsEnv> = {}) {
  const init = vi.fn();
  const load = vi.fn(() => Promise.resolve({ init }));
  let idle: (() => void) | undefined;
  const whenIdle = vi.fn((start: () => void) => {
    idle = start;
  });
  const value: AnalyticsEnv = {
    key: 'phc_test',
    host: undefined,
    webdriver: false,
    load,
    whenIdle,
    ...overrides,
  };
  return { value, init, load, whenIdle, runIdle: () => idle?.() };
}

describe('startAnalytics', () => {
  it('loads nothing without a key', () => {
    for (const key of [undefined, '']) {
      const e = env({ key });
      startAnalytics(e.value);
      expect(e.whenIdle).not.toHaveBeenCalled();
      expect(e.load).not.toHaveBeenCalled();
    }
  });

  it('loads nothing under automation, even with a key', () => {
    const e = env({ webdriver: true });
    startAnalytics(e.value);
    expect(e.whenIdle).not.toHaveBeenCalled();
    expect(e.load).not.toHaveBeenCalled();
  });

  it('waits for the page to be idle before it loads PostHog', async () => {
    const e = env();
    startAnalytics(e.value);
    expect(e.whenIdle).toHaveBeenCalledOnce();
    expect(e.load).not.toHaveBeenCalled();

    e.runIdle();
    expect(e.load).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(e.init).toHaveBeenCalledOnce();
    });
    expect(e.init).toHaveBeenCalledWith('phc_test', {
      api_host: 'https://us.i.posthog.com',
      defaults: '2025-05-24',
      capture_pageview: true,
    });
  });

  it("uses the build's host when it has one", async () => {
    const e = env({ host: 'https://eu.i.posthog.com' });
    startAnalytics(e.value);
    e.runIdle();
    await vi.waitFor(() => {
      expect(e.init).toHaveBeenCalledOnce();
    });
    expect(e.init.mock.calls[0]?.[1]).toMatchObject({ api_host: 'https://eu.i.posthog.com' });
  });
});
