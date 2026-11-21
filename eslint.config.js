import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // src/globals.d.ts is in the build config only (see tsconfig.json), where tsc checks it.
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'src/globals.d.ts'] },
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
    // most slips fail to compile; this catches the ones that would still type-check.
    files: ['src/**/*.ts'],
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
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Read time from the injected Scheduler.' },
        { object: 'Math', property: 'random', message: "Draw chance from the system's random." },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
