# 09 — Data Integrity and Indexing

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** DBA · **Approved:** 2026-10-01
**Consolidates:** old 15 (database indexing), promoted to its own artifact
**Decided by:** **ADR-0002** (D-2) — every scope predicate and index prefix carries the tenant

> **Scope:** constraints, indexes, query patterns, pagination, transactions and
> resource limits. The *shape* of the data is `08`. Query-level protection under load
> is `33`.

---

## 1. Principle

Indexes are a **design artifact driven by access patterns**, not a defensive spray.
Every index in this document exists because a named query needs it. Every index that
cannot name its query is deleted — it costs storage on every write and slows every
insert.

Corollary: the access patterns in §3 are the specification. Adding an endpoint
without adding its access pattern here (and reviewing the indexes it needs) is
incomplete work.

## 2. Constraint Inventory

Constraints are the cheapest correctness mechanism available, because they hold
regardless of application bugs.

The identity and platform-spine constraints below are **implemented** (migration
`20261002053425_init_identity_authorization_platform`, `ADR-0012`); the domain rows are
realized as their feature migrations land (`10`). **Implemented so far:** the catalog and
SLA config rows (migration `20261006044821_catalog_and_sla`), the request rows
(migration `20261006051611_service_requests`), the incident rows (migrations
`20261006061750_incidents` and `20261006062500_incident_resolution_summary_check`), and
the task rows (migrations `20261006062745_tasks` and
`20261006063100_task_blocked_reason_check`), and the approval rows (migrations
`20261006064000_approvals` and `20261006065000_approval_decision_insert_only`), the
notification rows (migrations `20261006074517_notifications` and
`20261006083900_notification_preferences_inapp`), the search full-text indexes
(migration `20261006082530_search_fts`), and the knowledge-base and asset rows
(migration `20261007044147_knowledge_base_and_assets`, plus the asset search index in
`20261007051500_assets_search_idx`) and the article pending-changes column
(`20261007045627_article_draft_changes`).

