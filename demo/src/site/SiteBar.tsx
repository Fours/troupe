// The bar both pages share: the project's name, the two pages, and GitHub and npm.
import { NPM_URL, REPO_URL } from './links.ts';
import './site.css';

/** Relative to each page, so the links work wherever the site is served from. */
const PAGES = {
  demo: { label: 'Opening night', fromDemo: './', fromWriteup: '../' },
  'how-it-works': { label: 'How it works', fromDemo: 'how-it-works/', fromWriteup: './' },
} as const;

export type Page = keyof typeof PAGES;

export function SiteBar({ page }: { page: Page }) {
  const href = (to: Page) => (page === 'demo' ? PAGES[to].fromDemo : PAGES[to].fromWriteup);
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
