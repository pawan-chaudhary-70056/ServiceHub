# 24 — Task Management

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 57

> **Scope:** child units of work. **This document owns the task state machine.**
> Parents are `22` and `23`.

---

## 1. Purpose

A task splits a request or incident into smaller assigned pieces. It answers "who is
doing which bit, by when" and is the mechanism that prevents a request sitting
`IN_PROGRESS` for two weeks with no visibility into what is happening.

## 2. Data

Per `08` §4.3: `parentType` (`REQUEST`/`INCIDENT`), `parentId`, `title`,
`description`, `assigneeId`, `status`, `dueAt`, `completedAt`, `createdById`.

## 3. State Machine (authoritative)

```
    ┌────────┐
    │  TODO  │
    └───┬────┘
        │ start
        ▼
 ┌─────────────┐        ┌──────────┐
 │ IN_PROGRESS │◀──────▶│ BLOCKED  │
 └──────┬──────┘        └────┬─────┘
        │                    │ resolved
        │ complete           │
        ▼                    ▼
    ┌────────┐          (back to IN_PROGRESS)
    │  DONE  │
    └────────┘

    TODO / IN_PROGRESS / BLOCKED ──▶ CANCELLED
```

| From | To | Actor | Guard | Effects |
|---|---|---|---|---|
| — | `TODO` | Creator (agent/lead) | Parent not terminal | Parent notified of new child task |
| `TODO` | `IN_PROGRESS` | Assignee or team | Assignee set | Parent's roll-up recomputed |
| `IN_PROGRESS` | `BLOCKED` | Assignee/lead | **Blocked reason required** | Parent flagged as blocked; lead notified |
| `BLOCKED` | `IN_PROGRESS` | Assignee/lead | Blocking issue resolved | Flag cleared |
| `IN_PROGRESS` | `DONE` | Assignee | Completion note recommended | `completedAt` set; parent roll-up recomputed |
| any non-terminal | `CANCELLED` | Lead | Reason required | Removed from roll-up |
| `DONE`/`CANCELLED` | — | — | **Terminal** | Reopen requires creating a new task, unless an override is recorded |

**A blocked task must record why.** A `BLOCKED` status with no reason is worse than no
status at all — it signals a problem and conveys nothing actionable.

## 4. Roll-Up Rules

The parent's ability to close depends on its children (`FR-TASK-003`).

| Parent status | Children state | Effect |
|---|---|---|
| `IN_PROGRESS` | Any open child | Normal — the children are the work |
| Transition to `FULFILLED`/`RESOLVED` | Any open child | **Blocked** with `409` |
| Transition to `FULFILLED`/`RESOLVED` | Open children, with override | Permitted with `task:override` and a reason; audited and alerted |
| Any | All children `DONE`/`CANCELLED` | Parent may close |

The override exists because operations are messy, but it must be visible. A parent
closed over open children is a predictable source of "work quietly lost", so it is
alerted on rather than merely permitted.

## 5. Rules

| # | Rule |
|---|---|
| T1 | A task always has exactly one parent, of a permitted type |
| T2 | A task never outlives its parent's visibility: task visibility ≤ parent visibility (`07` §4) |
| T3 | Tasks don't carry their own SLA in v1 — the parent's clock is the commitment |
| T4 | Tasks are not approvable; approvals belong to the parent |
| T5 | A task's assignee need not be a member of the parent's team, but the assignment is audited |
| T6 | Terminal tasks (`DONE`/`CANCELLED`) never transition again without a recorded override |
| T7 | Deleting a task is not possible; cancel it, so the history survives |
| T8 | A parent may have at most 100 open tasks — beyond that, use a checklist field |

## 6. Due Dates

| Aspect | Rule |
|---|---|
| `dueAt` | Optional; set by the creator or suggested from the parent's SLA remaining time |
| Overdue | Derived (`dueAt` < now and not terminal); never stored as a status |
| Overdue notifications | Assignee on becoming overdue; lead on sustained overdue |
| Due date vs SLA | A task due date is a plan; the parent's SLA is the commitment. The UI must not present them as equivalent. |

## 7. Notifications

| Event | Recipients |
|---|---|
| Task created | Assignee (if set), parent assignee |
| Assigned / reassigned | New assignee |
| Blocked | Parent assignee, team lead |
| Completed | Parent assignee, creator |
| Overdue | Assignee, then lead |
| Cancelled | Assignee, creator |

## 8. Permissions

| Action | Permission |
|---|---|
| Create task on a visible parent | `task:create` (agents, leads) |
| Update own assigned task | `task:update.own` |
| Update any task in team scope | `task:update.team` |
| Cancel | `task:cancel` (leads) |
| Override parent roll-up | `task:override` (leads, admins) |

## 9. API

| Method | Path | Notes |
|---|---|---|
| POST | `/requests/{id}/tasks`, `/incidents/{id}/tasks` | Nested creation |
| GET | `/tasks` | "My tasks" view, cursor paginated |
| PATCH | `/tasks/{id}` | Title, description, due date |
| POST | `/tasks/{id}/transition` | State machine |
| POST | `/tasks/{id}/assign` | Audited |
| GET | `/tasks/{id}` | Inherits parent visibility |

## 10. UI Surfaces

| Surface | Contents |
|---|---|
| Tasks tab on parent | Checklist with status, assignee, due date; inline actions |
| My tasks page | Across all parents; grouped by due state (overdue, today, this week, later) |
| Task detail | Description, activity, assignment; rendered in a drawer from the parent context |
| Roll-up indicator | Parent header shows "3 of 5 tasks complete" with a blocked warning |

## 11. Edge Cases

| Case | Behaviour |
|---|---|
| Parent cancelled with open tasks | Tasks auto-cancel with the parent; each is audited |
| Assignee deactivated | Task returns to an unassigned state and the lead is notified |
| Task created on a terminal parent | Rejected with `409` |
| All tasks cancelled | Parent may close; roll-up reflects that no work was performed |
| Duplicate task titles under one parent | Permitted; ids disambiguate |
| Task moved between parents | Not supported in v1; cancel and recreate, preserving both records |
| Parent reopened after closure with completed tasks | Tasks remain `DONE`; new tasks are created for the reopened work |

## 12. Acceptance Criteria

1. The transition matrix permits exactly the moves in §3; every other pair returns
   `409`.
2. `BLOCKED` without a reason is rejected.
3. A parent cannot be fulfilled or resolved with open children without the override
   permission, and any override is audited and alerted.
4. Task visibility never exceeds parent visibility, verified for every role.
5. Overdue is derived correctly across time zones and is never stored as a status.

## 13. Related

- `22-SERVICE-REQUESTS.md` · `23-INCIDENT-MANAGEMENT.md` — parents and roll-up
- `29-NOTIFICATIONS-AND-MESSAGING.md` · `07-ROLES-AND-AUTHORIZATION.md`
- `09-DATA-INTEGRITY-AND-INDEXING.md` — the parent/status index
