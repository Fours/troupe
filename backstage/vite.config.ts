import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The standalone UI that `serveBackstage` serves, built into the package's dist/backstage-ui/.
// Relative URLs, so it works wherever it's served from. The package by name is this checkout's
// src/, as in the demo.
export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@kylewillett/troupe/backstage', replacement: here('../src/backstage/index.ts') },
    ],
  },
  build: {
    outDir: here('../dist/backstage-ui'),
    // Outside the root, so Vite asks before emptying it.
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [here('..')] },
  },
});
