import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The dependency direction is enforced here, not only in review (docs/03 §4, docs/38 §3):
 *
 *   routes → controllers → services → models (data access) → prisma
 *
 * The charter's backend `src/` structure has no `repositories/` directory and must not
 * be changed, so Prisma access lives in the mandated `models/` folder and is imported
 * only by `services/`. Validators, utils and integrations are leaf modules.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  // Services own business rules and authorization. They must not know about HTTP,
  // and must not reach upward into controllers or routes (docs/03 §3, docs/13).
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/controllers/**', '**/routes/**'],
              message: 'Services must not import HTTP layers (docs/03 §4).',
            },
            { group: ['express'], message: 'Services must not depend on req/res (docs/03 §4).' },
          ],
        },
      ],
    },
  },

  // Data access is downstream of everything; it must not import upward.
  {
    files: ['src/models/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/**', '**/controllers/**', '**/routes/**'],
              message: 'Data access must not depend on upper layers (docs/03 §4).',
            },
          ],
        },
      ],
    },
  },

  // Controllers must never touch Prisma directly (docs/03 §3).
  {
    files: ['src/controllers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '**/models/**'],
              message: 'Controllers must call a service, not the database (docs/03 §3).',
            },
          ],
        },
      ],
    },
  },

  // Validators, helpers and utils are pure leaf modules.
  {
    files: ['src/validators/**/*.ts', 'src/utils/**/*.ts', 'src/helpers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', 'express'],
              message: 'Leaf modules must stay free of infrastructure (docs/03 §4).',
            },
          ],
        },
      ],
    },
  },

  // Tests may reach anywhere.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-console': 'off' },
  },
);
