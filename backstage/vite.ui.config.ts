import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defineConfig, type Plugin } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const API = here('src/ui-api.ts');

// The entry point's index.d.ts: ui-api.ts's declarations as they are, which name no React type, so
// a user needs no @types/react. transpileDeclaration needs no program, and fails on anything
// that isn't a plain declaration. Built beside dist/backstage/index.d.ts, so /backstage's types
// are a relative import.
function declarations(): Plugin {
  return {
    name: 'backstage-ui-declarations',
    generateBundle() {
      this.addWatchFile(API);
      const { outputText, diagnostics = [] } = ts.transpileDeclaration(readFileSync(API, 'utf8'), {
        fileName: API,
        compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2023 },
        reportDiagnostics: true,
      });
      if (diagnostics.length > 0) {
        const text = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        this.error(`ui-api.ts isn't plain declarations: ${text.join('; ')}`);
      }
      const source = outputText.replaceAll("'@kylewillett/troupe/backstage'", "'../index.js'");
      if (source.includes('@kylewillett/')) this.error('ui-api.ts imports more than /backstage');
      this.emitFile({ type: 'asset', fileName: 'index.d.ts', source });
    },
  };
}

// The /backstage/ui entry point (decision 0045): one ES module with React and React DOM inside,
// built for production, and the styles inlined as text for mount.tsx to put in the page. It
// imports nothing, so it adds no dependency. Built after tsc, into dist/backstage/ui/, which tsc
// leaves alone since src/backstage/ has no ui/.
export default defineConfig({
  root: here('.'),
  plugins: [react(), declarations()],
  // Production, whatever NODE_ENV the build runs under: the package test builds under Vitest's
  // `test`. React picks its build by this define, which a library build leaves alone, and the JSX
  // transform must match it, since production React has no jsxDEV.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  oxc: { jsx: { development: false } },
  build: {
    lib: {
      entry: here('src/mount.tsx'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: here('../dist/backstage/ui'),
    // Outside the root, so Vite asks before emptying it.
    emptyOutDir: true,
    // Whitespace too: a library build keeps it by default so a bundler can tree-shake the output,
    // but this file exports one function, and its users load all of it.
    minify: true,
    rolldownOptions: { output: { minify: true } },
    copyPublicDir: false,
  },
});
