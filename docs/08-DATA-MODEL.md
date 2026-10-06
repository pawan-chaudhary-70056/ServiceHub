# 08 — Data Model

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** DBA · **Approved:** 2026-10-01
**Consolidates:** old 12, 13, 14, 17 (database design, models, relationships, flow)
**Decided by:** **ADR-0002** (D-2 — multi-tenant shared schema)

> **Scope:** what is stored. **Indexes and constraints** are `09`. **How the schema
> changes** is `10`. **Retention and classification** are `19`.

---

## 1. Conventions

| Concern | Convention |
|---|---|
| Primary keys | `id` — opaque, sortable, non-guessable (UUIDv7 or cuid2). Never sequential integers in URLs. |
| Foreign keys | `<entity>Id`, indexed |
| Timestamps | `createdAt`, `updatedAt` — `timestamptz`, always UTC at rest |
| Soft delete | Only where history matters (`deletedAt`). Audit-facing entities are **never** hard-deleted. |
| Enumerations | PostgreSQL enum for stable, code-coupled sets; lookup table for administrator-editable sets |
| Naming | `snake_case` in the database, `camelCase` in code (Prisma `@map`) |
| Booleans | Named as assertions: `isActive`, `isMajor` — never `flag` or `status2` |
| Money | Integer minor units + currency code. Never float. |
| Durations | Integer seconds/minutes with a stated unit in the name (`targetMinutes`) |
| JSON | Only for genuinely schemaless payloads (dynamic form values, job payloads, audit before/after). Everything queryable is a column. |
| Scope | `organizationId` present on all tenant-scoped tables and applied as a mandatory predicate on every query (**D-2**, `ADR-0002`) |
| Tenant root | `organizationId` is a FK to `Organization`. It is **nullable only** for a platform operator, which belongs to no tenant (**D-9**, `ADR-0012`) |

**JSON is not a shortcut for schema design.** If a field is filtered, sorted, joined
or reported on, it is a column with an index. JSON is reserved for values that are
opaque to the system.

## 2. Entity Inventory

| Entity | Module | Purpose |
|---|---|---|
| `Organization` | platform | Tenant root; the boundary of every scope predicate (`ADR-0012`) |
| `User` | identity | Person or service account |
| `Credential` | identity | Password hash and policy state |
| `Session` | identity | Active server-side session (`ADR-0001`) |
| `PasswordResetToken` | identity | Single-use reset token (hashed) |
| `Invitation` | identity | Single-use onboarding token (hashed) (`ADR-0012`) |
| `Role` / `UserRole` | authz | Role catalogue and grants |
| `Permission` / `RolePermission` | authz | Permission catalogue and role mapping |
| `Team` / `TeamMember` | user | Ownership and routing unit |
| `Category` | catalog | Hierarchical catalog grouping |
| `CatalogItem` | catalog | Requestable service definition |
| `CatalogItemField` | catalog | Dynamic form field definition |
| `ServiceRequest` | req | A request raised from a catalog item |
| `RequestFieldValue` | req | Captured dynamic form values |
| `Incident` | inc | Unplanned service interruption |
| `Task` | task | Child unit of work |
| `Comment` | req/inc/task | Public or internal conversation |
| `Attachment` | file | File metadata (bytes live in object storage) |
| `SlaPolicy` | sla | Targets and calendar binding |
| `SlaTarget` | sla | Per-priority target/warn thresholds |
| `BusinessCalendar` | sla | Working days, hours, holidays, time zone |
| `SlaClock` | sla | Clock state per record (derived, cached) |
| `ApprovalWorkflow` | appr | Ordered steps attached to a record |
| `ApprovalStep` | appr | One step with approvers and mode |
| `ApprovalDecision` | appr | Immutable decision record |
| `ArticleCategory` / `Article` | kb | Knowledge content |
| `Asset` / `AssetAssignment` | asset | Register and assignment history |
| `Notification` | notif | Delivery record per recipient/channel |
| `NotificationPreference` | notif | Per-user opt-outs |
| `JobRecord` / `Outbox` | platform | Async work and reliable event emission |
| `AuditLog` | audit | Append-only mutation history |
| `WebhookSubscription` | integ | Outbound integration config |

## 3. Core Relationships

