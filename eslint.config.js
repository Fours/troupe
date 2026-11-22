import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const RESTRICTED_PROPERTIES = [
  'error',
  { object: 'Date', property: 'now', message: 'Read time from the injected Scheduler.' },
  { object: 'Math', property: 'random', message: "Draw chance from the system's random." },
];

export default tseslint.config(
  // src/globals.d.ts is in the build config only (see tsconfig.json), where tsc checks it.
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'src/globals.d.ts',
      'demo/dist/',
      'test-results/',
      'playwright-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // The core runs on any JavaScript runtime (decision 0004). The build has no Node types, so
    // most slips fail to compile; this catches the ones that would still type-check. src/node/
    // holds the Node-only entry points, the one place Node built-ins are allowed.
    files: ['src/**/*.ts'],
    ignores: ['src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'src/ must not import Node built-ins.' }] },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'src/ must not use Node globals.' },
        { name: 'Buffer', message: 'src/ must not use Node globals.' },
        { name: 'setImmediate', message: 'Schedule work through the injected Scheduler.' },
      ],
      'no-restricted-properties': RESTRICTED_PROPERTIES,
    },
  },
  {
    // Node-only code may use Node, but still reads time and chance only through what's injected
    // (decision 0003).
    files: ['src/node/**/*.ts'],
    rules: { 'no-restricted-properties': RESTRICTED_PROPERTIES },
  },
  {
    // The demo runs in the browser: no Node built-ins or globals. Its config file runs in Node.
    files: ['demo/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'The demo runs in the browser.' }] },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The demo runs in the browser.' },
        { name: 'Buffer', message: 'The demo runs in the browser.' },
      ],
    },
  },
  {
    // The domain runs on the system's virtual time and seeded random, so a seed tells the same
    // story every time (decision 0022).
    files: ['demo/src/domain/**/*.ts'],
    rules: { 'no-restricted-properties': RESTRICTED_PROPERTIES },
  },
  {
    // The rules of hooks, and effects that list what they depend on.
    files: ['demo/**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
