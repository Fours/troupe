import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { root } from './helpers/exports.js';

const eslint = new ESLint({ cwd: root });

/** The severity a rule has for `file` under the repo's ESLint config: 0 off, 2 error. */
async function severity(file: string, rule: string): Promise<number> {
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, unknown>;
  };
  const setting = config.rules?.[rule];
  const level = Array.isArray(setting) ? (setting[0] as unknown) : setting;
  return level === undefined ? 0 : (level as number);
}

describe('lint config', () => {
  // A file under src/ outside src/node/, in each part of the package.
  const anywhere = [
    'src/system.ts',
    'src/persistence/memory.ts',
    'src/persistence/postgres/postgres.ts',
    'src/cluster/shard-memory.ts',
    'src/cluster/postgres/store.ts',
    'src/testkit/kit.ts',
  ];

  it('bans Node built-ins and Node globals in src/, except in src/node/', async () => {
    for (const file of anywhere) {
      expect(await severity(file, 'no-restricted-imports')).toBe(2);
      expect(await severity(file, 'no-restricted-globals')).toBe(2);
    }
    expect(await severity('src/node/sqlite/sqlite.ts', 'no-restricted-imports')).toBe(0);
    expect(await severity('src/node/sqlite/sqlite.ts', 'no-restricted-globals')).toBe(0);
  });

  it('still bans Date.now and Math.random in src/node/', async () => {
    for (const file of [...anywhere, 'src/node/sqlite/sqlite.ts']) {
      expect(await severity(file, 'no-restricted-properties')).toBe(2);
    }
  });

  it('bans Node built-ins and globals in the demo, and Date.now and Math.random in its domain', async () => {
    for (const file of ['demo/src/main.tsx', 'demo/src/domain/clock.ts']) {
      expect(await severity(file, 'no-restricted-imports')).toBe(2);
      expect(await severity(file, 'no-restricted-globals')).toBe(2);
    }
    expect(await severity('demo/src/domain/clock.ts', 'no-restricted-properties')).toBe(2);
    // The page reads real time, from animation frames.
    expect(await severity('demo/src/main.tsx', 'no-restricted-properties')).toBe(0);
    expect(await severity('demo/vite.config.ts', 'no-restricted-imports')).toBe(0);
  });

  it("applies the rules of hooks to the demo's React code", async () => {
    expect(await severity('demo/src/App.tsx', 'react-hooks/rules-of-hooks')).toBe(2);
  });
});
