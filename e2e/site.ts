// The site under test: the local preview of the build, or a deployed site with E2E_BASE_URL.
// Requests anywhere else are blocked.
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
export const SITE_HOST = new URL(BASE_URL).hostname;
export const LOCAL = process.env.E2E_BASE_URL === undefined;
