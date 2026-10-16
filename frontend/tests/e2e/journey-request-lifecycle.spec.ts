import { expect, test } from '@playwright/test';
import { actor, missingActors, skipReason } from './support/actors';
import { signIn, signOut, uniqueTitle } from './support/sign-in';

const MISSING = missingActors(['admin', 'requester', 'agent', 'approver']);

/**
 * Journey 1 — sign in → raise a request → approval → resolution (docs/37 §7).
 *
 * This is the journey E2E owns because the **integration** is the risk: it crosses
 * identity, catalog, requests, approvals and SLA in one pass. Every step is driven
 * through the UI, and the only assertion that matters at each step is the request's
 * status, because the status is what the server decided.
 *
 * The journey provisions its own service, so it does not depend on seeded records: an
 * administrator creates a service that requires approval, and the requester orders it.
 * Two environment fixtures it cannot create for itself, because they are tenant
 * configuration rather than workflow:
 *
 *   - **at least one catalog category must exist** (the create-service form selects one);
 *   - **an approval template whose first step names `E2E_APPROVER`** must be ACTIVE, since
 *     instantiating the workflow fails if a step has no eligible approver
 *     (`approval.service.ts`).
 *
 * If the approval step is reached and no step is rendered, the failure says so explicitly,
 * because a missing template is an environment defect and not an application defect.
 */
test.describe('journey 1 — sign in, raise a request, approve it, resolve it', () => {
  test.skip(MISSING.length > 0, skipReason(MISSING));

  test('carries one request from submission to closed across four roles', async ({ page }) => {
    test.slow();

    const serviceName = uniqueTitle('Approval-gated service');
    const requestTitle = uniqueTitle('New starter laptop');
    const fulfilmentNote = `Provisioned by E2E ${Date.now()}`;

    // ---- 1. An administrator publishes a service that requires approval ------------
    await signIn(page, actor('admin'));
    await page.goto('/catalog');
    await page.getByRole('button', { name: '+ New service' }).click();

    await page.getByLabel('Name', { exact: true }).fill(serviceName);
    await page.getByLabel('Category', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Requires approval before fulfilment').check();
    await page.getByRole('button', { name: 'Create service' }).click();

    // A new service is created as a draft and is not requestable until it is active
    // (docs/21 §4) — which is also why the requester below cannot see it yet.
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('button', { name: 'Retire' })).toBeVisible();

    // ---- 2. The requester raises the request ---------------------------------------
    await signOut(page);
    await signIn(page, actor('requester'));

    await page.goto('/requests');
    await page.getByRole('button', { name: 'Raise a request' }).click();
    await page.getByLabel('Service', { exact: true }).selectOption({ label: serviceName });
    await page.getByLabel('What do you need?').fill(requestTitle);
    await page.getByRole('button', { name: 'Submit request' }).click();

    // Submitting lands on the request, which is the URL every later actor returns to.
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    const requestUrl = page.url();
    await expect(page.getByRole('heading', { name: requestTitle })).toBeVisible();
    await expect(page.getByText('NEW', { exact: true })).toBeVisible();

    // ---- 3. An agent triages it and asks for approval ------------------------------
    await signOut(page);
    await signIn(page, actor('agent'));
    await page.goto(requestUrl);

    // The control disappears once an assignee is set, which is the observable proof the
    // assignment was committed rather than merely optimistic in the client.
    await page.getByRole('button', { name: 'Assign to me' }).click();
    await expect(page.getByRole('button', { name: 'Assign to me' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Start triage' }).click();
    await expect(page.getByText('TRIAGED', { exact: true })).toBeVisible();

    // The approval workflow is instantiated on entry to APPROVAL_PENDING, so this control
    // is what makes the request approvable at all.
    await page.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page.getByText('APPROVAL_PENDING', { exact: true })).toBeVisible();

    // ---- 4. The approver approves ---------------------------------------------------
    await signOut(page);
    await signIn(page, actor('approver'));
    await page.goto(requestUrl);

    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(
      approve,
      'No approval step was rendered for the approver. An ACTIVE approval template whose step names E2E_APPROVER_EMAIL is a required fixture (docs/26 §4).',
    ).toBeVisible();
    await approve.click();
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();

    // ---- 5. The agent fulfils it ----------------------------------------------------
    await signOut(page);
    await signIn(page, actor('agent'));
    await page.goto(requestUrl);

    await page.getByRole('button', { name: 'Start work' }).click();
    await expect(page.getByText('IN_PROGRESS', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Mark fulfilled' }).click();
    await page.getByLabel('Fulfilment note (required)').fill(fulfilmentNote);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('FULFILLED', { exact: true })).toBeVisible();

    // ---- 6. The requester closes it -------------------------------------------------
    await signOut(page);
    await signIn(page, actor('requester'));
    await page.goto(requestUrl);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('CLOSED', { exact: true })).toBeVisible();

    // A closed request is terminal: every lifecycle control is gone (docs/22 §3).
    await expect(page.getByRole('button', { name: 'Start triage' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });
});