| Entity | Constraint | Type |
|---|---|---|
| `Organization` | `nameKey` = `lower(name)` unique | Unique index on `nameKey` |
| `Organization` | `slug` unique | Unique index |
| `User` | `email` unique, case-insensitive | Normalised lower-case on write + unique index on `email` |
| `User` | `email` format | `CHECK` |
| `Credential` | one per user | Unique index on `userId` |
| `Session` | `tokenHash` unique | Unique index |
| `PasswordResetToken` | `tokenHash` unique; single-use | Unique index + `usedAt` set once |
| `Invitation` | `tokenHash` unique; single-use | Unique index + `acceptedAt` set once (`ADR-0012`) |
| `Role` | `(organizationId, key)` unique | Unique index (null `organizationId` = platform role) |
| `Permission` | `key` unique | Unique index |
| `RolePermission` | `(roleId, permissionId)` unique | Unique index |
| `UserRole` | `(userId, roleId)` unique | Unique index (roles are additive — `07` §2) |
| `Team` | `(organizationId, name)` unique | Unique index |
| `TeamMember` | `(teamId, userId)` unique | Unique index |
| `Outbox` | `idempotencyKey` unique | Unique index |
| `JobRecord` | `idempotencyKey` unique | Unique index |
| `ServiceRequest` | `reference` unique | Unique index |
| `ServiceRequest` | `status` ∈ allowed set | Enum type |
| `ServiceRequest` | `slaPolicyId` not null | FK + NOT NULL |
| `Incident` | `reference` unique per tenant | Unique index on `(organizationId, reference)` |
| `Incident` | `status` ∈ allowed set | Enum type |
| `Incident` | `resolutionSummary` not null when status = RESOLVED/CLOSED | `CHECK` (`incidents_resolution_summary_required`, enforced by trigger-style migration so no code path can bypass it) |
| `Incident` | `slaPolicyId` not null | FK + NOT NULL |
| `Task` | exactly one parent (`parentType`, `parentId` consistent) | `CHECK` (the pair is a polymorphic link, so rule T1 is a service rule; the columns are both NOT NULL) |
| `Task` | `blockedReason` not null when status = BLOCKED | `CHECK` (`tasks_blocked_reason_required`) |
| `Task` | `status` ∈ allowed set | Enum type |
| `ApprovalTemplate` | one template per catalog item | Unique index on `catalogItemId` (`26` §4) |
| `ApprovalTemplateStep` | `(templateId, stepOrder)` unique | Unique index |
| `ApprovalWorkflow` | one live workflow per record | Unique index on `requestId` (`26` rule A1) |
| `ApprovalStep` | `(workflowId, stepOrder)` unique | Unique index; exactly one `ACTIVE` step is a service rule |
| `ApprovalStepApprover` | `(stepId, approverId)` unique | Unique index; the approver snapshot (`26` rule A2) |
| `ApprovalDecision` | insert-only | DB trigger rejecting UPDATE/DELETE (`servicehub_reject_approval_decision_mutation`); no edit path in the app (`26` rule A3) |
| `ApprovalDecision` | one decision per approver per step | Index `(stepId, approverId)`; a replayed decision is caught in the service (idempotency) |
| `Category` | `(organizationId, parentId, name)` unique | Unique index; three-level bound (C7) is a service rule |
| `CatalogItem` | `(organizationId, categoryId, name)` unique | Unique index |
| `BusinessCalendar` | `(organizationId, name, version)` unique | Unique index; edits create a new version (`25` §4 rule 6) |
| `SlaPolicy` | `(organizationId, name)` unique | Unique index; one `isDefault` per tenant is a service rule |
| `SlaTarget` | `(slaPolicyId, priority)` unique | Unique index |
| `SlaClock` | open clock per record | Index `(organizationId, entityType, entityId)`; a reopened record starts a new cycle, so the tuple is not unique |
| `SlaClock` | breach sweep | Index `(state, targetAt)` |
| `SlaClock` | attainment over a period | Index `(organizationId, startedAt)` (`30` §3, migration `20261006081305_sla_clock_started_index`) |
| `CatalogItemField` | `(catalogItemId, key)` unique | Unique index |
| `RequestFieldValue` | `(requestId, fieldKey)` unique | Unique index; the row carries the field snapshot (`C3`) |
| `ReferenceSequence` | `(organizationId, type, period)` unique | Unique index; allocation is an atomic `INSERT … ON CONFLICT DO UPDATE` (`22` §4) |
| `Comment` | — | Index `(organizationId, entityType, entityId, createdAt)`; internal-note filtering is a query predicate, not a constraint |
| `Asset` | `assetTag` unique | Unique index |
| `AuditLog` | append-only | DB trigger rejecting UPDATE/DELETE (`31` §3.3) |
| `Notification` | `dedupeKey` unique — `(eventId, recipient, channel)` | Unique index (`29` N3) |
| `Notification` | `status` ∈ allowed set | Enum type |
| `Notification` | delivery records for a tenant / by status | Indexes `(organizationId, status)`, `(status, createdAt)`, `(userId, channel, readAt, createdAt)` |
| `NotificationPreference` | `(userId, eventType, channel)` unique | Unique index (`29` §7); a TRANSACTIONAL event is refused a disabling row by the service (`29` N6) |
| `ArticleCategory` | `(organizationId, parentId, name)` unique | Unique index (`27` §3) |
| `Article` | `(organizationId, slug)` unique | Unique index; a slug change writes an `ArticleSlugRedirect` first (`27` AC5) |
| `Article` | deletion prohibited | No delete path; archiving is the end state (`27` K7) |
| `ArticleSlugRedirect` | `(organizationId, fromSlug)` unique | Unique index |
| `ArticleVersion` | `(articleId, version)` unique; immutable | Unique index; no update path (`27` §4) |
| `KnowledgeLink` | `(organizationId, articleId, entityType, entityId)` unique | Unique index; the row stores the **version** linked (`27` K6) |
| `AssetType` | `(organizationId, key)` unique | Unique index (`28` §2) |
| `Asset` | `(organizationId, tag)` unique; `(organizationId, serialNumber)` unique when present | Unique indexes (`28` AM2); `tag` is allocated by an atomic counter (`22` §4) |
| `Asset` | deletion prohibited | No delete path; retirement is the end state (`28` AM5) |
| `AssetAssignment` | at most one **open** interval per asset | Partial unique index `... WHERE returned_at IS NULL` (`28` AM1) |
| `AssetAssignment` | `holder_type` agrees with the holder column | `CHECK` constraint (`28` §3) |

