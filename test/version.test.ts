import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { root } from './helpers/exports.js';

describe('VERSION', () => {
  it('is package.json’s version, which a release changes with it', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
