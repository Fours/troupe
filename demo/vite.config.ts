import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The demo imports the package by name, pointed at this checkout's src/, so the site always runs
// the code beside it, never a published copy. The more specific entry points come first, since an
// alias matches by prefix.
const entry = (name: string, path: string) => ({ find: name, replacement: here(`../src/${path}`) });

export default defineConfig({
  root: here('.'),
  plugins: [react()],
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
  },
  server: {
    // src/ is outside the demo's root.
    fs: { allow: [here('..')] },
  },
});