**Case-insensitive uniqueness is a write-path invariant.** A functional unique index
(`lower(email)`) is not expressible in Prisma, so the normalised value is stored
(`email`, `nameKey`) and a plain unique index enforces it — the service normalises on
write, and the index is what makes it true under concurrency.

**Application-level checks duplicate, never replace, constraints.** A service may
return a friendly `409` before the database rejects the write; the database
constraint is what guarantees it under concurrency.

## 3. Access Patterns → Indexes

| # | Query | Index |
|---|---|---|
| Q1 | Requests by status, newest first | `(status, createdAt DESC)` |
| Q2 | My requests | `(requesterId, createdAt DESC)` |
| Q3 | Team queue | `(teamId, status, createdAt DESC)` |
| Q4 | Assigned to me, open only | `(assigneeId, status)` partial `WHERE status NOT IN ('CLOSED','CANCELLED')` |
| Q5 | Requests by catalog item | `(catalogItemId)` |
| Q6 | SLA sweep: clocks approaching target | `(state, targetAt)` |
| Q7 | SLA breach history for reporting | `(breachedAt)` partial `WHERE breachedAt IS NOT NULL` |
| Q8 | Incident by impact/urgency | `(impact, urgency)` |
| Q9 | Open work by priority across teams | `(priority, status, createdAt DESC)` |
| Q10 | Comments for a parent | `(entityType, entityId, createdAt)` |
| Q11 | Attachments for a parent | `(entityType, entityId)` |
| Q12 | Tasks for a parent | `(parentType, parentId, status)` |
| Q13 | Pending approvals for an approver | `approval_workflows(organizationId, status)` → `approval_steps(status)` → `approval_step_approvers(stepId, approverId)` unique |
| Q14 | Approval steps for a workflow | `approval_steps(workflowId, stepOrder)` unique |
| Q15 | Published articles by category | `(status, categoryId, updatedAt DESC)` |
| Q16 | Article full-text search | GIN on `to_tsvector(title, body)` |
| Q17 | Assets by custodian | `(custodianId, status)` |
| Q18 | Asset assignment history | `(assetId, assignedAt DESC)` |
| Q19 | Undelivered notifications | `(status, createdAt)` partial `WHERE status = 'PENDING'` |
| Q20 | Audit by entity | `(entityType, entityId, occurredAt DESC)` |
| Q21 | Audit by actor over time | `(actorId, occurredAt DESC)` |
| Q22 | Audit by correlation id | `(correlationId)` |
| Q23 | Outbox drain, oldest first | `outbox(processedAt, occurredAt)` |
| Q24 | Failed jobs for replay | `(status, lastAttemptAt)` partial `WHERE status IN ('FAILED','DEAD')` |
| Q25 | Identity by email (login) | `users(email)` unique |
| Q26 | Session by token digest (every request) | `sessions(tokenHash)` unique |
| Q27 | Reset / invitation by token digest | `password_reset_tokens(tokenHash)`, `invitations(tokenHash)` unique |
| Q28 | Invitations for an address in a tenant | `(organizationId, email)` |
| Q29 | Entitlements for a user (per request) | `user_roles(userId)` (unique `(userId, roleId)`) → `role_permissions(roleId)` |
| Q30 | Platform operator roster | `users(organizationId)` |
| Q31 | Active catalog items by category | `catalog_items(organizationId, status)` |
| Q32 | Catalog item fields in order | `catalog_item_fields(catalogItemId, displayOrder)` |
| Q33 | My requests, newest first | `service_requests(organizationId, requesterId, createdAt DESC)` |
| Q34 | Team queue by status | `service_requests(organizationId, assigneeId, status)` |
| Q35 | Tenant queue newest first | `service_requests(organizationId, status, createdAt DESC)` |
| Q36 | Requests by reference | `service_requests(organizationId, reference)` unique |
| Q37 | Conversation for a record | `comments(organizationId, entityType, entityId, createdAt)` |
| Q38 | Open SLA clocks due for breach sweep | `sla_clocks(state, targetAt)` |
| Q39 | Clock for a record | `sla_clocks(organizationId, entityType, entityId)` |
| Q40 | My reported incidents, newest first | `incidents(organizationId, reporterId, createdAt DESC)` |
| Q41 | Incidents assigned to a user, by status | `incidents(organizationId, assigneeId, status)` |
| Q42 | Tenant incident queue, newest first | `incidents(organizationId, status, createdAt DESC)` |
| Q43 | Major incidents (surfaced first) | `incidents(organizationId, isMajor)` |
| Q44 | Incidents by reference | `incidents(organizationId, reference)` unique |
| Q45 | Incident history projection | `audit_logs(organizationId, entityType, entityId, occurredAt DESC)` |
| Q46 | Tasks for a parent, by status | `tasks(organizationId, parentType, parentId, status)` |
| Q47 | My tasks | `tasks(organizationId, assigneeId, status)` |
| Q48 | Overdue tasks (derived sweep) | `tasks(organizationId, status, dueAt)` |
| Q49 | Clocks due for at-risk marking | `sla_clocks(state, warnAt)` (partial `WHERE stoppedAt IS NULL`) |
| Q50 | Workflow for a request | `approval_workflows(requestId)` unique |
| Q51 | Decision history for a workflow | `approval_decisions(organizationId, workflowId, decidedAt)` |
| Q52 | A decision by an approver on a step (idempotency check) | `approval_decisions(stepId, approverId)` |
| Q53 | Steps due for expiry handling | `approval_steps(status, deadlineAt)` |
| Q54 | Notification for a recipient on an event (idempotency lookup) | `notifications(dedupeKey)` unique |
| Q55 | Failed/dead notifications for the delivery monitor | `notifications(status, createdAt)` |
| Q56 | Records matching a term (scoped search) | GIN expression indexes over `to_tsvector('english', …)` on `service_requests`, `incidents`, `catalog_items`, `users` (migration `20261006082530_search_fts`); `30` §2.2 |
| Q57 | SLA attainment over a period | `sla_clocks(organizationId, startedAt)` |
| Q58 | The caller's in-app notifications (unread first) | `notifications(userId, channel, readAt, createdAt)` |
| Q59 | A recipient's preference for an event and channel | `notification_preferences(userId, eventType, channel)` unique |
| Q60 | Queued report exports for the worker | `report_exports(status, createdAt)` (claim is a conditional `UPDATE … WHERE status = 'QUEUED'`) |
| Q61 | A requester's export jobs | `report_exports(requestedById, status)` |
| Q62 | An organization's export jobs (support/quota) | `report_exports(organizationId, status)` |
| Q63 | Published articles a reader may see, newest first | `articles(organizationId, status, updatedAt)` + `articles(organizationId, visibility, status)` (`27` §10) |
| Q64 | Articles in a category | `articles(organizationId, categoryId)` |
| Q65 | A retired slug resolves to its article | `article_slug_redirects(organizationId, fromSlug)` unique (`27` AC5) |
| Q66 | The published snapshot for a version | `article_versions(articleId, version)` unique (`27` §4) |
| Q67 | Links shown on a record | `knowledge_links(organizationId, entityType, entityId)` (`27` §8) |
| Q68 | The register filtered by state, type or holder | `assets(organizationId, state, createdAt)`, `assets(organizationId, assetTypeId)`, `assets(organizationId, assignedToUserId)`, `assets(organizationId, assignedToTeamId)` (`28` §8) |
| Q69 | An assignment interval history | `asset_assignments(organizationId, assetId, assignedAt)` (`28` §8) |
| Q70 | Records matching a term, including knowledge and assets | GIN expression indexes on `articles` and `assets` (migrations `20261007044147_knowledge_base_and_assets`, `20261007051500_assets_search_idx`); `30` §2.1 |