```
Category ──< CatalogItem ──< CatalogItemField
                  │
                  │ 1..*
                  ▼
User ──1..*──< ServiceRequest ──< RequestFieldValue
 │                 │  │
 │                 │  ├──< Comment ──< Attachment
 │                 │  ├──< Task ──────────┘
 │                 │  ├──1 SlaClock ──> SlaPolicy ──< SlaTarget
 │                 │  └──< ApprovalWorkflow ──< ApprovalStep ──< ApprovalDecision
 │                 │
 │                 └──> Asset (optional reference)
 │
 ├──< Incident ──(same child pattern as ServiceRequest)
 │
 ├──< Notification
 ├──< AssetAssignment >── Asset
 └──< UserRole >── Role ──< RolePermission >── Permission

AuditLog  — append-only, references any entity by (entityType, entityId)
Team ──< TeamMember >── User
Team ──< ServiceRequest (owning team) / Incident / Task
```

**Tenant root (`ADR-0012`).** `Organization` is the tenant root. Every
tenant-scoped row references it through `organizationId`. A **platform operator** is the
only identity permitted a null `organizationId`; it belongs to no tenant. A user belongs
to exactly one organization in v1 (multi-organization membership is deferred and would
be a join table, not a nullable column).

**Deliberate structural decision:** `ServiceRequest` and `Incident` are **separate
tables**, not one polymorphic `Ticket` table with a type discriminator. They share a
shape but differ in lifecycle, priority derivation, and reporting. A single table
would force nullable columns and type-conditional logic into every query, and would
make the two state machines fight over one `status` column. The cost is some
duplication of the comment/task/attachment pattern, which is handled by a shared
child-table design keyed on `(entityType, entityId)`.

## 4. Principal Entities in Detail

### 4.1 ServiceRequest

| Column | Type | Notes |
|---|---|---|
| `id` | id | PK |
| `reference` | text | Unique, human-readable (`REQ-2026-000123`) |
| `organizationId` | id | Scope (**D-2**, `ADR-0002`) |
| `catalogItemId` | id | FK, required |
| `requesterId` | id | FK, required |
| `assigneeId` | id? | FK, nullable until assigned |
| `teamId` | id? | FK, owning team |
| `status` | enum | State machine value |
| `priority` | enum | LOW/MEDIUM/HIGH/CRITICAL |
| `title`, `description` | text | |
| `slaPolicyId` | id | Resolved at creation, frozen thereafter |
| `submittedAt`, `resolvedAt`, `closedAt` | timestamptz? | Lifecycle timestamps |
| `createdAt`, `updatedAt` | timestamptz | |

**`slaPolicyId` is frozen at creation.** Editing a policy must not retroactively
change a request already in flight, or reporting becomes unreproducible.

### 4.2 Incident

Shares the shape above, adds `impact`, `urgency` (used to derive priority),
`isMajor`, and `resolutionSummary` (required to resolve, `FR-INC-005`).

### 4.3 Task

`parentType` + `parentId` (request or incident), `assigneeId`, `status`
(TODO/IN_PROGRESS/BLOCKED/DONE/CANCELLED), `dueAt`, `completedAt`.

### 4.4 CatalogItem / CatalogItemField

`CatalogItem`: `categoryId`, `name`, `description`, `defaultPriority`,
`defaultSlaPolicyId`, `fulfilmentTeamId`, `status` (DRAFT/ACTIVE/RETIRED).

`CatalogItemField`: `catalogItemId`, `key`, `label`, `fieldType`, `isRequired`,
`validation` (JSON), `options` (JSON for selects), `displayOrder`.

**In-flight fidelity (`FR-CATALOG-005`):** field definitions are snapshotted into the
request at creation, so editing a catalog item never rewrites the meaning of an
existing request's answers.

### 4.5 SlaPolicy / SlaTarget / BusinessCalendar / SlaClock

- `SlaPolicy`: `name`, `calendarId`, `pauseStates` (JSON array of statuses), `isActive`.
- `SlaTarget`: `slaPolicyId`, `priority`, `responseMinutes`, `resolveMinutes`,
  `warnPercent`.
- `BusinessCalendar`: `timeZone`, working hours per weekday, holiday list.
- `SlaClock`: one row per record — `startedAt`, `pausedAt`, `totalPausedSeconds`,
  `targetAt`, `warnAt`, `breachedAt`, `state`. **`state` is derived and rewritten by
  the sweep; it is never editable through the API.**

### 4.6 ApprovalWorkflow / Step / Decision

