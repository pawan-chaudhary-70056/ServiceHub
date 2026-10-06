# 22 — Service Requests

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 55

> **Scope:** the service request lifecycle. **This document owns the request state
> machine.** Other documents reference it; none redefine it.

---

## 1. Purpose

A service request is a unit of work raised from the catalog. It is the product's
central entity: the thing users create, agents work, approvers gate, SLAs measure, and
auditors reconstruct.

## 2. Data

Per `08` §4.1: `reference`, `catalogItemId`, `requesterId`, `assigneeId`, `teamId`,
`status`, `priority`, `title`, `description`, `slaPolicyId`, lifecycle timestamps, and
the captured field snapshot with `RequestFieldValue` rows.

## 3. State Machine (authoritative)

```
                        ┌──────────┐
                        │   NEW    │  created; awaiting triage
                        └────┬─────┘
                             │ triage
                             ▼
                        ┌──────────┐
              ┌─────────│ TRIAGED  │─────────┐
              │         └────┬─────┘         │
              │              │ requires      │ no approval
              │              │ approval      │ required
              │              ▼               ▼
              │      ┌───────────────┐  ┌─────────────┐
              │      │APPROVAL_PENDING│ │ IN_PROGRESS │
              │      └───────┬───────┘  └──────┬──────┘
              │              │                 │
              │      ┌───────┴───────┐         │
              │      ▼               ▼         │
              │ ┌─────────┐   ┌──────────┐     │
              │ │APPROVED │   │ REJECTED │     │
              │ └────┬────┘   └────┬─────┘     │
              │      └─────────────┼───────────┘
              │                    ▼
              │            ┌─────────────┐
              │            │ IN_PROGRESS │  (or returned to requester)
              │            └──────┬──────┘
              │                   │ fulfilment complete
              │                   ▼
              │            ┌─────────────┐
              │            │ FULFILLED   │
              │            └──────┬──────┘
              │                   │ requester confirms / auto-close
              │                   ▼
              │            ┌─────────────┐
              │            │   CLOSED    │
              │            └─────────────┘
              │
              │  from NEW / TRIAGED / APPROVAL_PENDING / IN_PROGRESS
              └────────────▶ ┌───────────┐
                             │ CANCELLED │
                             └───────────┘
```

### Transition table

| From | To | Actor | Guard | Effects |
|---|---|---|---|---|
| — | `NEW` | Requester | Catalog item `ACTIVE`; required fields valid | Reference generated · SLA policy frozen · clock started · audit · notify fulfilment team |
| `NEW` | `TRIAGED` | Agent/Lead | `request:update.*` | Priority confirmed · team confirmed |
| `TRIAGED` | `APPROVAL_PENDING` | System | Item requires approval | Workflow instantiated · clock paused · approvers notified |
| `TRIAGED` | `IN_PROGRESS` | Agent/Lead | No approval required or already granted | Assignee required before or at this point |
| `APPROVAL_PENDING` | `APPROVED` | System | All steps satisfied | Clock resumed · notify requester and team |
| `APPROVAL_PENDING` | `REJECTED` | System | A step rejected | Clock resumed · reason recorded · requester notified |
| `REJECTED` | `IN_PROGRESS` | Agent/Lead | Re-work agreed (override with reason) | Reason audited |
| `APPROVED`/`REJECTED` | `IN_PROGRESS` | System | Atomic follow-on | — |
| `IN_PROGRESS` | `FULFILLED` | Agent | All child tasks complete (or override with reason) | Fulfilment note required · clock stops · requester notified |
| `FULFILLED` | `CLOSED` | Requester or system | Confirmation, or auto-close after the configured window | Audit |
| `NEW`/`TRIAGED`/`APPROVAL_PENDING`/`IN_PROGRESS` | `CANCELLED` | Requester (own) or Lead | Not already terminal | Clock stopped · open approvals voided · audit |

**Illegal transitions return `409 ILLEGAL_TRANSITION` and change nothing.** The state
machine is enforced in the service layer and covered by a transition-matrix test — every
unordered pair from × to is asserted to be rejected.

## 4. Reference Generation

Format `REQ-YYYY-NNNNNN`, unique, allocated at creation.

**Implementation requirement:** the counter must be safe under concurrency. A
`SELECT max()+1` is a race. Use a sequence, an atomic increment, or a
unique-constraint retry loop — never a read-then-write (`09` §7).

## 5. Rules

