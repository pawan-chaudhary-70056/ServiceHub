# 26 — Approval Management

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 59

> **Scope:** approving gated work. **This document owns the approval workflow model.**
> The request lifecycle that hosts it is `22`.

---

## 1. Purpose

Approvals are the governance layer: they record that an authorised person accepted
responsibility for a request proceeding, at a specific time, with a name attached.
They are not notifications and not comments — they are an auditable decision.

## 2. Data

Per `08` §4.6: `ApprovalWorkflow` (one per record) → `ApprovalStep` (`stepOrder`,
`mode`, `deadlineAt`) → `ApprovalDecision` (`approverId`, `decision`, `comment`,
`decidedAt`).

**`ApprovalDecision` is insert-only.** No update or delete path exists in the
application. A reversal is a new decision with its own timestamp; the original is never
rewritten. This is what makes an approval defensible.

## 3. Workflow Structure

```
ApprovalWorkflow (attached to one request)
  │
  ├── Step 1  mode: ALL   approvers: [manager]
  ├── Step 2  mode: ANY   approvers: [finance-a, finance-b]
  └── Step 3  mode: ALL   approvers: [security-lead]
```

| Property | Rule |
|---|---|
| Steps | Ordered; advance strictly forward |
| `mode` | `ANY` — one approval satisfies the step. `ALL` — every approver must approve |
| Approvers | At least one per step |
| Deadlines | Optional per step; action on expiry is policy-defined |
| Parallelism | Within a step, approvers decide in any order; steps are sequential |

## 4. Instantiation and Flow

```
Request reaches TRIAGED and the item requires approval
   │
   ▼
Instantiate workflow from the item's template
   │  snapshot approvers (do not resolve lazily at decision time)
   ▼
status → APPROVAL_PENDING      SLA clock PAUSED per policy (25 §3)
   │
   ▼
notify the active step's approvers (async — 29)
   │
   ▼
┬── ANY step: first approval satisfies ────────────┐
├── ALL step: every approver must approve ─────────┤
└── rejection by any approver at any step ─────────┤
                                                   ▼
                            ┌──────────────────────┴───────────────────┐
                            ▼                                          ▼
                   more steps → advance                     no more steps → APPROVED
                   (notify next step)                       (resume clock, notify requester)
                                                   │
                                            rejection → REJECTED
                                            (terminate workflow, resume clock,
                                             notify requester with the reason)
```

**Approvers are snapshotted at instantiation.** Resolving them lazily at decision time
means a role change mid-workflow silently alters who was supposed to approve — the
decision becomes unauditable.

## 5. Decision Rules

| Rule | Detail |
|---|---|
| Who may decide | Only a designated approver for the **active** step |
| Self-approval | A requester may never approve their own request, even if listed (`07` §5) |
| Admin approval | Administrators cannot approve (`07` §5) |
| Immutability | A decision cannot be edited or withdrawn; a reversal is a new decision |
| Comment | Optional on approval; **required on rejection** |
| Idempotency | Replaying the same decision request returns the original outcome rather than recording twice |
| Late decision | A decision on a superseded step returns `409`; the workflow has moved on |
| Concurrent decisions | Two approvers on an `ANY` step deciding simultaneously: exactly one advances the step (`09` §7 locking) |

## 6. Expiry and Escalation

| Policy option | Behaviour |
|---|---|
| No deadline | Step waits indefinitely; the record's SLA clock remains paused and the pause is visible |
| Deadline → escalate | Step notifies an escalation target; the original approvers remain able to decide |
| Deadline → auto-reject | Workflow terminates as rejected with `EXPIRED` recorded as the reason |
| Deadline → auto-approve | **Discouraged.** Auto-approval means the gate did not gate. Permitted only with explicit configuration, and it is audited as an automatic decision. |

Expiry never silently closes a workflow without a recorded outcome.

## 7. Rejection

Rejection at any step terminates the entire workflow immediately — remaining steps are
not evaluated. The request returns to the requester with:

- who rejected,
- when,
- the mandatory reason.

A rejected request may be re-worked by an agent/lead, which requires an override with a
reason (`22` §3). The rejection remains in the history permanently.

