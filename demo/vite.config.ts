import react from '@vitejs/plugin-react';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { DATA_DIR, SOURCE_FILES, loadWriteupData } from './build/writeup-data.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The demo imports the package by name, pointed at this checkout's src/, so the site always runs
// the code beside it, never a published copy. The more specific entry points come first, since an
// alias matches by prefix.
const entry = (name: string, path: string) => ({ find: name, replacement: here(`../src/${path}`) });

// The write-up's charts are read from docs/decisions/data/ when the site builds (milestone 3, T8),
// so they can't drift from the records. A missing source throws, which fails the build.
function writeupData(): Plugin {
  const id = 'virtual:writeup-data';
  return {
    name: 'writeup-data',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      for (const file of SOURCE_FILES) this.addWatchFile(join(DATA_DIR, file));
      return `export default ${JSON.stringify(loadWriteupData())};`;
    },
  };
}

// Two pages: the demo, and the write-up at how-it-works/, which loads none of the demo.
export default defineConfig({
  root: here('.'),
  plugins: [react(), writeupData()],
  resolve: {
    alias: [
      entry('@kylewillett/troupe/testkit', 'testkit/index.ts'),
      entry('@kylewillett/troupe/persistence', 'persistence/index.ts'),
      entry('@kylewillett/troupe/backstage', 'backstage/index.ts'),
      entry('@kylewillett/troupe', 'index.ts'),
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        demo: here('index.html'),
        howItWorks: here('how-it-works/index.html'),
      },
      // Named chunks, so the build says what each one is: posthog-js on its own, loaded only when
      // the page is idle (demo/src/site/browser-analytics.ts), and what both pages share. Grouping
      // puts rolldown's runtime in a chunk of its own, a few hundred bytes, preloaded.
      output: {
        codeSplitting: {
          groups: [
            { name: 'posthog', test: /node_modules[\\/]posthog-js[\\/]/ },
            {
              name: 'site',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]|src[\\/]site[\\/]|modulepreload-polyfill/,
            },
          ],
        },
      },
    },
  },
  server: {
    // src/ is outside the demo's root.
    fs: { allow: [here('..')] },
  },
});
