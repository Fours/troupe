// Both pages' entries call this once, after they render.
import { startAnalytics } from './analytics.ts';

/** Starts PostHog for this page, with the key the build read from demo/.env.local. */
export function initAnalytics(): void {
  startAnalytics({
    key: import.meta.env.VITE_PUBLIC_POSTHOG_KEY,
    host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
    webdriver: navigator.webdriver,
    // A dynamic import, so posthog-js is its own chunk and neither page waits for it.
    load: () => import('posthog-js').then((module) => module.default),
    whenIdle: (start) => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(start, { timeout: 2000 });
      } else {
        window.setTimeout(start, 1);
      }
    },
  });
}
