import { defineConfig } from 'vitest/config';

// Test levels and fixtures are defined in docs/37-TESTING.md.
// Business rules are tested at the service/integration level against a REAL PostgreSQL
// instance, not a mock — see docs/37 §3. Unit and integration suites are separated by
// file location so CI can run them at different stages.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Supplies test-only environment defaults before config is imported.
    setupFiles: ['tests/setup.ts'],
    // Integration tests share a database and must not race each other.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/@types/**'],
    },
  },
});
