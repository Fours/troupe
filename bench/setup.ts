// What every results folder records about where its numbers came from, so they can be rerun or
// judged (decision 0019). Leaves out the hostname, which can identify you.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = resolve(import.meta.dirname, '..');
/** Where benchmark results go, relative to ROOT. Untracked output there is not a code change. */
export const DATA_PATHS = ['docs/decisions/data', 'bench/results'];

/** Runs git from `cwd` and returns its trimmed stdout. */
function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Whether the checkout differs from HEAD, tracked or untracked, outside the results folders. A
 * run's own output is untracked until it's committed, and mustn't count (rate-limiter found this
 * the hard way).
 */
export function hasUncommittedChanges(cwd: string = ROOT): boolean {
  const exclude = DATA_PATHS.map((p) => `:!${p}`);
  return git(['status', '--porcelain', '--', '.', ...exclude], cwd) !== '';
}

/** The command that reproduces this run, as it was typed. */
export function commandLine(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[],
): string {
  const rest = args.join(' ');
  if (env['npm_lifecycle_event'] === 'bench') return `npm run bench${rest ? ` -- ${rest}` : ''}`;
  return ['node', ...execArgv, 'bench/run.ts', ...args].join(' ');
}

/** What `setup.json` holds. */
export interface Setup {
  readonly date: string;
  readonly command: string;
  readonly git: {
    readonly commit: string;
    /** The last commit that changed src/: the code the numbers measure. */
    readonly srcCommit: string;
    readonly uncommittedChanges: boolean;
  };
  readonly host: {
    readonly os: string;
    readonly cpu: string;
    readonly cores: number;
    readonly memoryGiB: number;
  };
  readonly versions: {
    readonly node: string;
    readonly v8: string;
    readonly sqlite: string;
    readonly postgres?: string;
  };
  readonly config: Readonly<Record<string, unknown>>;
}

/** Builds `setup.json` for a run. `postgres` is the server's version, when the run used it. */
export function setup(opts: {
  command: string;
  config: Readonly<Record<string, unknown>>;
  postgres?: string;
  cwd?: string;
}): Setup {
  const cwd = opts.cwd ?? ROOT;
  const cpus = os.cpus();
  const db = new DatabaseSync(':memory:');
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
  db.close();
  return {
    date: new Date().toISOString(),
    command: opts.command,
    git: {
      commit: git(['rev-parse', 'HEAD'], cwd),
      srcCommit: git(['log', '-1', '--format=%H', '--', 'src'], cwd),
      uncommittedChanges: hasUncommittedChanges(cwd),
    },
    host: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    },
    versions: {
      node: process.version,
      v8: process.versions.v8,
      sqlite: row?.v ?? 'unknown',
      ...(opts.postgres === undefined ? {} : { postgres: opts.postgres }),
    },
    config: opts.config,
  };
}
