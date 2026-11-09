// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'reports/', 'test-results/', 'playwright-report/', 'blob-report/'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The harness re-implements the engine independently; importing app code
    // (or the app's validation library) would let the two quietly agree.
    files: ['harness/**', 'tests/e2e/**', 'tests/unit/harness/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/app/**', '**/app'], message: 'The harness must not import app code.' },
          ],
          paths: [{ name: 'zod', message: 'The harness declares its own types; no zod.' }],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
