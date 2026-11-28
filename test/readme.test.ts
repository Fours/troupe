import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { root } from './helpers/exports.js';

// The README's Rehearsal section, as written, against src/: its ts blocks, in order, typecheck as
// a user's code, with Node's types and the editor config's strict options, and run.
// scripts/smoke-published.sh runs the first block from npm.

const ENTRIES: Record<string, string> = {
  '@kylewillett/troupe': 'src/index.js',
  '@kylewillett/troupe/persistence': 'src/persistence/index.js',
  '@kylewillett/troupe/rehearsal': 'src/rehearsal/index.js',
};

/** The ts blocks of the README's `## heading` section, its subsections included. */
function blocks(heading: string): string[] {
  const readme = readFileSync(`${root}README.md`, 'utf8');
  const start = readme.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`README.md has no ## ${heading}`);
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

/** `code` with the package's entry points as paths into src/. */
function onSource(code: string): string {
  return code.replace(/from '(@kylewillett\/troupe[^']*)'/g, (_whole, specifier: string) => {
    const path = ENTRIES[specifier];
    if (path === undefined) throw new Error(`no source for ${specifier}`);
    return `from '${root}${path}'`;
  });
}

/** Diagnostics for `file`, as the editor config checks it, with the package's names mapped to src/. */
function typecheck(file: string): string[] {
  const configPath = `${root}tsconfig.json`;
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const prog = ts.createProgram([file], { ...parsed.options, noEmit: true });
  return ts
    .getPreEmitDiagnostics(prog, prog.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

// Outside the repo, so nothing but the README's own words is in the file, in a folder that's an
// ES module package, as a user's would be.
const dir = mkdtempSync(join(tmpdir(), 'troupe-readme-'));
writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the README’s Rehearsal section', () => {
  const code = blocks('Rehearsal');
  const written = join(dir, 'written.ts');
  writeFileSync(written, code.join('\n'));
  const file = join(dir, 'rehearsal.ts');
  writeFileSync(file, onSource(code.join('\n')));

  it('has the example and the replay', () => {
    expect(code).toHaveLength(2);
    expect(code[0]).toContain('await rehearse(bank');
    expect(code[1]).toContain('await replay(bank');
  });

  it('typechecks, with the editor config’s strict options', () => {
    expect(typecheck(written)).toEqual([]);
  });

  it('runs, and its seeds pass', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await import(file);
      expect(log.mock.calls.map((call) => call.join(' '))).toEqual(['20 seeds, 0 failed']);
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
