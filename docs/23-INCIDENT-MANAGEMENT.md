# 23 — Incident Management

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 56

> **Scope:** unplanned service disruption. **This document owns the incident state
> machine.** Request lifecycle is `22`; task lifecycle is `24`.

---

## 1. Purpose and Boundary

An incident is **something that is broken**, as opposed to a request, which is
**something someone wants**. The distinction is not cosmetic:

| | Service request (`22`) | Incident (`23`) |
|---|---|---|
| Origin | Catalog item | Any user or monitoring |
| Priority | Chosen from item default | **Derived** from impact × urgency |
| Approval | Often required | Never required |
| SLA clock | Starts at creation, may pause | Starts at report, typically never pauses |
| Closure | Requester confirms | Resolver resolves, then closes |

Merging them into one entity would force the priority logic, the approval path and the
pause semantics to be conditional on a type column in every query. They stay separate
(`08` §3).

## 2. Data

Per `08` §4.2: `title`, `description`, `impact`, `urgency`, `priority` (derived),
`isMajor`, `status`, `reporterId`, `assigneeId`, `teamId`, `resolutionSummary`,
`resolvedAt`, `closedAt`, `slaPolicyId`.

## 3. Priority Derivation

Priority is **computed**, never freely chosen, because inconsistent incident priority
is the single most common reason SLA reporting becomes untrustworthy.

| Impact ↓ / Urgency → | High | Medium | Low |
|---|---|---|---|
| **Extensive** (many users / critical service) | CRITICAL | HIGH | MEDIUM |
| **Significant** (a team / a major function) | HIGH | MEDIUM | LOW |
| **Minor** (an individual / a workaround exists) | MEDIUM | LOW | LOW |

| Field | Values |
|---|---|
| Impact | Extensive · Significant · Minor |
| Urgency | High · Medium · Low |
| Priority | Critical · High · Medium · Low |

**Override rule:** an agent or lead may override the derived priority only with
`incident:priority:override`, a mandatory reason, and an audit record. Overrides raise
a monitoring signal so a pattern of overrides is visible — repeated overrides usually
mean the derivation matrix is wrong, not that the agents are.

## 4. State Machine (authoritative)

```
     ┌─────────┐
     │   NEW   │  reported, unassigned
     └────┬────┘
          │ triage / assign
          ▼
   ┌─────────────┐   ◀──────┐
   │ IN_PROGRESS │          │ reopen
   └──────┬──────┘          │
          │ resolution      │
          │ summary         │
          ▼                 │
   ┌─────────────┐          │
   │  RESOLVED   │──────────┘
   └──────┬──────┘
          │ confirmation or auto-close window
          ▼
   ┌─────────────┐
   │   CLOSED    │
   └─────────────┘
```

| From | To | Actor | Guard | Effects |
|---|---|---|---|---|
| — | `NEW` | Any authenticated user | Title, description, impact, urgency | Priority derived · reference issued · clock started · on-call/team notified per priority |
| `NEW` | `IN_PROGRESS` | Agent/Lead | Assignee set | Status change notified to reporter |
| `IN_PROGRESS` | `RESOLVED` | Agent | `resolutionSummary` non-empty | Clock stops · reporter notified · KB draft offered |
| `RESOLVED` | `CLOSED` | Reporter/Agent/System | Resolution exists | Auto-close after the configured window if no objection |
| `RESOLVED`/`CLOSED` | `IN_PROGRESS` (`REOPENED`) | Reporter/Agent | Window not exceeded, or override with reason | Clock policy per `25` §5; reopen counted for reporting |

Rule `CHECK` at the database level: `resolutionSummary` is non-null whenever status is
`RESOLVED` or `CLOSED` (`09` §2).

## 5. Major Incidents

`isMajor` raises breadth and detail; it does not create a second state machine (this
keeps reporting and permissions coherent).

| Aspect | Effect when `isMajor` |
|---|---|
| Notifications | Wider audience, including leads and administrators; higher channel priority |
| Audit | Every field change captured, not only status |
| Reporting | Separately reported; excluded from routine SLA attainment averages |
| Communication | An update cadence is required: periodic public updates until resolved |
| Post-incident | A review is scheduled on closure |

**Toggling `isMajor` is audited in both directions.** Quietly clearing the flag after a
bad incident is exactly the kind of change an audit trail exists to reveal.

## 6. Rules

