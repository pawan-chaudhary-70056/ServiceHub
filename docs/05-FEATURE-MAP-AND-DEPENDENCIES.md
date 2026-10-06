# 05 — Feature Map and Dependencies

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 08, 09, 10 (feature architecture, feature flow, feature dependencies)

> **Scope:** the inventory of features, what each depends on, and the order they can
> be built. **How a feature behaves internally** is in its own document
> (`21`–`32`). **How work flows through the system** is in `04`.

---

## 1. Feature Inventory

Each feature is a vertical slice: database object → service → API → UI → tests.
A feature is not "done" until it has all five (`41-DEFINITION-OF-DONE.md`).

| ID | Feature | Module | Spec | Requirements | Phase |
|---|---|---|---|---|---|
| F-01 | Identity | `auth` | `06` | FR-AUTH-* | 1 |
| F-02 | Users and Teams | `user` | `07` | FR-USER-001..004 | 1 |
| F-03 | Authorization | `authz` | `07` | FR-USER-002, FR-USER-005 | 1 |
| F-04 | Service Catalog | `catalog` | `21` | FR-CATALOG-* | 2 |
| F-05 | Service Requests | `req` | `22` | FR-REQ-* | 2 |
| F-06 | Incident Management | `inc` | `23` | FR-INC-* | 2 |
| F-07 | Task Management | `task` | `24` | FR-TASK-* | 2 |
| F-08 | SLA Management | `sla` | `25` | FR-SLA-* | 2 |
| F-09 | Approval Management | `appr` | `26` | FR-APPR-* | 2 |
| F-10 | Knowledge Base | `kb` | `27` | FR-KB-* | 3 |
| F-11 | Asset Management | `asset` | `28` | FR-ASSET-* | 3 |
| F-12 | Notifications | `notif` | `29` | FR-NOTIF-* | 2 |
| F-13 | Search | `search` | `30` | FR-SEARCH-001 | 2 |
| F-14 | Reporting | `report` | `30` | FR-REPORT-001 | 2 |
| F-15 | Audit Logging | `audit` | `31` | FR-AUDIT-001 | 2 |
| F-16 | File Attachments | `file` | `19` | FR-FILE-001 | 2 |
| F-17 | Integrations | `integ` | `32` | FR-INTEG-* | 3 |

## 2. Dependency Graph

```
                    ┌──────────┐
                    │  F-01    │ Identity
                    │  F-02    │ Users & Teams
                    │  F-03    │ Authorization
                    └────┬─────┘
                         │ everything depends on identity + authz
        ┌────────────────┼────────────────┬────────────────┐
        ▼                ▼                ▼                ▼
   ┌─────────┐     ┌──────────┐     ┌──────────┐    ┌──────────┐
   │  F-04   │     │  F-06    │     │  F-11    │    │  F-15    │
   │ Catalog │     │ Incidents│     │  Assets  │    │  Audit   │
   └────┬────┘     └────┬─────┘     └────┬─────┘    └──────────┘
        │               │                │          (sink: no deps)
        ▼               │                │
   ┌─────────┐          │                │
   │  F-05   │ Requests │                │
   └──┬───┬──┘──────────┘                │
      │   │                              │
      │   ├─▶ ┌─────────┐                │
      │   │   │  F-07   │ Tasks ◀────────┘
      │   │   └─────────┘
      │   │
      │   ├─▶ ┌─────────┐
      │   │   │  F-09   │ Approvals
      │   │   └─────────┘
      │   │
      ▼   ▼
   ┌─────────┐     ┌─────────┐     ┌─────────┐
   │  F-08   │ SLA │  F-12   │Notif│  F-16   │ Files
   └────┬────┘     └─────────┘     └─────────┘
        │              ▲
        │              │ consumes events from ALL features
        └──────────────┘
   ┌─────────┐     ┌─────────┐     ┌─────────┐
   │  F-10   │ KB  │  F-13   │Srch │  F-14   │Reports
   └─────────┘     └─────────┘     └─────────┘
        ▲              ▲                ▲
        └──────────────┴────────────────┘
              read over other features' data
```

## 3. Dependency Rules

| Rule | Consequence |
|---|---|
| Identity precedes everything | No feature may define its own user model |
| Authorization precedes everything | No feature may define its own permission check |
| Catalog precedes Requests | A request requires a catalog item |
| Requests/Incidents precede Tasks | A task requires a parent |
| SLA observes, never mutates, domain state | SLA reads transitions, writes only clock state |
| Approvals mutate only request state | Approvals never write to tasks |
| Notifications depend on nothing directly | It consumes events; it is never called inline |
| Audit depends on nothing | Write-only sink |
| Search/Reporting read; never write domain state | They may build their own read models |
| Integrations come last | They consume stable contracts |

**Cycle check:** the graph above must remain a DAG. A lint-level import check enforces
the module table in `03-ARCHITECTURE.md` §4, which is the machine-readable form of
this graph.

## 4. Critical Path

The longest dependency chain determines the earliest possible end date:

```
F-01 Identity → F-02 Users/Teams → F-03 Authorization → F-04 Catalog
   → F-05 Requests → F-08 SLA → F-14 Reporting
```

That is seven features. Features off the critical path (F-10 KB, F-11 Assets,
F-16 Files) can run in parallel once F-03 lands, which is why they are sequenced
after the core work-management pair rather than before it.

## 5. Suggested Build Order

| Order | Features | Rationale |
|---|---|---|
| 1 | F-01, F-02, F-03 | Nothing is testable without identity and authorization |
| 2 | F-04, F-05 | The thinnest complete vertical slice: raise work and track it |
| 3 | F-08 | SLA is what makes a ticket a *managed* ticket |
| 4 | F-06, F-07 | Incidents and tasks reuse the request patterns |
| 5 | F-09, F-12, F-15, F-16 | Governance and communication around work |
| 6 | F-10, F-11 | Adjacent knowledge and asset context |
| 7 | F-13, F-14 | Read models over data that now exists |
| 8 | F-17 | Integrations over stable contracts |

**Ordering principle:** each step must end with a *demonstrable* slice, not a layer.
Building "all the services, then all the controllers, then all the UI" produces
nothing testable until the very end and is forbidden by this plan.

## 6. Feature Slice Definition

Every feature is delivered as the same five-part slice:

```
1  Data        entities, constraints, indexes, migration
2  Contract    endpoints, request/response schemas, error cases
3  Logic       service methods, state machine, authorization rules, audit events
4  Surface     UI pages/components, states (loading/empty/error), permissions
5  Proof       unit + integration + API tests, and one end-to-end path
```

A feature missing any part is **not** complete regardless of how much of the other
four exists.

## 7. Cross-Feature Concerns

| Concern | Rule | Home |
|---|---|---|
| State transitions | Every work item has exactly one owning state machine | `22`–`24`, `28` |
| Audit | Every mutation emits one audit record | `31` |
| Notifications | Every notification originates from a domain event | `29` |
| SLA | Every SLA-eligible record has a policy and a derived clock | `25` |
| Authorization | Every endpoint and every object read is checked | `07` |
| Validation | Every input validated at the boundary | `12` |
| Pagination | Every collection endpoint is paginated | `11` |

## 8. Related

- `03-ARCHITECTURE.md` §4 — module dependency enforcement
- `40-IMPLEMENTATION-PLAN-AND-PHASES.md` — schedule
- `41-DEFINITION-OF-DONE.md` — what "complete" means per feature
