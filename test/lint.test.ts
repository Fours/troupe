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
});
