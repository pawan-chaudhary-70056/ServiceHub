import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Declared explicitly rather than spread from a config object: the plugin's
      // exported config shape has changed between major versions, and a rule that
      // silently stops being applied is worse than one that was never configured.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      // The SPA holds no business rules and no secrets. A console call that logs a
      // record or an identifier is a data leak into the browser console (docs/17).
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  // The browser bundle must never import a Node builtin or reach for a Node global:
  // it would fail at runtime and signals that server-only logic leaked into the client
  // (docs/14). Configuration in the client comes from `import.meta.env` only, which is
  // substituted at build time.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message: 'Use import.meta.env in client code, not process.env (docs/14).',
        },
        { name: 'Buffer', message: 'Node globals are unavailable in the browser (docs/14).' },
        { name: '__dirname', message: 'Node globals are unavailable in the browser (docs/14).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'The client bundle must not import Node builtins (docs/14).' },
            { name: 'path', message: 'The client bundle must not import Node builtins (docs/14).' },
            {
              name: 'crypto',
              message: 'Use Web Crypto in the browser, never the Node module (docs/14).',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-console': 'off' },
  },
);