**Two of the `27`/`28` constraints are not expressible in the schema language** and are
added by raw SQL in their migration: the partial unique index
`asset_assignments_one_open_per_asset` (at most one open assignment — a plain unique
index would forbid history, `28` AM1) and the `CHECK`
`asset_assignments_holder_exactly_one` (holder type agrees with the holder column,
`28` §3).

The tenant list (`GET /platform/organizations`) orders by `createdAt DESC, id DESC` on
a **deliberately small** table and is served by a sequential scan; an index is added only
when the row count justifies it (§1). The same reasoning applies to the platform operator
roster.

All foreign keys are indexed. PostgreSQL does not create these automatically, and a
missing FK index turns every parent delete/update into a table scan.

## 4. Index Rules

1. **Composite column order** follows selectivity: equality columns first, then range
   columns, matching the query's `ORDER BY` where possible so the sort is satisfied
   by the index.
2. **Partial indexes** are preferred when a query always filters on one value (open
   work, pending jobs). They are smaller and cheaper to maintain.
3. **Covering indexes** (`INCLUDE`) only when a hot query's heap fetches are measurable.
4. **No index on low-cardinality booleans alone** — combine with a selective column.
5. **Maximum warnings:** > 6 indexes on a table, or > 5 indexes on a hot write table
   (audit, notifications, comments) triggers review.
