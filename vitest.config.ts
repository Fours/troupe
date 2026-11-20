import { defineConfig } from 'vitest/config';

export default defineConfig({
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
