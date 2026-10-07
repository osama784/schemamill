import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/reports/**',
      '**/.stryker-tmp/**',
      '**/.factory/**',
    ],
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
    languageOptions: {
      // Node globals for plain scripts; the type-checked configs do not provide them.
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
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
            {
              group: ['@nestjs/*', 'reflect-metadata'],
              message:
                '@schemamill/core must stay framework-free (ADR 0005): no @nestjs/* or reflect-metadata imports',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Decorator',
          message: 'framework-free packages must not use decorators (ADR 0005)',
        },
        {
          selector: 'ImportExpression',
          message:
            'dynamic imports and import-types bypass the static boundary bans; not allowed below the server (ADR 0005)',
        },
        {
          selector: 'TSImportType',
          message:
            'dynamic imports and import-types bypass the static boundary bans; not allowed below the server (ADR 0005)',
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
            {
              group: ['@nestjs/*', 'reflect-metadata'],
              message:
                '@schemamill/postgres must stay framework-free (ADR 0005): no @nestjs/* or reflect-metadata imports',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Decorator',
          message: 'framework-free packages must not use decorators (ADR 0005)',
        },
        {
          selector: 'ImportExpression',
          message:
            'dynamic imports and import-types bypass the static boundary bans; not allowed below the server (ADR 0005)',
        },
        {
          selector: 'TSImportType',
          message:
            'dynamic imports and import-types bypass the static boundary bans; not allowed below the server (ADR 0005)',
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
            {
              group: ['@nestjs/*', 'reflect-metadata'],
              message:
                '@schemamill/cli must stay framework-free (ADR 0005): no @nestjs/* or reflect-metadata imports',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Decorator',
          message: 'framework-free packages must not use decorators (ADR 0005)',
        },
        {
          selector: 'ImportExpression',
          message:
            'dynamic imports and import-types bypass the static boundary bans; not allowed below the server (ADR 0005)',
        },
        {
          selector: 'TSImportType',
          message:
            'dynamic imports and import-types bypass the static boundary bans; not allowed below the server (ADR 0005)',
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
