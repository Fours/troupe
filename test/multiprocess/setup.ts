import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from '../integration/setup.js';

/**
 * Runs once before the multi-process tests: they need Postgres, and the processes they start run
 * examples/cluster/ against dist/. `npm run test:cluster` builds first.
 */
export default async function setup(): Promise<void> {
  const dist = resolve(import.meta.dirname, '../../dist/node/cluster/index.js');
  if (!existsSync(dist)) {
    throw new Error(
      'The multi-process tests run against dist/: npm run build, or npm run test:cluster',
    );
  }
  await postgres();
}