`ApprovalWorkflow` (one per record) → `ApprovalStep` (`stepOrder`, `mode`
ANY/ALL, `deadlineAt`) → `ApprovalDecision` (`approverId`, `decision`, `comment`,
`decidedAt`). Decisions are **insert-only**; there is no update or delete path.

### 4.7 AuditLog

| Column | Notes |
|---|---|
| `id` | PK |
| `occurredAt` | timestamptz, set by the writer |
| `actorId` / `actorType` | user, service, or system |
| `action` | `request.status.change`, `authz.override`, … |
| `entityType` / `entityId` | target |
| `before` / `after` | JSON snapshots (redacted per classification) |
| `reason` | Required for overrides |
| `correlationId` | Ties to logs and to the originating request |
| `sourceIp` / `userAgent` | Context |

**No `updatedAt`, no delete path** — the absence is the control (`31`).

### 4.8 Organization

| Column | Type | Notes |
|---|---|---|
| `id` | id | PK |
| `name` | text | Tenant display name; unique (case-insensitive) |
| `slug` | text | Stable, URL-safe identifier; unique |
| `status` | enum | `ACTIVE` / `SUSPENDED` — retirement, never deletion |
| `defaultTimeZone` | text | IANA zone applied to new calendars (`25`) |
| `createdAt`, `updatedAt` | timestamptz | |

**A suspended organization cannot be used**; suspension is a status change, never a
delete, so history survives. `Organization` is created only by a platform operator
(`07` §3, `04` §13.2) and carries no `organizationId` of its own — it *is* the scope.

### 4.9 Invitation

| Column | Type | Notes |
|---|---|---|
| `id` | id | PK |
| `organizationId` | id | Tenant the invitee is joining (`ADR-0002`) |
| `email` | text | Invitee address (normalised, lower-cased) |
| `roleId` | id | Initial role granted on acceptance |
| `tokenHash` | text | Hash of a ≥128-bit token; the raw token is never stored |
| `invitedById` | id | The administrator who issued it |
| `expiresAt` | timestamptz | Bounded lifetime |
| `acceptedAt` | timestamptz? | Set once on acceptance; single-use |
| `createdAt`, `updatedAt` | timestamptz | |

Invitation is **distinct from `PasswordResetToken`**: it *establishes* a first
credential (`06` §11), where reset *replaces* one. An invitation grants nothing until it
is accepted and a credential exists. Re-inviting invalidates any outstanding token.

## 5. Integrity Rules

| Rule | Enforced by |
|---|---|
| Reference uniqueness | Unique index; generated under a retry-safe scheme |
| State machine validity | Service layer + `CHECK` where expressible |
| SLA policy presence on eligible records | Not-null FK |
| Decision immutability | Insert-only table; no update grant |
| Audit completeness | Written in the same transaction as the mutation |
| Child ≤ parent visibility | Service layer, tested per entity |
| Orphan prevention | `ON DELETE RESTRICT` by default; `CASCADE` only for true children |
| Organization uniqueness | Unique index on `slug` and on `lower(name)` (`ADR-0012`) |
| Invitation single use | `tokenHash` unique; `acceptedAt` set at most once (`ADR-0012`) |
| Platform operator has no tenant | `organizationId` is null only for a platform operator |

Default to `RESTRICT`. A cascade that silently removes history is worse than an
error that forces the developer to decide.

## 6. Data Lifecycle

| Stage | Behaviour |
|---|---|
| Create | Timestamps set; audit written; SLA clock started |
| Update | `updatedAt` bumped; before/after captured in audit |
| Retire | Status change, not deletion (catalog items, assets, users) |
| Archive | Closed records older than the active window move to archive partitions (`33`) |
| Prune | Jobs/logs pruned per retention; **audit is never pruned before 24 months** |
| Delete | Only for genuinely transient data (expired tokens, delivered job records) |

## 7. Open Questions

| # | Question | Blocked by |
|---|---|---|
| 1 | Tenancy column semantics and query enforcement | Resolved — `ADR-0002` |
| 2 | Retention period per entity class | Legal/policy sign-off |
| 3 | Whether `Session` exists as a table | Resolved — `ADR-0001` (yes) |
| 4 | Whether search uses PostgreSQL FTS or an external index | `30` |

## 8. Related

- `09-DATA-INTEGRITY-AND-INDEXING.md` — constraints and indexes
- `10-MIGRATIONS-AND-SEEDING.md` — schema evolution
- `11-API-CONTRACT.md` — how these entities are exposed
- `19-DATA-PROTECTION-AND-FILES.md` — classification and retention
