import { expect, test } from '@playwright/test';
import { actor, missingActors, skipReason } from './support/actors';
import { searchToken, signIn, signOut, uniqueTitle } from './support/sign-in';

const MISSING = missingActors(['requester', 'outsider']);

/**
 * Journey 3 — search finds a restricted record only for an authorised user (docs/37 §7).
 *
 * This is the **cross-cutting authorization** journey, and it is only meaningful against
 * the real stack: the same query must return different results for two different sessions.
 * A mocked API cannot prove it, and a unit test on the search service cannot prove the
 * predicate reaches the endpoint.
 *
 * The record is provisioned by the journey itself: the requester raises a request with a
 * token that appears nowhere else, so a hit is unambiguous and a miss is not "the data was
 * not seeded".
 *
 * Fixture: an ACTIVE catalog item must exist for the requester to order.
 */
test.describe('journey 3 — a restricted record is found only by an authorised user', () => {
  test.skip(MISSING.length > 0, skipReason(MISSING));

  test('hides another member’s request from search and shows it to the requester', async ({
    page,
  }) => {
    test.slow();

    const title = uniqueTitle('Payroll access review');
    const token = searchToken(title);

    // ---- 1. The requester raises a request whose title is unique to this run ---------
    await signIn(page, actor('requester'));
    await page.goto('/requests');
    await page.getByRole('button', { name: 'Raise a request' }).click();
    await page.getByLabel('Service', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('What do you need?').fill(title);
    await page.getByRole('button', { name: 'Submit request' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    // ---- 2. A member who cannot read it does not find it ----------------------------
    await signOut(page);
    await signIn(page, actor('outsider'));
    await page.goto('/search');
    await page.getByLabel('Search terms').fill(token);

    // The record is absent, not greyed out or marked restricted: the API never discloses
    // that a record exists but is withheld (docs/30 §2.3 S1, docs/17 §5).
    await expect(page.getByText('No matching records.')).toBeVisible();

    // ---- 3. The requester finds it ---------------------------------------------------
    await signOut(page);
    await signIn(page, actor('requester'));
    await page.goto('/search');
    await page.getByLabel('Search terms').fill(token);

    await expect(
      page.getByRole('link', { name: new RegExp(escapeForRegExp(title)) }),
    ).toBeVisible();
  });
});

/** Escapes a literal for `new RegExp`, so a title containing punctuation still matches. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
