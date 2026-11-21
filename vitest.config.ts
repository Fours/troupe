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
    ],
  },
  test: {
    passWithNoTests: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entry points only re-export, so they have no lines worth measuring.
      exclude: ['src/index.ts', 'src/testkit/index.ts', 'src/**/*.d.ts'],
      thresholds: { lines: 90 },
    },
  },
});
