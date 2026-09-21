import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // node:test returns a promise that the test runner owns, not the test file.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', name: 'test', package: 'node:test' }] },
      ],
    },
  },
  {
    // Boundaries: core is the base of the dependency graph and imports no other package.
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@schemamill/*'],
              message: '@schemamill/core must not import other schemamill packages.',
            },
          ],
        },
      ],
    },
  },
  {
    // Boundaries: postgres may import only core.
    files: ['packages/postgres/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@schemamill/cli', '@schemamill/server'],
              message: '@schemamill/postgres may import only @schemamill/core.',
            },
          ],
        },
      ],
    },
  },
  {
    // Boundaries: cli may import only core and postgres.
    files: ['packages/cli/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@schemamill/server'],
              message: '@schemamill/cli must not import @schemamill/server.',
            },
          ],
        },
      ],
    },
  },
  {
    // Boundaries: server may import only core and postgres.
    files: ['packages/server/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@schemamill/cli'],
              message: '@schemamill/server must not import @schemamill/cli.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