| # | Rule |
|---|---|
| R1 | A request always has exactly one requester and one SLA policy |
| R2 | `FULFILLED` requires a fulfilment note; `CLOSED` requires `FULFILLED` first |
| R3 | Priority is chosen from the item default, adjustable by an agent/lead |
| R4 | Reassignment to another team changes the owning team and is audited |
| R5 | Requesters see public comments and status; never internal notes |
| R6 | A requester may cancel their own request until `FULFILLED`/`CLOSED` |
| R7 | Terminal states are `CLOSED` and `CANCELLED`; nothing transitions out of them |
| R8 | Overrides (force-fulfil, force-close, reopen) require a permission and a reason, and are alerted on |
| R9 | The captured field snapshot is immutable after creation |
| R10 | Attachments inherit the request's visibility; internal attachments are visible to agents only |

## 6. Comments

| Type | Visible to | Use |
|---|---|---|
| Public | Requester + agents | Progress updates, clarifying questions |
| Internal | Agents, leads, admins | Diagnosis, cost, vendor notes, escalation reasoning |

**The audience is chosen explicitly before sending** (`16` §6). The composer must never
default silently to public, and switching from internal to public must be a deliberate
act with a confirmation.

Internal notes are excluded from any export, notification, or search result available
to a requester.

## 7. Assignment

| Mode | Behaviour |
|---|---|
| Direct | Assign to a user; they receive a notification |
| Team | Assign to a team; visible in the team queue; any member may claim |
| Round-robin (Should) | Distribute within a team by configured rule |
| Unassigned | Valid in `NEW`; **must** be assigned before or at entry to `IN_PROGRESS` |

Assignment is an audited event, and reassignment records both previous and new
assignee.

## 8. SLA Integration

- The clock starts at creation and stops at `FULFILLED` (`25` §3).
- States listed in the policy's `pauseStates` (typically `APPROVAL_PENDING`) pause the
  clock.
- SLA state is **derived and displayed** in lists and on the detail header — never
  hand-set.
- A manual clock override requires `sla:clock:override`, a reason, and raises an alert
  (`25` §7).

## 9. Notifications

| Event | Recipients |
|---|---|
| Created | Fulfilment team |
| Assigned | Assignee |
| Approval requested | Designated approvers |
| Approval decided | Requester, team |
| Status changed to a requester-visible state | Requester |
| Public comment | Requester + assignee |
| Internal comment | Assignee/team only |
| SLA at risk / breached | Assignee, team lead |
| Fulfilled | Requester |
| Closed | Requester, team |

Delivery is asynchronous and recorded per recipient (`29`).

## 10. Permissions

Per `07` §3–4. Notable: requesters read only their own; agents read within team scope;
administrators and auditors read all; only designated approvers see pending approval
detail.

## 11. API

Per `11` §9. Key endpoints: create, list, get, patch, `transition`, `assign`, `cancel`,
comments, history. `transition` takes a target state and optional reason, and returns
the updated request or `409`.

## 12. UI Surfaces

| Surface | Contents |
|---|---|
| List | Reference, title, status, priority, SLA, assignee, updated; filters; saved URL state |
| Detail | Header with SLA countdown; tabs for conversation, details, tasks, approvals, attachments, history |
| Raise form | Catalog-driven fields, priority, attachment upload, review-before-submit |
| My requests | Requester-oriented, simplified view without internal columns |

## 13. Edge Cases

| Case | Behaviour |
|---|---|
| Requester deactivated mid-flight | Request stays; requester shown as deactivated; reassignment allowed |
| Assignee deactivated with open requests | Alert; team lead reassigns; no silent orphaning |
| Catalog item retired mid-flight | Request unaffected |
| SLA policy retired | In-flight request keeps its frozen policy |
| Approval step approver deactivated | Step reassigned to the team; deadline unchanged |
| Duplicate submission (double-click) | Idempotency key returns the original request, not a second one |
| Request reopened after closure | Only via an override with a reason; produces a new audit entry and restarts the clock only if policy says so |

## 14. Acceptance Criteria

1. Every transition in §3 succeeds for an entitled actor and every other pair returns
   `409`.
2. A request cannot reach `IN_PROGRESS` without an assignee.
3. A requester can never observe an internal note through any endpoint, export, or
   notification — verified by test.
4. The reference is unique under concurrent creation (500 parallel creates produce 500
   distinct references).
5. SLA state is visible in the list without opening the record.
6. Fulfilling with open child tasks is either blocked or an audited override.

## 15. Related

- `21-SERVICE-CATALOG.md` · `25-SLA-MANAGEMENT.md` · `26-APPROVAL-MANAGEMENT.md`
- `24-TASK-MANAGEMENT.md` · `29-NOTIFICATIONS-AND-MESSAGING.md`
- `07-ROLES-AND-AUTHORIZATION.md` · `31-AUDIT-LOGGING.md`