## 8. Rules

| # | Rule |
|---|---|
| A1 | One active workflow per record; no parallel workflows |
| A2 | Approvers are snapshotted at instantiation |
| A3 | Decisions are insert-only |
| A4 | Rejection requires a comment |
| A5 | Pending approval detail is visible only to designated approvers, leads, and admins (`FR-APPR-005`) |
| A6 | The SLA clock pause during `APPROVAL_PENDING` is policy-driven, and the paused duration is visible to the requester so "waiting on approval" is not mistaken for "waiting on the team" |
| A7 | Approving does not grant any fulfilment permission (`07` §5) |
| A8 | A deactivated approver's pending step is reassigned to the step's team, with the deadline unchanged |

## 9. Notifications

| Event | Recipients |
|---|---|
| Approval requested | Active step's approvers |
| Step advanced | Next step's approvers |
| Approved (final) | Requester, fulfilment team |
| Rejected | Requester, fulfilment team |
| Expiring soon | Active approvers |
| Expired | Requester, escalation target |
| Reassigned (approver deactivated) | New approvers, lead |

## 10. Permissions

| Action | Permission |
|---|---|
| Decide | Designated approver for the active step |
| View pending approvals | Designated approver or `approval:read.team` (lead/admin) |
| Configure templates | `admin:config` |
| Reassign a step | `approval:reassign` (lead/admin), audited |

## 11. API

| Method | Path | Notes |
|---|---|---|
| GET | `/approvals/pending` | Caller's pending decisions only |
| GET | `/requests/{id}/approvals` | Visibility rules of §8 A5 |
| POST | `/approvals/{id}/decide` | `{ decision, comment }`; idempotency key supported |
| POST | `/approvals/{id}/reassign` | Lead/admin; audited |
| GET/POST | `/admin/approval-templates` | Admin |

## 12. UI Surfaces

| Surface | Contents |
|---|---|
| Approvals inbox | Pending items with requester, item, amount/impact, age, deadline; batch-friendly |
| Decision panel | Full context: request details, prior steps and their decisions, comment box |
| Approvals tab on request | Workflow progress, who is next, current pause duration |
| Rejection dialog | Reason mandatory; warns that rejection ends the workflow |
| Template admin | Step builder with approver selection and modes |

**Design requirement:** the decision panel shows the *reason the request exists*, not
only the request id. An approver deciding from an id alone is a rubber stamp, and a
rubber-stamp approval is not a control.

## 13. Edge Cases

| Case | Behaviour |
|---|---|
| Approver list is empty at instantiation | Workflow is invalid; request creation fails with a configuration error rather than an unapprovable request |
| All approvers deactivated | Step reassigned to the team; lead alerted |
| Requester is also an approver | Excluded from the decision set for their own request (`07` §5) |
| Two approvers decide simultaneously on `ANY` | Exactly one advances; the second receives `409` |
| Approver decides after the step advanced | `409`; the late decision is not recorded |
| Request cancelled while approval pending | Workflow voided; pending steps closed with a recorded outcome |
| Record's SLA policy has no pause for `APPROVAL_PENDING` | Clock keeps running — a deliberate policy choice, surfaced in the UI as "SLA running during approval" |

## 14. Acceptance Criteria

1. An `ALL` step requires every approver; an `ANY` step requires exactly one.
2. A requester cannot approve their own request even when listed as an approver.
3. A decision cannot be modified or deleted through any endpoint.
4. Rejection without a comment is rejected with `422`.
5. Two concurrent decisions on the same step produce exactly one advance.
6. Approvers are those snapshotted at instantiation, unaffected by later role changes.
7. Pending approval detail is inaccessible to non-approvers, verified by test.
8. Every decision appears in the audit trail with actor, time and outcome.

## 15. Related

- `22-SERVICE-REQUESTS.md` — the host lifecycle and the pause integration
- `25-SLA-MANAGEMENT.md` — how approval pauses the clock
- `07-ROLES-AND-AUTHORIZATION.md` — separation of duties
- `29-NOTIFICATIONS-AND-MESSAGING.md` · `31-AUDIT-LOGGING.md`
