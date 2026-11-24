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
        find: /^@kylewillett\/troupe\/cluster$/,
        replacement: fileURLToPath(new URL('./src/cluster/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/cluster\/postgres$/,
        replacement: fileURLToPath(new URL('./src/cluster/postgres/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/cluster\/tcp$/,
        replacement: fileURLToPath(new URL('./src/node/cluster/index.ts', import.meta.url)),
      },
      {
        find: /^@kylewillett\/troupe\/rehearsal$/,
        replacement: fileURLToPath(new URL('./src/rehearsal/index.ts', import.meta.url)),
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
          exclude: ['test/integration/**', 'test/multiprocess/**'],
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
      {
        // npm run test:cluster: real processes from examples/cluster/, against dist/, on TCP and
        // Postgres. One file at a time, so one test's processes don't slow another's failover.
        extends: true,
        test: {
          name: 'multiprocess',
          include: ['test/multiprocess/**/*.test.ts'],
          globalSetup: ['test/multiprocess/setup.ts'],
          fileParallelism: false,
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
        'src/cluster/postgres/index.ts',
        'src/backstage/index.ts',
        'src/node/backstage/index.ts',
        'src/**/*.d.ts',
      ],
      thresholds: { lines: 90 },
    },
  },
});
