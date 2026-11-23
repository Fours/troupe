// Refuses to release unless the pushed tag names exactly the version in package.json, so a tag
// can never publish a version nobody meant to, and unless CHANGELOG.md has a dated entry for it,
// since the changelog ships in the tarball and can't be fixed after (decision 0024).
//
// Usage: node scripts/check-release-tag.ts <tag>
// In release.yml the tag is GITHUB_REF_NAME, such as v0.1.0.
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Why `tag` can't release `version`, or `undefined` if it can. */
export function releaseTagProblem(tag: string, version: string): string | undefined {
  // release.yml publishes to the `latest` dist-tag, so a prerelease would become what
  // `npm install` gets. Refuse it until the workflow learns to publish under another dist-tag.
  if (version.includes('-')) {
    return `package.json's version ${version} is a prerelease, and this workflow only publishes to latest`;
  }
  if (tag !== `v${version}`) {
    return `tag ${tag} doesn't match package.json's version ${version}: expected v${version}`;
  }
  return undefined;
}

/** Why `changelog` isn't ready to ship `version`, or `undefined` if it is. */
export function changelogProblem(changelog: string, version: string): string | undefined {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## ${escaped} \\((.*)\\)$`, 'm').exec(changelog);
  if (heading === null) return `CHANGELOG.md has no "## ${version} (YYYY-MM-DD)" entry`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(heading[1] ?? '')) {
    return `CHANGELOG.md's ${version} entry is dated "${String(heading[1])}", not YYYY-MM-DD`;
  }
  return undefined;
}

function main(tag: string | undefined): void {
  if (tag === undefined || tag === '') {
    console.error('Usage: check-release-tag.ts <tag>');
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const problem =
    releaseTagProblem(tag, pkg.version) ??
    changelogProblem(readFileSync('CHANGELOG.md', 'utf8'), pkg.version);
  if (problem !== undefined) {
    // An annotation, so the refusal shows on the run's summary page.
    console.error(`::error title=Release refused::${problem}`);
    process.exit(1);
  }
  console.log(
    `Tag ${tag} matches package.json's version ${pkg.version}, and the changelog is dated.`,
  );
}

// Run only as a script, so tests can import releaseTagProblem without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
