// Checks what `npm pack` would publish: dist/, the README, the licence, the changelog and
// package.json, and nothing else. Every entry point, the table SQL and the Backstage UI must be
// there, and the package must have no dependencies of any kind that users would install. Run
// after `npm run build`, from a clean dist/: tsc never deletes what an older build left.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const TOP_LEVEL = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json']);

// What dist/ may hold: tsc's JavaScript and declarations, write-sql.ts's SQL, and the UI's Vite
// build. Source maps would point at src/, which doesn't ship, so the build makes none.
const DIST_FILE = /^dist\/(?:backstage-ui\/.+|.+\.(?:js|d\.ts|sql))$/;

interface Pkg {
  exports: Record<string, { types: string; import: string }>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[];
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Pkg;

// Every file each export points at, the files tsc can't make, and the top-level files.
const required = [
  ...Object.values(pkg.exports).flatMap((target) => [target.types, target.import]),
  'dist/node/sqlite/schema.sql',
  'dist/persistence/postgres/schema.sql',
  'dist/backstage-ui/index.html',
  ...TOP_LEVEL,
].map((path) => path.replace(/^\.\//, ''));

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
const [pack] = JSON.parse(output) as { files: { path: string }[] }[];
const files = (pack?.files ?? []).map((file) => file.path);

const problems = [
  ...files
    .filter((path) => !TOP_LEVEL.has(path) && !DIST_FILE.test(path))
    .map((path) => `ships a file it shouldn't: ${path}`),
  ...required.filter((path) => !files.includes(path)).map((path) => `doesn't ship ${path}`),
];
if (!files.some((path) => /^dist\/backstage-ui\/assets\/.+\.js$/.test(path))) {
  problems.push("doesn't ship the Backstage UI's script");
}
// No runtime or peer dependencies (decision 0017): drivers are the user's own.
for (const field of [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
] as const) {
  const value = pkg[field];
  const count = Array.isArray(value) ? value.length : Object.keys(value ?? {}).length;
  if (count > 0) problems.push(`has ${field}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-pack: ${problem}`);
  process.exit(1);
}
console.log(`check-pack: ${String(files.length)} files, all expected`);
