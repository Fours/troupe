import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests and examples import the package by name. Point it at src/, as tsconfig.json's paths do,
  // so tests never depend on a build.
  resolve: {
    alias: [
      {
        find: /^@kylewillett\/troupe$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/testkit$/,
        replacement: fileURLToPath(new URL('./src/testkit/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/persistence$/,
        replacement: fileURLToPath(new URL('./src/persistence/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/persistence\/sqlite$/,
        replacement: fileURLToPath(new URL('./src/node/sqlite/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/persistence\/postgres$/,
        replacement: fileURLToPath(new URL('./src/persistence/postgres/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/backstage\/server$/,
        replacement: fileURLToPath(new URL('./src/node/backstage/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/backstage$/,
        replacement: fileURLToPath(new URL('./src/backstage/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    passWithNoTests: true,
    // `npm test` runs unit only and needs no database. `npm run test:integration` needs Postgres
    // (npm run postgres:up). Coverage runs both, since the Postgres backend runs only there.
    // `extends: true` gives each project the aliases above.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entry points only re-export, so they have no lines worth measuring.
      exclude: [
        'src/index.ts',
        'src/testkit/index.ts',
        'src/persistence/index.ts',
        'src/node/sqlite/index.ts',
        'src/persistence/postgres/index.ts',
        'src/backstage/index.ts',
        'src/node/backstage/index.ts',
        'src/**/*.d.ts',
      ],
      thresholds: { lines: 90 },
    },
  },
});
