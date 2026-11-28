// The package's version, for what records it: a replay line says which version it came from
// (decision 0039). The core can't read package.json in every runtime (0004), so it's written here,
// and test/version.test.ts fails unless it's package.json's. Change both together on a release.

/** This package's version. */
export const VERSION = '0.4.0';
