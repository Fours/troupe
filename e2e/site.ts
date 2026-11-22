// The site under test: the local preview of the build, or a deployed site with E2E_BASE_URL.
// Requests anywhere else are blocked.
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
export const SITE_HOST = new URL(BASE_URL).hostname;
export const LOCAL = process.env.E2E_BASE_URL === undefined;
// Backstage served from Node by examples/backstage, which Playwright starts on this port. Only
// when testing locally: a deployed site has no Node server beside it.
export const SERVER_URL = 'http://127.0.0.1:7071/';
