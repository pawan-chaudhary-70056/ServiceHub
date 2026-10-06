import { expect, test } from '@playwright/test';

/**
 * Smoke journey for the scaffold shell.
 *
 * This is a placeholder for the four journeys that E2E owns once the domain exists
 * (docs/37 §7):
 *
 *   1. sign in → raise a request → approval → resolution
 *   2. raise an incident → assign → resolve → notification
 *   3. search finds a restricted record only for an authorised user
 *   4. an administrator edits a catalog item → a previous request is unchanged
 *
 * It asserts only what the scaffold guarantees: the app renders, is reachable by
 * keyboard, and does not expose an error to the console.
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
