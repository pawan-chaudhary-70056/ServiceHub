import { expect, test } from '@playwright/test';
import { actor, missingActors, skipReason } from './support/actors';
import { signIn, signOut, uniqueTitle } from './support/sign-in';

const MISSING = missingActors(['admin', 'requester']);

/**
 * Journey 4 — an administrator edits a catalog item → a previous request is unchanged
 * (docs/37 §7).
 *
 * This is rule **C3** end to end: "field definitions are snapshotted into the request at
 * creation — editing an item must not rewrite the meaning of past answers"
 * (docs/21 §5, FR-CATALOG-005). It is a journey rather than a service test because the
 * rule spans two surfaces and a session boundary: what the administrator edits and what
 * the requester later reads are different requests, different roles and different pages.
 *
 * The assertion is deliberately two-sided. Showing the old label is not enough — the
 * renamed label must be **absent** from the request, or an implementation that renders
 * both (the snapshot and the live definition) would pass while still telling the
 * requester something false about the answers they gave.
 *
 * Fixture: at least one catalog category must exist.
 */
test.describe('journey 4 — editing a catalog item leaves past requests alone', () => {
  test.skip(MISSING.length > 0, skipReason(MISSING));

  test('keeps the snapshot a requester answered, after the definition changes', async ({
    page,
  }) => {
    test.slow();

    const serviceName = uniqueTitle('Asset intake');
    const originalLabel = 'Serial number (as requested)';
    const renamedLabel = 'Serial number (renamed)';
    const requestTitle = uniqueTitle('Onboard a laptop');
    const answer = `SN-${Date.now().toString(36).toUpperCase()}`;

    // ---- 1. An administrator publishes a service with one question -----------------
    await signIn(page, actor('admin'));
    await page.goto('/catalog');
    await page.getByRole('button', { name: '+ New service' }).click();

    await page.getByLabel('Name', { exact: true }).fill(serviceName);
    await page.getByLabel('Category', { exact: true }).selectOption({ index: 1 });
    await page.getByRole('button', { name: '+ Add field' }).click();
    await page.getByLabel('Field 1 key').fill('serial');
    await page.getByLabel('Field 1 label').fill(originalLabel);
    await page.getByRole('button', { name: 'Create service' }).click();

    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('button', { name: 'Retire' })).toBeVisible();

    // ---- 2. The requester answers the question -------------------------------------
    await signOut(page);
    await signIn(page, actor('requester'));

    await page.goto('/requests');
    await page.getByRole('button', { name: 'Raise a request' }).click();
    await page.getByLabel('Service', { exact: true }).selectOption({ label: serviceName });
    await page.getByLabel('What do you need?').fill(requestTitle);
    // The question is asked under the label the catalog carries *now*.
    await page.getByLabel(originalLabel).fill(answer);
    await page.getByRole('button', { name: 'Submit request' }).click();

    await expect(page.getByRole('heading', { name: requestTitle })).toBeVisible();
    const requestUrl = page.url();
    await expect(page.getByText(originalLabel)).toBeVisible();
    await expect(page.getByText(answer)).toBeVisible();

    // ---- 3. The administrator renames the question ---------------------------------
    await signOut(page);
    await signIn(page, actor('admin'));
    await page.goto('/catalog');
    await page.getByRole('button', { name: new RegExp(escapeForRegExp(serviceName)) }).click();
    await page.getByRole('button', { name: 'Edit service' }).click();

    const labelInput = page.getByLabel('Field 1 label');
    await expect(labelInput).toHaveValue(originalLabel);
    await labelInput.fill(renamedLabel);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Edit service' })).toBeVisible();

    // ---- 4. The past request still reads as it was answered ------------------------
    await signOut(page);
    await signIn(page, actor('requester'));
    await page.goto(requestUrl);

    await expect(page.getByText(originalLabel)).toBeVisible();
    await expect(page.getByText(answer)).toBeVisible();
    await expect(
      page.getByText(renamedLabel),
      'The renamed catalog field leaked into a request that was answered before the change (docs/21 §5 rule C3).',
    ).toHaveCount(0);
  });
});

/** Escapes a literal for `new RegExp`, so a generated name with punctuation still matches. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
