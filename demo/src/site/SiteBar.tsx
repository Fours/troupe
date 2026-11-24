// The bar every page shares: the project's name, the pages, and GitHub and npm.
import { NPM_URL, REPO_URL } from './links.ts';
import './site.css';

/** Each page's folder under the site's root, and its label. */
const PAGES = {
  demo: { label: 'Opening night', folder: '' },
  cluster: { label: 'Festival night', folder: 'cluster/' },
  'how-it-works': { label: 'How it works', folder: 'how-it-works/' },
} as const;

export type Page = keyof typeof PAGES;

/** Relative to each page, so the links work wherever the site is served from. */
function relative(from: Page, to: Page): string {
  const up = PAGES[from].folder === '' ? '' : '../';
  return `${up}${PAGES[to].folder}` || './';
}

export function SiteBar({ page }: { page: Page }) {
  const href = (to: Page) => relative(page, to);
  return (
    <header className="site-bar">
      <a className="brand" href={href('demo')}>
        Troupe
      </a>
      <nav aria-label="Site">
        {(Object.keys(PAGES) as Page[]).map((to) => (
          <a key={to} href={href(to)} aria-current={to === page ? 'page' : undefined}>
            {PAGES[to].label}
          </a>
        ))}
        <a href={REPO_URL}>GitHub</a>
        <a href={NPM_URL}>npm</a>
      </nav>
    </header>
  );
}
