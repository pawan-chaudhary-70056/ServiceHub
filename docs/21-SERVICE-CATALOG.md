# 21 — Service Catalog

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 54

> **Scope:** defining and browsing what can be requested. Raising a request is `22`.

---

## 1. Purpose

The catalog is the **intake contract**. It converts "someone asked for something" into
a typed, categorised, SLA-bound, approvable unit of work. Without it, requests cannot
be routed, measured, approved, or reported on.

Consequences of the catalog being wrong are felt everywhere downstream: an item with
no SLA policy produces unmeasurable work; an item with no fulfilment team produces
unowned work; a schema-less item produces unusable data.

## 2. Concepts

| Concept | Definition |
|---|---|
| Category | Hierarchical grouping of items for browsing and reporting |
| Catalog item | A requestable service definition |
| Field definition | A typed input on an item's request form |
| Fulfilment team | Default owning team for requests from the item |
| Default priority / SLA policy | Defaults applied to requests from the item |

## 3. Data

Per `08` §4.4:

- `Category`: `name`, `parentId`, `description`, `displayOrder`, `isActive`
- `CatalogItem`: `categoryId`, `name`, `description`, `defaultPriority`,
  `defaultSlaPolicyId`, `fulfilmentTeamId`, `status`, `requiresApproval`,
  `approvalWorkflowTemplateId`
- `CatalogItemField`: `catalogItemId`, `key`, `label`, `fieldType`, `isRequired`,
  `options`, `validation`, `helpText`, `displayOrder`

### Field types

| Type | Storage | Notes |
|---|---|---|
| `TEXT` | string | Length-bounded |
| `LONG_TEXT` | string | Length-bounded, multiline |
| `NUMBER` | number | Integer or decimal, with min/max |
| `DATE` / `DATETIME` | ISO string | Time zone handled at capture |
| `SELECT` | string | Single choice from `options` |
| `MULTI_SELECT` | string[] | Bounded count |
| `BOOLEAN` | boolean | |
| `FILE` | attachment ref | Uses the file pipeline (`19`) |
| `USER` | user id | For "for whom" and similar |

## 4. Lifecycle

```
DRAFT ──▶ ACTIVE ──▶ RETIRED
  ▲          │
  └──◀───────┘   (reactivate)
```

| State | Requestable | Visible to requesters | Editable |
|---|---|---|---|
| `DRAFT` | No | No | Yes |
| `ACTIVE` | Yes | Yes | Yes — with the in-flight rules below |
| `RETIRED` | No | No (existing requests stay readable) | Limited |

**Retirement is not deletion.** Requests referencing a retired item remain valid and
readable, and reports over historical periods stay correct. Hard-deleting a catalog
item would orphan request history and is prohibited.

## 5. Business Rules

| # | Rule | Rationale |
|---|---|---|
| C1 | An item cannot be activated without a name, category, SLA policy, and fulfilment team | Otherwise it produces unmeasurable, unowned work |
| C2 | `key` is unique within an item and immutable after first use | Requests reference keys; renaming breaks history |
| C3 | Field definitions are **snapshotted into the request at creation** | Editing an item must not rewrite the meaning of past answers (FR-CATALOG-005) |
| C4 | Required fields are validated server-side at submit | Client validation is UX only (`12`) |
| C5 | Retiring an item never mutates existing requests | History integrity |
| C6 | Defaults are applied at creation and then frozen | Later edits do not retroactively reschedule SLA |
| C7 | Categories cannot be nested beyond three levels | Deeper trees are unusable in navigation |
| C8 | An approval workflow template must reference an existing template | Prevents broken routing |
| C9 | `SELECT` options cannot be removed while referenced by an in-flight request's snapshot | Prevents dangling values |

## 6. Permissions

| Action | Permission |
|---|---|
| Browse catalog | `catalog:read` (all authenticated users) |
| Manage categories and items | `catalog:manage` (administrator) |
| Activate / retire | `catalog:manage` |
| Request an item | `request:create` |

## 7. SLA and Approval Integration

- The item's `defaultSlaPolicyId` is copied to the request at creation and **frozen**
  (`08` §4.1). Policy edits apply to future requests only.
- If `requiresApproval` is set, the request enters `APPROVAL_PENDING` after triage and
  the SLA clock pauses per policy (`25` §4).
- The fulfilment team becomes the request's default owning team, which drives default
  assignment and team-scoped visibility.

## 8. API

| Method | Path | Permission |
|---|---|---|
| GET | `/catalog/categories` | `catalog:read` |
| POST/PATCH | `/catalog/categories/{id}` | `catalog:manage` |
| GET | `/catalog/items` | `catalog:read` (active only for non-admins) |
| GET | `/catalog/items/{id}` | `catalog:read` |
| POST/PATCH | `/catalog/items/{id}` | `catalog:manage` |
| POST | `/catalog/items/{id}/activate`, `/retire` | `catalog:manage` |
| GET/PUT | `/catalog/items/{id}/fields` | `catalog:manage` for writes |

Collections are cursor-paginated and sortable per `11` §6.

## 9. UI Surfaces

| Surface | Contents |
|---|---|
| Catalog browse | Category tree, search, item cards with description and typical turnaround |
| Item detail | Description, expected SLA, fields, "Raise request" action |
| Catalog admin | Item list, editor with live form preview, field builder, lifecycle actions |
| Category admin | Tree view with drag ordering |

**Requester-facing copy** must avoid ITSM jargon (`16` §10). "Laptop request" and
"What happens next: your manager approves, IT prepares it in 2 days" beats "CI class".

## 10. Caching

Catalog and categories are the canonical cache candidates: frequently read, slowly
changing, non-sensitive (`33` §Cache eligibility).

| Data | TTL | Invalidation |
|---|---|---|
| Category tree | Long (minutes–hours) | On any category mutation |
| Active item list | Medium | On item activation/retirement/edit |
| Item detail for admin views | Not cached | — |

**Never cache a permission-filtered view under a shared key.** A requester's view and
an administrator's view of the catalog differ by status filtering, so the key must
include the viewer's class or the data must be cached unfiltered and filtered after.

## 11. Edge Cases

| Case | Behaviour |
|---|---|
| Item retired while a user is filling the form | Submit returns `409` with "This service is no longer available" |
| Field removed while a request is in flight | In-flight request keeps its snapshot; display falls back to the stored key |
| Two items share a name | Allowed; `key` and id disambiguate; the UI shows the category path |
| Category deleted with items | Blocked with `409`; items must be moved or retired first |
| SLA policy deleted while referenced | Blocked; policies are retired, not deleted |
| Item has a required `FILE` field | Submit blocked until the upload completes and scans clean |

## 12. Acceptance Criteria

1. A requester can find an active item by browsing or searching and raise a request
   from it.
2. A retired item is not requestable and is not visible to requesters, while past
   requests from it remain readable with their original field labels.
3. Editing an item's fields or defaults does not alter any existing request — verified
   by comparing a request created before and after the edit.
4. An item cannot be activated without an SLA policy and fulfilment team — verified by
   a rejected activation.
5. Catalog list responses are cached, and a catalog mutation invalidates the cache
   within the documented TTL.

## 13. Related

- `22-SERVICE-REQUESTS.md` — consuming the catalog
- `25-SLA-MANAGEMENT.md` — the policy applied at creation
- `08-DATA-MODEL.md` · `12-VALIDATION-RULES.md` · `33-SCALABILITY-AND-DATABASE-PROTECTION.md`
