# RILL-WALKTHROUGH

**Flow: raise a service request and carry it to closed**

One end-to-end user-facing flow through ServiceHub — the React + Vite SPA
(`frontend/`) against the Express API (`backend/`). It exercises service catalog,
requests, approvals and the request lifecycle, which is the flow the project's own
E2E journey (`frontend/tests/e2e/journey-request-lifecycle.spec.ts`) treats as the
integration risk. Use test data only.

## Before you start

- Local stack is running (see `README.md`): `docker compose up -d postgres redis mailpit`,
  backend `npm run dev` (http://localhost:4000), frontend `npm run dev` (http://localhost:5173).
- You can sign in at `/login` with test accounts that hold the requester, agent, approver
  and catalog-manage permissions (see **Missing inputs**).

## Steps

1. Sign in at `/login`, then open `/catalog`.
   *Expected:* the Service catalog lists the active services you can request.

2. Confirm the service you will order is `ACTIVE` and flagged *requires approval*
   (an administrator can create one from the catalog screen).
   *Expected:* the service appears in the requestable list.

3. Open `/requests` and click **Raise a request**.
   *Expected:* the raise form opens with a **Service** picker.

4. Choose that service in **Service**, type `New starter laptop` in **What do you need?**,
   and complete any required fields.
   *Expected:* **Submit request** becomes enabled once a service and a title are present.

5. Click **Submit request**.
   *Expected:* the app navigates to the new request at `/requests/<id>` and its status is `NEW`.

6. As an agent, open that same request and click **Assign to me**.
   *Expected:* the button disappears and the Assignee fact shows you.

7. Click **Start triage**.
   *Expected:* status changes to `TRIAGED`.

8. Click **Send for approval**.
   *Expected:* status changes to `APPROVAL_PENDING` and the approval step is shown.

9. As the approver, open the request and click **Approve**.
   *Expected:* status changes to `APPROVED`.

10. As the agent, click **Start work**.
    *Expected:* status changes to `IN_PROGRESS`.

11. Click **Mark fulfilled**, type a fulfilment note, then click **Confirm**.
    *Expected:* status changes to `FULFILLED`.

12. As the requester, click **Close**.
    *Expected:* status changes to `CLOSED`, and every lifecycle control (Start triage,
    Cancel, …) is gone because the request is terminal.

## Test data

- Request title: `New starter laptop` (any unique text works; the list is not seeded with requests).
- Service: an `ACTIVE` catalog service with *requires approval* enabled.
- Roles exercised: requester, agent (`request:update.assigned`), approver, and an
  administrator with `catalog:manage` if you need to create the service.
- No passwords, tokens or customer data are used.

## Missing inputs

- **A public app URL.** This walkthrough runs on `localhost` (`http://localhost:5173`);
  no public URL has been supplied, so the Rill link carries no `&url=` parameter.
- **Test accounts.** The sign-in credentials for the requester, agent and approver are
  unknown to this walkthrough and are deliberately not invented.
- **Approval template.** An `ACTIVE` approval template whose first step names an eligible
  approver must exist, or step 8's approval step will not render.

Because the app only runs on localhost, a cloud Rill run cannot reach it. To record it
yourself, use the manual recorder at
<https://userill.dev/record?utm_source=freebuff&utm_medium=paid&utm_campaign=rill>, or drive
an existing browser with the agent quickstart at
<https://userill.dev/docs/agent-quickstart?utm_source=freebuff&utm_medium=paid&utm_campaign=rill>.

## Open in Rill

[Open your walkthrough in Rill](https://userill.dev/freebuff?utm_source=freebuff&utm_medium=paid&utm_campaign=rill&bfcid=bfc_1.eyJpZCI6ImY3OTY1MDdiLWYwNmYtNDY4Ny04Mjc2LWM0MWNiMTc0OTI1YSIsImMiOiIxNDQyMTUzOS1kYjNiLTQ1YzEtYjQ5OC1hYTMxOTFmNDkxYzAiLCJrIjoiNDU4ODZlNWEtYzkyZC00ZDUxLTg1ZjgtYzc4YTRmMTY3ZWYwIiwiaWF0IjoxNzkyMDU1NDQ0fQ.Axd6HLdaQErhbtQK7Hx5BOKAS3UFSifnS3oSHlJn7Gk#task=ServiceHub%20walkthrough%3A%20raise%20a%20service%20request%20and%20carry%20it%20to%20closed%20%28test%20data%20only%29.%0A%0A1.%20Sign%20in%20at%20%2Flogin%2C%20then%20open%20%2Fcatalog.%20Expected%3A%20the%20service%20catalog%20lists%20active%20services.%0A2.%20Confirm%20a%20service%20that%20requires%20approval%20is%20ACTIVE%20%28an%20admin%20creates%20one%20if%20needed%29.%20Expected%3A%20it%20is%20requestable.%0A3.%20Open%20%2Frequests%20and%20click%20%22Raise%20a%20request%22.%20Expected%3A%20the%20raise%20form%20appears.%0A4.%20Pick%20that%20service%20in%20%22Service%22%2C%20type%20%22New%20starter%20laptop%22%20in%20%22What%20do%20you%20need%3F%22%2C%20and%20fill%20any%20required%20fields.%20Expected%3A%20%22Submit%20request%22%20becomes%20enabled.%0A5.%20Click%20%22Submit%20request%22.%20Expected%3A%20the%20app%20opens%20the%20new%20request%20at%20%2Frequests%2F%3Cid%3E%20with%20status%20NEW.%0A6.%20As%20an%20agent%2C%20open%20that%20request%20and%20click%20%22Assign%20to%20me%22.%20Expected%3A%20the%20button%20disappears%20and%20the%20assignee%20is%20you.%0A7.%20Click%20%22Start%20triage%22.%20Expected%3A%20status%20TRIAGED.%0A8.%20Click%20%22Send%20for%20approval%22.%20Expected%3A%20status%20APPROVAL_PENDING%20and%20an%20approval%20step%20is%20shown.%0A9.%20As%20the%20approver%2C%20open%20the%20request%20and%20click%20%22Approve%22.%20Expected%3A%20status%20APPROVED.%0A10.%20As%20the%20agent%2C%20click%20%22Start%20work%22.%20Expected%3A%20status%20IN_PROGRESS.%0A11.%20Click%20%22Mark%20fulfilled%22%2C%20type%20a%20fulfilment%20note%2C%20click%20%22Confirm%22.%20Expected%3A%20status%20FULFILLED.%0A12.%20As%20the%20requester%2C%20click%20%22Close%22.%20Expected%3A%20status%20CLOSED%20and%20all%20lifecycle%20buttons%20are%20gone.)

> Your walkthrough is prepared. No recording has been made yet. In Rill, review the steps, add a public app URL, and choose Sign up to run if you need an account. The walkthrough uses Interact mode. Press Run to start it.
