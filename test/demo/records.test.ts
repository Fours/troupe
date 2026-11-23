import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECORDS, recordUrl } from '../../demo/src/writeup/records.ts';

// Milestone 3, T8: every claim in the write-up links to a decision record. Record ids are a
// type, so a link to a missing record fails typecheck. These check the list against
// docs/decisions/, and the page's source for citations. e2e/writeup.spec.ts checks the rendered
// page's links.

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8');

const RECORD_FILES = readdirSync(root('docs/decisions/'))
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

const WRITEUP = read('demo/src/writeup/WriteUp.tsx');
const cited = (source: string) => [...source.matchAll(/<Record id="(\d{4})"/g)].map((m) => m[1]);

describe("the write-up's record links", () => {
  it('list exactly the records in docs/decisions/', () => {
    expect(Object.values(RECORDS).sort()).toEqual(RECORD_FILES);
  });

  it('key each record by its number', () => {
    for (const [id, slug] of Object.entries(RECORDS)) expect(slug.startsWith(`${id}-`)).toBe(true);
  });

  it('point at the record on GitHub', () => {
    expect(recordUrl('0007')).toBe(
      'https://github.com/Fours/troupe/blob/main/docs/decisions/0007-microtask-wake-macrotask-yield.md',
    );
  });

  it('cite every record somewhere in the page', () => {
    expect([...new Set(cited(WRITEUP))].sort()).toEqual(Object.keys(RECORDS).sort());
  });

  it('cite at least one record in every section', () => {
    const sections = WRITEUP.split('<section id="').slice(1);
    const listed = [...WRITEUP.matchAll(/^ {2}\['([a-z-]+)', '/gm)].map((m) => m[1]);
    expect(sections.map((s) => s.slice(0, s.indexOf('"')))).toEqual(listed);
    expect(listed).toHaveLength(9);
    for (const section of sections) {
      const body = section.slice(0, section.indexOf('</section>'));
      expect(cited(body), `section ${body.slice(0, body.indexOf('"'))}`).not.toEqual([]);
    }
  });
});

describe('links to the write-up', () => {
  // Until the site is live (T9), they point at the page's source.
  const SOURCE = 'demo/src/writeup/WriteUp.tsx';

  it('the README links to it', () => {
    expect(read('README.md')).toContain(`](${SOURCE})`);
  });

  it("docs/decisions/README.md says it's the public write-up, and links to it", () => {
    const readme = read('docs/decisions/README.md');
    expect(readme).toContain('public write-up');
    expect(readme).toContain(`](../../${SOURCE})`);
  });
});
