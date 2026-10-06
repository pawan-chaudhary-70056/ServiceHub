import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration (docs/37 §7).
 *
 * E2E is reserved for journeys whose *integration* is the risk — sign-in through to
 * resolution, incident handling, cross-cutting authorization, and the "editing a
 * catalog item must not rewrite an existing request" rule — not for exhaustive
 * matrices that belong at the unit or API level.
 *
 * The base URL is an environment value so the same suite runs against a locally served
 * build or a deployed staging environment. Staging is production-shaped by policy
 * (docs/35 §1) and carries anonymised data only.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    // Traces and screenshots only on failure: artifacts are for diagnosis, and a
    // screenshot of every passing test is noise that gets ignored.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
