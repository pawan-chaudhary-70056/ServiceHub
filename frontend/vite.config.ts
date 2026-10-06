import react from '@vitejs/plugin-react';
// `vitest/config` re-exports Vite's `defineConfig` with the `test` block typed, so the
// test configuration below is type-checked rather than silently ignored.
import { defineConfig } from 'vitest/config';

/**
 * Vite + Vitest configuration.
 *
 * The dev server proxies `/api` to the backend so the browser sees a single origin and
 * CORS is not involved in development. In production the same relative base is served
 * by the edge/load balancer, so the client code does not change between environments.
 *
 * Tests: unit and component tests are co-located next to the code they test
 * (`*.test.tsx`), per the structure resolution in the charter §3.1. End-to-end specs
 * live in `tests/e2e/` and are run by Playwright, not Vitest.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // In development the API runs beside the dev server (charter §3, docker-compose).
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // production source maps are not exposed (docs/17)
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/vitest.setup.ts'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/@types/**'],
    },
  },
});
