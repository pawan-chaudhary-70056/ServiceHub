import { expect, test } from '@playwright/test';
import { actor, missingActors, skipReason } from './support/actors';
import { signIn, signOut, uniqueTitle } from './support/sign-in';

const MISSING = missingActors(['requester', 'agent']);

/**
 * Journey 2 — raise an incident → assign → resolve → notification (docs/37 §7).
 *
 * The risk this journey covers is the **outbound half**: a status change is only useful if
 * the person who reported the incident learns about it. So the journey does not stop at
 * `RESOLVED`; it signs the reporter back in and requires the notification to be there,
 * which exercises the outbox, the worker's render step and the in-app centre together
 * (docs/29 §5).
 *
 * The reporter's priority is derived from impact and urgency (`docs/23` §3), so the
 * journey asserts the derived value rather than setting it — a client that could set a
 * priority directly would be the defect.
 */
test.describe('journey 2 — raise an incident, assign it, resolve it, be told', () => {
  test.skip(MISSING.length > 0, skipReason(MISSING));

  test('resolves an incident and notifies the reporter', async ({ page }) => {
    test.slow();

    const incidentTitle = uniqueTitle('Checkout is failing');

    // ---- 1. A member reports the incident ------------------------------------------
    await signIn(page, actor('requester'));
    await page.goto('/incidents');
    await page.getByRole('button', { name: 'Report an incident' }).click();

    await page.getByLabel('What is broken?').fill(incidentTitle);
    await page
      .getByLabel('Description')
      .fill('Customers cannot complete checkout; every payment attempt times out.');
    await page.getByLabel('Impact').selectOption('HIGH');
    await page.getByLabel('Urgency').selectOption('HIGH');

    // Impact × urgency = CRITICAL by the published matrix (`docs/23` §3).
    await expect(page.getByText('CRITICAL', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Report incident' }).click();

    await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
    const incidentUrl = page.url();
    await expect(page.getByRole('heading', { name: incidentTitle })).toBeVisible();
    await expect(page.getByText('NEW', { exact: true })).toBeVisible();

    // ---- 2. An agent assigns it, which is the NEW → IN_PROGRESS edge ---------------
    await signOut(page);
    await signIn(page, actor('agent'));
    await page.goto(incidentUrl);

    await page.getByRole('button', { name: 'Assign to me' }).click();
    // "Triage / assign" is a single edge guarded by "assignee set" (`docs/23` §4), so
    // assignment is what moves the incident into progress.
    await expect(page.getByText('IN_PROGRESS', { exact: true })).toBeVisible();

    // ---- 3. The agent resolves it, which requires a summary ------------------------
    await page.getByRole('button', { name: 'Resolve' }).click();
    await page
      .getByLabel('Resolution summary (required)')
      .fill('Raised the payment-provider timeout and replayed the failed transactions.');
    await page.getByRole('button', { name: 'Resolve incident' }).click();
    await expect(page.getByText('RESOLVED', { exact: true })).toBeVisible();

    // ---- 4. The reporter is told ----------------------------------------------------
    await signOut(page);
    await signIn(page, actor('requester'));

    // The bell is the in-app half of the notification (`docs/29` §5). Delivery is
    // asynchronous — a worker renders and writes it — so a poll is legitimate here and a
    // fixed sleep would not be.
    await expect
      .poll(async () => page.getByLabel(/^Notifications, \d+ unread$/).count(), {
        message: 'The reporter was never notified that their incident was resolved.',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByText(/An incident you reported|resolved/i).first()).toBeVisible();
  });
});
