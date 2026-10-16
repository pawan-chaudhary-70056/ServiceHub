import { expect, test } from '@playwright/test';

/**
 * Shell smoke test.
 *
 * The four journeys E2E owns (docs/37 §7) now live beside this file, one per journey:
 *
 *   1. `journey-request-lifecycle.spec.ts`
 *   2. `journey-incident.spec.ts`
 *   3. `journey-search-authorization.spec.ts`
 *   4. `journey-catalog-fidelity.spec.ts`
 *
 * Those journeys need a deployed stack and one credential set per role, so they skip when
 * the environment is not configured. This test is what remains runnable regardless: it
 * asserts the app renders, is reachable by keyboard, and exposes no console error. It is
 * deliberately kept — a journey that skips must not leave the shell itself unverified.
 */
test.describe('application shell', () => {
  test('renders the shell and is reachable without JavaScript errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto('/');

    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('navigation')).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test('renders a not-found page for an unknown route', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');

    await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  });
});
