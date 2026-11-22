import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandLine, hasUncommittedChanges, setup } from '../../bench/setup.ts';

describe('hasUncommittedChanges', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'troupe-bench-'));
    git('init', '-q');
    git('config', 'user.email', 'bench@example.test');
    git('config', 'user.name', 'bench');
    writeFileSync(join(repo, 'code.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('is false on a clean checkout', () => {
    expect(hasUncommittedChanges(repo)).toBe(false);
  });

  it("doesn't count a run's own untracked results", () => {
    for (const dir of ['docs/decisions/data/0019-x', 'bench/results/now']) {
      mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, dir, 'setup.json'), '{}\n');
    }
    expect(hasUncommittedChanges(repo)).toBe(false);
  });

  it('counts changed and untracked code', () => {
    writeFileSync(join(repo, 'new.ts'), 'export {};\n');
    expect(hasUncommittedChanges(repo)).toBe(true);
    rmSync(join(repo, 'new.ts'));
    writeFileSync(join(repo, 'code.ts'), 'export const x = 1;\n');
    expect(hasUncommittedChanges(repo)).toBe(true);
  });
});

describe('commandLine', () => {
  it('gives the npm command when npm ran it', () => {
    const npm = { npm_lifecycle_event: 'bench' };
    expect(commandLine([], npm, ['--expose-gc'])).toBe('npm run bench');
    expect(commandLine(['--only', 'ask'], npm, ['--expose-gc'])).toBe(
      'npm run bench -- --only ask',
    );
  });

  it('gives the node command otherwise, flags included', () => {
    expect(commandLine(['--quick'], {}, ['--expose-gc'])).toBe(
      'node --expose-gc bench/run.ts --quick',
    );
  });
});

describe('setup', () => {
  it('records the command, git state, host and versions, and no hostname', () => {
    const record = setup({ command: 'npm run bench', config: { runs: 10 }, postgres: '18.1' });
    expect(record.command).toBe('npm run bench');
    expect(record.git.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.git.srcCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof record.git.uncommittedChanges).toBe('boolean');
    expect(record.host.cores).toBeGreaterThan(0);
    expect(record.versions.node).toBe(process.version);
    expect(record.versions.sqlite).toMatch(/^3\.\d+\.\d+$/);
    expect(record.versions.postgres).toBe('18.1');
    expect(record.config).toEqual({ runs: 10 });
    expect(Date.parse(record.date)).not.toBeNaN();
    const { hostname } = process.env;
    if (hostname !== undefined && hostname !== '') {
      expect(JSON.stringify(record)).not.toContain(hostname);
    }
  });

  it('leaves out the Postgres version when the run had no Postgres rows', () => {
    expect(setup({ command: 'x', config: {} }).versions).not.toHaveProperty('postgres');
  });
});