6. **Unused index audit** at each phase gate: drop indexes with zero scans.
7. **Index creation in production is concurrent** (`CREATE INDEX CONCURRENTLY`) and
   never inside a transaction block (`10`).
8. **Tenant-scoped indexes lead with `organizationId`** so the mandatory tenant
   predicate is always index-supported (`ADR-0002`).

## 5. Query Rules

| Rule | Why |
|---|---|
| Select only needed columns | Avoids transferring large text/JSON payloads |
| Always paginate collections | Unbounded lists are how a database dies |
| Never loop queries per row | N+1 is the most common performance defect here |
| Prefer `select` + `include` deliberately | Eager-load what is rendered; nothing more |
| Aggregate in the database | Not by fetching rows and summing in Node |
| Avoid `OR` across different columns | Prevents index use; restructure or use a union |
| No leading-wildcard `LIKE` | Not indexable; use full-text search (`30`) |
| Explicit `ORDER BY` on every list | Otherwise pagination is non-deterministic |
| Bound every date range | An unbounded range is an unbounded scan |
| Statement timeout on every query | `33` §Resource limits |

**Explicitly prohibited queries:** offset pagination on large tables,
`SELECT *`, aggregations over an entire audit table, and any query whose result set
size is not bounded by a limit or a filter.

## 6. Pagination Contract

**Cursor-based** for all user-facing collections. Offset pagination degrades linearly
and produces skipped/duplicated rows when data changes between pages — visible in a
busy ticket queue.

| Aspect | Rule |
|---|---|
| Sort key | Always a stable, unique, indexed tuple (e.g. `(createdAt, id)`) |
| Cursor | Opaque, encodes the tuple; never a raw offset |
| Page size | Default 25, maximum 100; larger requests are rejected, not clamped silently |
| Response | `items`, `nextCursor`, `hasMore` |
| Total counts | Only where genuinely needed; expensive counts are computed async |

Wire format: `11-API-CONTRACT.md` §6.

## 7. Transaction Rules

| Rule | Rationale |
|---|---|
| Open a transaction only when > 1 write is involved | Transactions are not free |
| Keep transactions short | Long transactions hold locks and block vacuum |
| Never perform an external call inside a transaction | External latency becomes lock time |
| Never enqueue a job inside a transaction — use the outbox | Enqueue-before-commit delivers phantom events (`04` §11) |
| Choose isolation deliberately | Default read-committed; use explicit locking for contention |
| Retry only on serialization failure | And only for idempotent units |
| Set a statement timeout inside the transaction | Prevents a runaway query holding locks |

**Concurrency-sensitive operations** (reference generation, approval step advance,
SLA clock update, bulk assignment) use `SELECT ... FOR UPDATE` or a unique-constraint
retry loop. Last-write-wins on a state machine is a correctness bug, not a conflict
to be ignored.

## 8. Verification

| Check | Mechanism | Frequency |
|---|---|---|
| Index usage | `pg_stat_user_indexes` review | Phase gate |
| Missing index | Slow-query log + `EXPLAIN ANALYZE` | Continuous |
| Sequential scans on large tables | Monitoring alert (`34`) | Continuous |
| Bloat / dead tuples | `pg_stat_user_tables` | Monthly |
| Unused indexes | Scan counters | Phase gate |
| Migration lock impact | Migration review checklist (`10`) | Every migration |

## 9. Related

- `08-DATA-MODEL.md` — entities these indexes serve
- `10-MIGRATIONS-AND-SEEDING.md` — creating indexes safely in production
- `11-API-CONTRACT.md` — the pagination wire format
- `33-SCALABILITY-AND-DATABASE-PROTECTION.md` — pooling, timeouts, replicas