| # | Rule |
|---|---|
| I1 | Priority is derived; override requires permission, reason, and audit |
| I2 | An incident cannot be `IN_PROGRESS` without an assignee |
| I3 | Resolution requires a summary; closure requires resolution |
| I4 | Reopening is permitted within a configured window, or by override with a reason |
| I5 | Incidents are never approved — no approval path exists |
| I6 | An incident may reference assets and, later, a KB article; it never becomes a request |
| I7 | Reporter-visible content excludes internal notes (`22` §6 audience rules apply identically) |
| I8 | Deleting an incident is impossible; the only exits are `CLOSED` (and cancellation is not offered — an incident happened) |

## 7. SLA Integration

- Incidents use the incident SLA policy, selected by **derived priority**.
- The clock starts at report and stops at `RESOLVED`.
- Incidents are typically non-pausing; if a policy declares pause states they apply the
  same way as for requests (`25` §4).
- Breach of a `CRITICAL` incident raises an escalated alert class.

## 8. Notifications

| Event | Recipients |
|---|---|
| Reported | Fulfilment/on-call team |
| Priority critical or `isMajor` | Team lead + administrators + configured on-call |
| Assigned | Assignee |
| Status change | Reporter |
| Public comment | Reporter + assignee |
| At risk / breached | Assignee, lead |
| Resolved | Reporter |
| Major update due | Owners, per cadence |

## 9. Permissions

Per `07` §3–4. Notable: any authenticated user may **report**; only agents and leads
may **update**; only the reporter, an agent, or a lead may **reopen**; the priority
override permission is distinct from the update permission.

## 10. API

| Method | Path | Notes |
|---|---|---|
| POST | `/incidents` | Any authenticated user |
| GET | `/incidents`, `/incidents/{id}` | Scoped |
| PATCH | `/incidents/{id}` | Agents/leads; derived fields read-only except by override |
| POST | `/incidents/{id}/assign` | `incident:update.*` |
| POST | `/incidents/{id}/resolve` | Requires `resolutionSummary` |
| POST | `/incidents/{id}/close`, `/reopen` | Guarded per §4 |
| POST | `/incidents/{id}/major` | Lead or admin; audited |
| GET/POST | `/incidents/{id}/comments` | Inherits visibility |
| GET | `/incidents/{id}/history` | Audit projection |

## 11. UI Surfaces

| Surface | Contents |
|---|---|
| Incident list | Reference, title, priority, status, SLA, assignee, age — sorted to surface criticals first |
| Report form | Title, description, impact, urgency, asset (optional), attachment; **shows the derived priority live** so the reporter understands the consequence |
| Detail | Header with priority, SLA countdown and major flag; tabs per `22` §12 |
| Major banner | Prominent, persistent, survives navigation so a major incident cannot be forgotten |

## 12. Edge Cases

| Case | Behaviour |
|---|---|
| Reporter is also the resolver | Permitted; both events are attributed to one identity in the audit trail |
| Duplicate reports of the same incident | A "duplicate of" link is available; both keep their own record and SLA |
| Resolution summary edited after resolution | Permitted for agents; audited; reporter notified if the meaning changes materially |
| Auto-close while the reporter is dissenting | A comment within the window cancels auto-close |
| Incident reopened after closure | New clock per policy; reopen count reported |
| Impact/urgency changed after create | Priority re-derives; change and both values are audited |
| Monitoring-created incident via integration | Requires a service account with `incident:create`; reporter is the service account |

## 13. Acceptance Criteria

1. Submitting impact and urgency produces the priority in the §3 matrix — verified for
   all nine combinations.
2. A priority override without a reason is rejected.
3. `RESOLVED` without a resolution summary is rejected at the API and by the database
   constraint.
4. `IN_PROGRESS` without an assignee is rejected.
5. Reopening within the window succeeds; outside it requires an override with a reason.
6. Every priority override appears in the audit trail with its reason and is reported.

## 14. Related

- `22-SERVICE-REQUESTS.md` — the sibling lifecycle and shared child patterns
- `24-TASK-MANAGEMENT.md` · `25-SLA-MANAGEMENT.md` · `28-ASSET-MANAGEMENT.md`
- `27-KNOWLEDGE-BASE.md` — the draft offered at resolution
- `29-NOTIFICATIONS-AND-MESSAGING.md` · `31-AUDIT-LOGGING.md`
