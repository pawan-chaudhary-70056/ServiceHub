# 28 — Asset Management

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-07
**Consolidates:** old 61

> **Scope:** the asset register and its assignment history. **How assets are linked to
> requests and incidents** is owned here, consumed by `22`/`23`.

---

## 1. Purpose

The asset register answers three questions that make incident resolution and
accountability possible: *what do we have*, *who holds it*, and *what is it connected
to*. An asset record that never records assignment history is a spreadsheet — it can
say who holds an item today but cannot answer "who held it when it failed".

## 2. Concepts

| Concept | Definition |
|---|---|
| Asset | A tracked configuration item (device, licence, subscription, service instance) |
| Asset type | Administrator-defined class with its own field set |
| Assignment | A time-bounded link between an asset and a holder (user or team) |
| Lifecycle state | `PROCURED → IN_STOCK → ASSIGNED → IN_REPAIR → RETIRED → DISPOSED` |

## 3. Data

Per `08` §2: `Asset` and `AssetAssignment`.

| `Asset` field | Notes |
|---|---|
| `assetTypeId` | Class definition |
| `tag` | Unique human-readable identifier (`AST-000123`) |
| `serialNumber` | Unique when present |
| `name`, `description` | |
| `state` | Lifecycle state |
| `attributes` | JSON for type-specific fields; queryable fields are promoted to columns (`08` §1) |
| `assignedToUserId` / `assignedToTeamId` | Current holder (denormalized from the open assignment) |
| `purchaseDate`, `warrantyExpiresAt` | For lifecycle alerting |

| `AssetAssignment` field | Notes |
|---|---|
| `assetId`, `userId`/`teamId` | Holder |
| `assignedAt`, `returnedAt` | `returnedAt` null = currently held |
| `assignedById` | Who performed the assignment |
| `notes` | Condition on return, etc. |

**Exactly one open assignment per asset at a time**, enforced by a partial unique
index (`09`). Two open assignments is the defect that makes "who holds it" unanswerable.

## 4. Lifecycle

```
PROCURED ──▶ IN_STOCK ──▶ ASSIGNED ──▶ IN_REPAIR ──▶ IN_STOCK
                │            │              │
                │            └──────────────┘
                ▼
             RETIRED ──▶ DISPOSED
```

| Transition | Rule |
|---|---|
| `IN_STOCK → ASSIGNED` | Opens an assignment; sets the current holder |
| `ASSIGNED → IN_STOCK` | Closes the open assignment with `returnedAt` |
| `ASSIGNED → IN_REPAIR` | Closes the assignment or holds it depending on policy; records the reason |
| `→ RETIRED` | Closes any open assignment; asset becomes read-only for new assignments |
| `RETIRED → DISPOSED` | Terminal; retained for history, excluded from active counts |

Assignments are **history, never deleted**. Returning an asset updates `returnedAt`; it
does not remove the row.

## 5. Business Rules

| # | Rule | Rationale |
|---|---|---|
| AM1 | An asset cannot be assigned while it has an open assignment | Prevents double-assignment |
| AM2 | `tag` and `serialNumber` are unique | Identity integrity |
| AM3 | Assignment history is append-only | The audit answer for "who held it then" |
| AM4 | Retiring an asset closes open assignments and preserves history | No orphan holders |
| AM5 | Assets are retired, never hard-deleted | Referenced by request history |
| AM6 | `ASSIGNED` state cannot exist without an open assignment, and vice versa — enforced | State and history must not disagree |
| AM7 | Type-specific required attributes are validated on create | Prevents unqueryable empty records |
| AM8 | Transferring an asset between holders is close-then-open, never an in-place edit | Keeps the interval history truthful |
| AM9 | Warranty expiry and stale-assignment alerts derive from stored dates | No silent lifecycle drift |

## 6. Permissions

Permission keys are the canonical ones from `07` §3 (the permission catalogue is owned
by `07`; this document does not mint new keys).

| Action | Permission |
|---|---|
| View assets (own) | `asset:read.own` — a holder sees the assets they hold |
| View assets (tenant) | `asset:read.any` |
| Manage assets | `asset:manage` |
| Assign / return | `asset:assign` |
| Manage asset types | `admin:config` |
| Disposal | `asset:manage` (administrator), audited — never a hard delete (`AM5`) |

## 7. Integration with Requests, Incidents and Catalog

| Link | Behaviour |
|---|---|
| Request → asset | A request (e.g. "replace my laptop") may reference an asset; the requester can only reference assets they hold |
| Incident → asset (affected) | An incident records the affected asset(s) via `(entityType, entityId)` child links (`08` §3) |
| Catalog item → asset type | Requesting an item can create/pre-assign an asset as part of fulfilment |
| Resolution → assignment change | Fulfilment may assign an asset; the assignment is a link, not an implicit state edit |

**Linking is not ownership transfer.** Referencing an asset on an incident does not
change who holds it; only an explicit assignment does, and that is audited.

## 8. API

| Method | Path | Notes |
|---|---|---|
| GET | `/assets` | Filter by type, state, holder; cursor-paginated |
| GET | `/assets/{id}` | Includes current holder and open assignment |
| POST/PATCH | `/assets/{id}` | Manage |
| GET | `/assets/{id}/assignments` | Full interval history |
| POST | `/assets/{id}/assign` | `{ holder, notes }`; rejects if already open |
| POST | `/assets/{id}/return` | Closes the open assignment |
| GET/POST | `/admin/asset-types` | Admin |

## 9. UI Surfaces

| Surface | Contents |
|---|---|
| Asset register | Searchable table: tag, type, name, state, holder, warranty |
| Asset detail | Attributes, current holder, assignment history timeline, linked records |
| Assignment panel | Assign/return with confirmation and notes |
| My assets | Assets currently held by the signed-in user |
| Type admin | Type builder with attribute schema |
| Lifecycle alerts | Warranty expiring, stale assignments, assets past end of life |

## 10. Edge Cases

| Case | Behaviour |
|---|---|
| Assign to a deactivated user | Rejected; the asset stays `IN_STOCK` with a reason |
| Retire an asset that is assigned | Blocked unless the assignment is closed in the same operation |
| Merge two asset records (duplicate discovered) | Manual merge with audit; the losing record is retired and retains a pointer to the survivor |
| Delete an asset referenced by an incident | Prohibited (`RESTRICT`); retire instead |
| Assignment to a team, then a member | Both allowed and recorded as separate intervals; the team interval remains visible |
| Import with a duplicate tag | Rejected row-by-row, reported; never silently overwritten |

## 11. Acceptance Criteria

1. An asset cannot have two open assignments — verified by a concurrent-assign test at
   the database index level.
2. Returning an asset preserves the assignment row with `returnedAt`.
3. A retired asset is excluded from `IN_STOCK`/`ASSIGNED` counts but remains readable.
4. `state` and open-assignment presence cannot disagree through any API path.
5. Every assignment, return, transfer and disposal is audited.
6. A requester can reference only assets they hold on a request.

## 12. Related

- `22-SERVICE-REQUESTS.md` · `23-INCIDENT-MANAGEMENT.md` — linking assets to records
- `08-DATA-MODEL.md` · `09-DATA-INTEGRITY-AND-INDEXING.md` — the partial unique index
- `07-ROLES-AND-AUTHORIZATION.md` · `31-AUDIT-LOGGING.md`
