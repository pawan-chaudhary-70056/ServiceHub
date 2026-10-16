# 11 — API Contract

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** Frontend Lead · **Approved:** 2026-10-01
**Consolidates:** old 20, 21, 22, 26, 30 (API specification, endpoints,
request/response, error handling, OpenAPI)

> **Scope:** the wire contract — conventions, shapes, status codes, endpoints.
> Payload *validation rules* are `12`. *Why* an endpoint exists is `02` and the
> feature docs.

---

## 1. Conventions

| Aspect | Rule |
|---|---|
| Base path | `/api/v1` |
| Media type | `application/json; charset=utf-8` (errors: `application/problem+json`) |
| Encoding | UTF-8 |
| Field naming | `camelCase` |
| Timestamps | ISO 8601 with offset, UTC (`2026-09-26T14:03:11.000Z`) |
| Dates | `YYYY-MM-DD` (no time, no zone) |
| Durations | Integer + unit in the key (`targetMinutes`) |
| IDs | Opaque strings. Never numeric, never sequential |
| Enumerations | `SCREAMING_SNAKE_CASE` in the wire format |
| Booleans | Prefixed `is`/`has` |
| Money | `{ amount: 1250, currency: "GBP" }` |
| Null | Explicit `null` for "known to be empty"; omit for "not applicable" |
| Unknown fields in request | Rejected (`strict`) — see `12` |

## 2. Resource Design

- Plural, lowercase, hyphen-free resource nouns: `/requests`, `/incidents`, `/assets`.
- Hierarchy only for genuine ownership: `/requests/{id}/comments`,
  `/requests/{id}/tasks`. Never more than two levels deep.
- Actions that are not CRUD are sub-resources with a verb, POST-only:
  `/requests/{id}/transition`, `/approvals/{id}/decide`, `/sla/clocks/{id}/recalculate`.
- No verbs in resource paths otherwise: not `/getRequests`.

| Method | Semantics | Idempotent |
|---|---|---|
| `GET` | Read | Yes |
| `POST` | Create, or non-CRUD action | No (unless `Idempotency-Key`) |
| `PATCH` | Partial update (JSON merge patch semantics) | Yes |
| `PUT` | Full replace — used only where replace is the meaning | Yes |
| `DELETE` | Retire/remove | Yes |

## 3. Status Codes

| Code | Used for |
|---|---|
| `200` | Successful read/update |
| `201` | Created (with `Location` header) |
| `202` | Accepted for async processing (returns job handle) |
| `204` | Successful action with no body |
| `400` | Malformed request (unparseable, not a validation failure) |
| `401` | Not authenticated |
| `403` | Authenticated but not entitled |
| `404` | Not found **or** not visible (see `07` §1) |
| `409` | Conflict: illegal state transition, duplicate, optimistic-lock failure |
| `410` | Gone: retired resource referenced by an old client |
| `413` | Payload too large |
| `415` | Unsupported media type |
| `422` | Validation failure (well-formed but invalid) |
| `423` | Locked (account lockout) |
| `429` | Rate limited (with `Retry-After`) |
| `500` | Unhandled server error (never leaks internals) |
| `503` | Dependency unavailable, health-based rejection |

**`400` vs `422` is deliberate:** `400` means the request could not be parsed at all;
`422` means it parsed and failed validation, with field-level detail.

## 4. Error Envelope

Errors use a problem-detail shape so a client can render field errors without
string-matching messages.

```json
{
  "type": "https://servicehub.example/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "3 fields failed validation",
  "instance": "/api/v1/requests",
  "code": "VALIDATION_FAILED",
  "correlationId": "01J8Z6Q0K3W9M2",
  "errors": [
    { "field": "title", "code": "TOO_SHORT", "message": "Must be at least 5 characters" },
    { "field": "priority", "code": "INVALID_ENUM", "message": "Unknown priority" },
    { "field": "approvers[0].id", "code": "NOT_FOUND", "message": "Approver does not exist" }
  ]
}
```

| Field | Meaning |
|---|---|
| `type` | Stable URI identifying the error class |
| `title` | Short human description (not for parsing) |
| `status` | Mirrors the HTTP status |
| `detail` | Explanation for this instance |
| `instance` | The request path |
| `code` | **Stable machine code** — clients branch on this, never on `message` |
| `correlationId` | Ties the response to logs and audit records |
| `errors[]` | Field-level detail; present only for validation failures |

### Error code registry (excerpt — extend, never rename)

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 422 | One or more fields invalid |
| `UNAUTHENTICATED` | 401 | No valid session/token |
| `FORBIDDEN` | 403 | Role or object check failed |
| `NOT_FOUND` | 404 | Absent or not visible |
| `ILLEGAL_TRANSITION` | 409 | State machine rejected the move |
| `CONFLICT` | 409 | The resource exists but is not in a state that allows the action (e.g. a retired catalog item is no longer requestable) |
| `DUPLICATE` | 409 | Uniqueness violated |
| `VERSION_CONFLICT` | 409 | Optimistic lock failed |
| `RATE_LIMITED` | 429 | Bucket exhausted |
| `ACCOUNT_LOCKED` | 423 | Lockout active |
| `INTERNAL` | 500 | Unexpected; never carries a stack trace |

**Codes are a public contract.** Renaming one is a breaking change; adding one is not.
Client behaviour keys on `code`, so a human-readable `message` may change freely.

**Leakage rules:** no stack traces, no SQL, no internal paths, no other users' data in
any error. `500` responses carry only `code`, `correlationId` and a generic title; the
detail lives in the logs.

## 5. Success Envelopes

| Case | Shape |
|---|---|
| Single resource | The resource object, bare |
| Collection | `{ "items": [...], "nextCursor": "...", "hasMore": true }` |
| Action accepted async | `{ "jobId": "...", "status": "QUEUED", "statusUrl": "..." }` |
| Action completed | The updated resource, or `204` |

No universal `{ data, meta }` wrapper: it adds a level of indirection to every read
for no benefit, and collections already need their own shape.

## 6. Pagination, Filtering, Sorting

**Request**

```
GET /api/v1/requests
  ?status=IN_PROGRESS,APPROVAL_PENDING      comma = OR within a field
  &priority=HIGH
  &teamId=team_123
  &assigneeId=user_456
  &createdFrom=2026-09-01T00:00:00Z
  &createdTo=2026-09-30T23:59:59Z
  &slaState=AT_RISK
  &sort=-createdAt                          "-" = descending
  &limit=25
  &cursor=eyJjcmVhdGVkQXQiOi...
```

| Aspect | Rule |
|---|---|
| Filtering | Named, typed query parameters. Repeated fields AND; commas within a field OR |
| Unknown filter | Rejected with `422`, not ignored — silently ignoring a filter returns wrong data |
| Sorting | Allow-list of sortable fields only; anything else → `422` |
| Default sort | `-createdAt`, with `id` as a tiebreaker for stability |
| `limit` | Default 25, maximum 100; above maximum is rejected, not clamped |
| Cursor | Opaque, encodes `(sortValue, id)`; a malformed cursor → `422` |
| Offset | **Not supported** on collections |
| Counts | Only on endpoints that declare a `total`; computed asynchronously when expensive |

**Why cursors:** offset pagination over a busy ticket queue skips or duplicates rows
as data shifts between requests. That is a visible correctness bug in this domain, not
a performance nicety (`09` §6).

## 7. Write Semantics

| Concern | Rule |
|---|---|
| Idempotency | Mutating endpoints accept `Idempotency-Key`; the same key returns the original result rather than repeating the effect |
| Optimistic concurrency | Resources expose `version`; `PATCH` may send `If-Match: "7"`; a stale version → `409 VERSION_CONFLICT` |
| Partial update | `PATCH` merges; `null` clears a nullable field explicitly |
| Mass assignment | Only documented fields are accepted; anything else → `422` |
| Returning the result | Mutations return the updated resource so the client does not need a follow-up read |
| Bulk operations | Return per-item outcome, never a single blanket status |

`Idempotency-Key` matters wherever a retry is likely: create request, decide approval,
submit transition, upload file. The client cannot distinguish "timed out" from
"failed", so the server must.

## 8. Authentication, Rate Limiting, Request Metadata

| Header | Direction | Purpose |
|---|---|---|
| `Authorization` / session cookie | → | Caller identity (server-side session, `ADR-0001`) |
| `X-CSRF-Token` | → | Required on state-changing requests if cookie-based |
| `X-Correlation-Id` | ↔ | Optional inbound; always echoed |
| `Idempotency-Key` | → | Duplicate suppression |
| `If-Match` | → | Optimistic concurrency |
| `Retry-After` | ← | On `429`/`423` |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | ← | Caller-visible quota |
| `Location` | ← | On `201` |

## 9. Endpoint Catalogue

Every endpoint declares: permission required, object-level rule, rate-limit class,
whether it is paginated, and its audit event.

### Identity (`06`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | public | Strictest bucket |
| POST | `/auth/logout` | authenticated | Revokes server-side |
| POST | `/auth/forgot` | public | Always `202` |
| POST | `/auth/reset` | public | Token-based; revokes sessions |
| POST | `/auth/accept-invitation` | public | Establishes first credential; single-use (`06` §11) |
| GET | `/auth/me` | authenticated | Identity + effective entitlements |
| GET | `/auth/sessions` | authenticated | The caller's own live sessions (`06` §7): activity, source address/agent and `current`. Scoped to the authenticated user — there is no id to substitute |
| DELETE | `/auth/sessions/{id}` | authenticated | Revokes one of the caller's own sessions, immediately and audited (`session.revoke`); another user's session is a `404`, not a `403` (`17` §5) |

### Platform (`ADR-0012`, `07` §5)
Platform operations are separate from tenant administration: a platform operator holds
`platform:*` permissions, belongs to no organization, and cannot read or administer
tenant records.
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/platform/organizations` | `platform:organization:manage` | Cursor-paginated tenants |
| POST | `/platform/organizations` | `platform:organization:manage` | Provisions tenant + first administrator + invitation |
| POST | `/platform/organizations/{id}/suspend` | `platform:organization:manage` | |
| POST | `/platform/organizations/{id}/activate` | `platform:organization:manage` | |
| GET | `/platform/operators` | `platform:operator:manage` | Platform operator roster |

### Users, Teams, Roles (`07`)
| Method | Path | Permission |
|---|---|---|
| GET | `/users` | `user:manage` — tenant-scoped list |
| POST | `/users` | `user:manage` — invite (creates identity + invitation) |
| GET/POST | `/users`, `/users/{id}` | `user:manage` (self for own profile) |
| PATCH | `/users/{id}` | `user:manage` (limited fields for self) |
| POST | `/users/{id}/deactivate` | `user:manage` |
| GET | `/roles` | `user:manage` — tenant-assignable roles only |
| GET | `/teams` | `catalog:read` — tenant's active teams, for routing pickers |
| POST | `/teams` | `user:manage` — creates a team; a duplicate name in the tenant is a `409` |
| GET | `/teams/{id}/members` | `user:manage` — the team and its members |
| POST | `/teams/{id}/members` | `user:manage` — adds or re-roles a member; audited. The target must be an active user of the **same tenant** (`422` otherwise), because membership is what team scope resolves to (`07` §6) |
| DELETE | `/teams/{id}/members/{userId}` | `user:manage` — removes a member; idempotent and audited |
| GET/PUT | `/roles/{id}/permissions` | `user:role:manage` |

### Catalog (`21`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/catalog/categories` | `catalog:read` | Flattened tree with item counts; `includeInactive` honoured for managers only |
| POST | `/catalog/categories` | `catalog:manage` | Max three levels (C7) |
| PATCH | `/catalog/categories/{id}` | `catalog:manage` | Rename, re-parent (cycle-checked), activate/deactivate |
| GET | `/catalog/items` | `catalog:read` | Cursor-paginated; ACTIVE-only for non-managers |
| POST | `/catalog/items` | `catalog:manage` | Creates a DRAFT with its fields |
| GET | `/catalog/items/{id}` | `catalog:read` | 404 for a draft/retired item to a non-manager |
| PATCH | `/catalog/items/{id}` | `catalog:manage` | Edits item and/or replaces its field set |
| POST | `/catalog/items/{id}/activate` | `catalog:manage` | Rule C1: requires category, SLA policy, fulfilment team |
| POST | `/catalog/items/{id}/retire` | `catalog:manage` | Status change, never a delete (C5) |

### SLA configuration (`25`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/sla/calendars` | `sla:policy:manage` | Business calendars |
| POST | `/sla/calendars` | `sla:policy:manage` | Working hours or 24×7 (ADR-0008) |
| GET | `/sla/policies` | `sla:policy:manage` | Policies with target matrix and calendar |
| GET | `/sla/policies/{id}` | `sla:policy:manage` | |
| POST | `/sla/policies` | `sla:policy:manage` | Creates a policy and its priority targets |
| PATCH | `/sla/policies/{id}` | `sla:policy:manage` | Edits; in-flight clocks keep their frozen targets |

### Requests (`22`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/requests` | `request:create` | Freezes the SLA policy and field snapshot; `409 CONFLICT` if the item is not ACTIVE, `422` if a required field is missing |
| GET | `/requests` | one of `request:read.own` / `.team` / `.any` | Cursor-paginated; the service applies the object-level scope |
| GET | `/requests/{id}` | one of the read grants | Out-of-scope reads as `404` |
| POST | `/requests/{id}/transition` | target-state rule | `409 ILLEGAL_TRANSITION`; `422` without an assignee before `IN_PROGRESS` or without a note to `FULFILLED` |
| POST | `/requests/{id}/assign` | `request:assign` | Assignee/team must belong to the tenant |
| POST | `/requests/{id}/cancel` | `request:cancel.own` (own) or `request:close.any` | |
| POST | `/requests/{id}/comments` | one of the read grants | `INTERNAL` requires an agent; a requester must never receive one |
| GET | `/requests/{id}/comments` | one of the read grants | Internal notes filtered in the query |
| PATCH | `/requests/{id}` | `request:update.*` | Not yet implemented |
| GET | `/requests/{id}/history` | (not implemented) | The capability is served by the generic `/audit/records/{entityType}/{entityId}` projection (`31` §10), which a participant reads through the record's own visibility |
| GET | `/requests/{id}/knowledge-links` | one of the read grants | Linked articles (`27` §8); **each resolves to the version linked at the time** (rule K6), and an archived article still resolves with a banner |
| POST | `/requests/{id}/knowledge-links` | `kb:article:read` | Links a published article the caller may read; the parent's own visibility decides whether the link may be added |

### Incidents (`23`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/incidents` | `incident:create` | Any authenticated user may report; priority is **derived**, never supplied; `201` with a generated `INC-YYYY-NNNNNN` reference and a started clock |
| GET | `/incidents` | one of `incident:read.own` / `.team` / `.any` | Cursor-paginated; majors first, then newest; optional `status`, `majorOnly` |
| GET | `/incidents/{id}` | one of the read grants | Out-of-scope reads as `404` |
| PATCH | `/incidents/{id}` | `incident:update.any` | Changing `impact`/`urgency` re-derives priority; an explicit `priority` is an **override** requiring `incident:priority:override` **and** a `reason` (`422` without one) |
| POST | `/incidents/{id}/assign` | `incident:update.any` | A `NEW` incident with an assignee moves to `IN_PROGRESS`; assignee/team must belong to the tenant |
| POST | `/incidents/{id}/resolve` | `incident:update.any` | Requires `resolutionSummary` (`422` without); stops the clock |
| POST | `/incidents/{id}/close` | reporter or `incident:update.any` | `RESOLVED → CLOSED`; `409 ILLEGAL_TRANSITION` otherwise |
| POST | `/incidents/{id}/reopen` | reporter or `incident:update.any` | `RESOLVED`/`CLOSED → IN_PROGRESS`; outside the configured window (`INCIDENT_REOPEN_WINDOW_HOURS`) requires an update permission **and** a `reason`; starts a new clock cycle and increments `reopenCount` |
| POST | `/incidents/{id}/major` | `incident:update.any` | Toggles `isMajor`; audited in **both** directions |
| GET/POST | `/incidents/{id}/comments` | one of the read grants | `INTERNAL` requires an agent; a reporter must never receive one |
| GET | `/incidents/{id}/history` | one of the read grants | Audit projection (`31` §8) |
| GET | `/incidents/{id}/knowledge-links` | one of the read grants | Linked articles (`27` §8), resolved to the version linked at the time (rule K6) |
| POST | `/incidents/{id}/knowledge-links` | `kb:article:read` | Links a published article the caller may read |

### Tasks (`24`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/requests/{id}/tasks`, `/incidents/{id}/tasks` | `task:create` | Nested creation; `409` on a terminal parent; assignee must belong to the tenant |
| GET | `/requests/{id}/tasks`, `/incidents/{id}/tasks` | inherits the parent's read scope | A task never outlives its parent's visibility (rule T2) |
| GET | `/tasks` | any of `task:update.own` / `.team` / `.any` | "My tasks", cursor-paginated; `overdue` is **derived**, never stored |
| GET | `/tasks/{id}` | inherits the parent's read scope | Out-of-scope reads as `404` |
| PATCH | `/tasks/{id}` | assignee (`task:update.own`), team (`task:update.team`) or `task:update.any` | Title, description, due date, assignee |
| POST | `/tasks/{id}/assign` | as PATCH | Assignee need not be on the parent's team, but the change is audited (T5) |
| POST | `/tasks/{id}/transition` | as PATCH; `task:cancel` to cancel | `TODO → IN_PROGRESS ⇄ BLOCKED → DONE`; `BLOCKED` requires `blockedReason` (`409`), cancel requires `task:cancel` and a reason; `DONE`/`CANCELLED` are terminal (`409`) |

### Approvals (`26`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/approvals/pending` | `approval:decide` | The caller's **own** pending decisions only; a step appears here only where the caller is a designated approver (A5) |
| GET | `/requests/{id}/approvals` | the request's own read scope | Workflow progress for the request — steps, their decisions, and the current pause duration; `404` when the caller may not see the request |
| POST | `/approvals/{id}/decide` | `approval:decide` **and** a designated approver for the **active** step | `{ id }` is the **step** id; body `{ decision, comment }`; a rejection requires a comment (`422`); the requester may never decide their own request; an idempotency replay returns the original outcome (`recorded:false`) rather than `409`; a decision on a superseded step is `409` |
| POST | `/approvals/{id}/reassign` | `approval:reassign` | Replaces the step's approver snapshot; audited |
| GET | `/admin/approval-templates` | `admin:config` | Tenant templates |
| POST | `/admin/approval-templates` | `admin:config` | `{ catalogItemId, name, steps:[{ stepOrder, mode, approverRoleKey }] }`; `201` with `Location`. A catalog item may only enter `APPROVAL_PENDING` once an activated item has an active template with a non-empty eligible approver snapshot — otherwise `409` |

### SLA (`25`)
| Method | Path | Permission |
|---|---|---|
| GET | `/sla/clocks/{id}` | scoped |
| POST | `/sla/clocks/{id}/override` | `sla:clock:override` + reason |

### Knowledge base (`27`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/kb/articles` | `kb:article:read` | Visibility-filtered **in the query, before ranking** (rule K3); cursor-paginated; `status`/`categoryId` filters. A plain reader is served the **published snapshot**, never an unreviewed working copy (`27` AC2) |
| GET | `/kb/articles/{id}` | `kb:article:read` | Accepts the opaque id **or** the slug. A retired slug redirects to its article (AC5). A caller who may not read the article receives `404`, not `403`. An archived article resolves with `archived: true` |
| POST | `/kb/articles` | `kb:article:author` | Creates a draft; body is Markdown and **raw HTML is rejected** (K2); `409 DUPLICATE` on a slug collision |
| PATCH | `/kb/articles/{id}` | `kb:article:author` | Edits the **working copy**; a published article's snapshot is untouched until republish (AC2). A slug change records a redirect (AC5) |
| POST | `/kb/articles/{id}/submit` | `kb:article:author` | `DRAFT → IN_REVIEW` |
| POST | `/kb/articles/{id}/reject` | `kb:article:publish` | `IN_REVIEW → DRAFT`; reason required |
| POST | `/kb/articles/{id}/publish` | `kb:article:publish` | Creates an immutable version; the reviewer must differ from the author (`409`, rule K1) |
| POST | `/kb/articles/{id}/archive` | `kb:article:publish` | Leaves search; direct links still resolve (AC4). Deletion does not exist (K7) |
| POST | `/kb/articles/{id}/unarchive` | `kb:article:publish` | `ARCHIVED → PUBLISHED` |
| POST | `/kb/articles/{id}/feedback` | `kb:article:read` | Helpful / not-helpful (§9) |
| GET | `/kb/categories`, `/kb/stats` | `kb:article:read` | Browse tree and the status board |
| POST/PATCH | `/kb/categories`, `/kb/categories/{id}` | `admin:config` | Category management |

### Assets (`28`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/assets` | `asset:read.own` and/or `asset:read.any` | Holder-scoped **in the query**; cursor-paginated; `state`/`assetTypeId`/`holderUserId` filters. A holder sees what they hold |
| GET | `/assets/{id}` | as above | Accepts the opaque id **or** the `AST-000123` tag. Out-of-scope reads as `404` |
| POST | `/assets` | `asset:manage` | Registers an asset; the **tag is allocated server-side** (`AST-000123`, atomic per tenant); required type attributes are validated (AM7) |
| PATCH | `/assets/{id}` | `asset:manage` | Field edits. `ASSIGNED`/`DISPOSED` are **not** settable here — they are transitions (AM6); `409` while an assignment is open |
| GET | `/assets/{id}/assignments` | as read | The full interval history, including the open interval |
| POST | `/assets/{id}/assign` | `asset:assign` | `{ holderType, userId \| teamId, notes? }`; `409` when an assignment is already open (AM1) or the holder is deactivated; sets `state = ASSIGNED` **in the same transaction** (AM6) |
| POST | `/assets/{id}/return` | `asset:assign` | Closes the interval with `returnedAt` — the row is kept as history (AM3) |
| POST | `/assets/{id}/repair` | `asset:manage` | Moves into repair, closing any open assignment |
| POST | `/assets/{id}/retire` | `asset:manage` | Closes any open assignment; read-only afterwards (AM4). Never a delete (AM5) |
| POST | `/assets/{id}/dispose` | `asset:manage` | `RETIRED → DISPOSED`, terminal |
| GET/POST/PATCH | `/admin/asset-types`, `/admin/asset-types/{id}` | `asset:read.*` to read; `admin:config` to manage | Type definitions with their required-attribute schema |

### Platform (`29`–`32`)
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | The caller's in-app notifications; cursor-paginated; the page carries `unreadCount` |
| POST | `/notifications/{id}/read`, `/notifications/read-all` | Self only; idempotent. A notification the caller does not own is a `404` |
| GET/PUT | `/me/notification-preferences` | Self only; per event and channel. A TRANSACTIONAL event (`29` N6) cannot be disabled — the request is refused with `422`, not silently ignored |
| GET | `/search` | Unified search across readable sources; **no single permission** — each source is scoped to the caller (`30` §2.3 S1). Params `q`, `types`, `limit`, `cursor`; response states the sources searched and any `EXACT_ONLY` fallback |
| GET | `/reports/{metric}` | `report:read`; a cross-team metric (`sla.attainment`, `notifications.delivery`) needs `report:read.all` (`30` §4). Metrics: `requests.summary`, `requests.resolution`, `incidents.summary`, `incidents.mttr`, `tasks.summary`, `tasks.workload`, `sla.attainment`, `notifications.delivery`, `approvals.turnaround`; an unknown name is a `404` rather than an empty report. Response carries period, time zone and scope (`30` §3.2 R2); a rate with an empty denominator is `null`, never `0`. The duration metrics state the calendars they measured against (`ADR-0008`) and carry both working-time and raw elapsed figures — the elapsed pair is the reproducibility anchor (`30` §3.2 R1) |
| POST | `/reports/{metric}/export` | `report:export`; queues an async job (`30` §3.1/§3.4), returns `202` with `{ export }` — never blocks on the aggregate. Body `{ from?, to? }`; audited with its filters (`30` R5) |
| GET | `/reports/jobs/{id}` | `report:export`; the caller's own export job and, once `SUCCEEDED`, its time-limited `downloadUrl` (`30` §5). Another user's job is a `404` |
| GET | `/reports/jobs/{id}/download` | `report:export`; the CSV — `text/csv` with a `Content-Disposition` filename, or a `302` to a short-lived signed object-storage URL when the driver issues one (`ADR-0004`, `19` §7.3). Refused with `404` unless the caller requested it and the link has not expired (`30` §5) |
| GET | `/audit` | `audit:read.team` and/or `audit:read.all` | Scoped **in the query** — `team` selects the caller's team members' entries, `all` the tenant; cursor-paginated; filters `action`, `actorId`, `entityType`, `entityId`, `from`, `to`, `securityOnly`. Security-class entries are **withheld**, not merely flagged, without `audit:read.security`; **every read is itself audited** (`31` §5, AC5) |
| GET | `/audit/security` | `audit:read.security` | The security class only (`31` §2); the request is refused outright for a caller without the grant, not returned empty |
| GET | `/audit/records/{entityType}/{entityId}` | the record's own visibility, or an audit read grant | A record's history without the security class (`31` §5/§10). A participant needs only to be able to read the record; an unauthorised caller receives the record's own `404` |
| POST | `/audit/export` | `audit:export` (+ any `audit:read.*`; `securityOnly` also needs `audit:read.security`) | Queues an async export (`31` §9/§10, `30` §5) and returns `202` with `{ export }` — never blocks on the query. Body is the explorer filter set without pagination; audited with its filters |
| GET | `/audit/exports/{id}` | `audit:export` | The caller's own export job (`30` §5); another user's job is a `404` |
| GET | `/audit/exports/{id}/download` | `audit:export` | The CSV while the link is live — streamed as `text/csv`, or a `302` to a signed object-storage URL when the driver issues one; refused with `404` unless the caller requested it and it has not expired |
| GET | `/admin/integrations` | `integration:read` | The health board (`32` §12/§13): one uniform row per integration (outbound subscription or inbound endpoint) with last success, last error, dead-letter count and a derived error rate; `healthy` is derived server-side and unhealthy rows are returned first |
| GET | `/admin/integrations/roster-sync` | `integration:read` | The last roster sync's outcome, counts and mapped-user total (`32` §6/§12); `NEVER_RUN` before the first run |
| POST | `/admin/integrations/roster-sync` | `integration:manage` | Runs a roster sync now; audited. Body `{ confirmDrift?: boolean }`. The service's drift guard **aborts** a run that would deactivate more than the configured fraction unless `confirmDrift` is set |
| GET | `/admin/webhooks` | `integration:read` | The tenant's webhook subscriptions with a dead-letter count (`32` §12). The signing secret is **never** returned; only a `secretHint` (last four characters) |
| GET | `/admin/webhooks/events` | `integration:read` | The subscribable event vocabulary (`32` §4), served from the outbox event catalogue so the admin UI cannot drift from the names the system emits |
| POST | `/admin/webhooks` | `integration:manage` | Creates a subscription (`32` §4). The signing secret is generated server-side and returned **once**, in this response only; audited (without the secret) |
| PATCH | `/admin/webhooks/{id}` | `integration:manage` | Edits a subscription or rotates its secret; audited. A rotation records `secretRotated: true`, never the secret |
| GET | `/admin/integrations/config` | `integration:read` | The integration catalogue (`32` §2/§12) merged with this tenant's settings: effective reliability knobs, the catalogue defaults they override, the enabled flag, a **credential reference** (`env:NAME`) and whether a runtime adapter is present. Never a credential value |
| PATCH | `/admin/integrations/config/{key}` | `admin:config` | Configures one integration (`32` §7/§11/§13); audited with a before/after that carries the reference but no secret. Body `{ enabled?, config?, credentialRef? }`. `config` is the `32` §8 reliability tuning (breaker/bulkhead/retry/timeout), validated per catalogue key; `credentialRef` must be a **reference** — a value is `422` |
| POST | `/admin/integrations/config/{key}/test` | `admin:config` | A bounded connectivity check (`32` §13); audited. Answers `OK`/`FAILED` for an integration with a single global endpoint and `SKIPPED` where reachability is per-endpoint and proved by delivery. Never sends live traffic |
| GET | `/admin/integrations/dead-letters` | `integration:read` | Dead-lettered deliveries, newest first (`32` §12/§13), with a total count |
| POST | `/admin/integrations/dead-letters/{id}/retry` | `integration:retry` | Requeues one delivery for another attempt chain; audited (`32` §11) |
| GET | `/admin/inbound-endpoints` | `integration:read` | The tenant's inbound receivers (`32` §5/§12). The verification secret is never returned; only a `secretHint` |
| POST | `/admin/inbound-endpoints` | `integration:manage` | Registers a receiver (`32` §5). The key is the `{provider}` path segment (unique, URL-safe); the verification secret is returned **once**; audited (without the secret) |
| PATCH | `/admin/inbound-endpoints/{id}` | `integration:manage` | Enable/disable or rotate the secret; audited. A rotation records `secretRotated: true` |
| GET | `/admin/integrations/inbound-dead-letters` | `integration:read` | Dead-lettered inbound events, newest first (`32` §5/§13), with a total count |
| POST | `/admin/integrations/inbound-dead-letters/{id}/retry` | `integration:retry` | Requeues one inbound event for another attempt chain; audited |
| POST | `/webhooks/inbound/{provider}` | **public** — HMAC signature over the raw body is the authentication | Receives an inbound delivery (`32` §5): **verify → persist the raw event → ack (`202`)**; processing is a worker, never this request. Unsigned, stale, malformed or duplicate deliveries are handled as §5 requires: the first three are `401`, a duplicate is a `202` no-op. Not CSRF-protected (no cookie session) but rate-limited |
| GET | `/attachments?entityType=&entityId=` | access inherits parent | A record's `AVAILABLE` attachments (`19` §7). `PENDING` and `QUARANTINED` rows are never listed |
| POST | `/attachments` | access inherits parent | Multipart upload (`19` §7.2): size-capped before the body is read, sniffed against the allow-list, stored under a server-generated key. Fields `entityType` (`ServiceRequest` \| `Incident` \| `Article`), `entityId`, `file`. `422` with `FILE_REJECTED` for a spoofed type or an executable/script/HTML payload — and the attempt is retained as `QUARANTINED` and audited; `413` past 10 MB; `409` past 20 per record; `404` when the parent is not visible |
| GET | `/attachments/{id}/content` | access inherits parent | Authorised **and audited on every request** (`19` §7.3): the parent's visibility is re-checked, the file is served as `application/octet-stream` with an `attachment` disposition unless it is an image, with `nosniff` and `private, no-store`. A signed short-lived URL is returned instead when the storage driver is object storage (`ADR-0004`) |
| GET | `/health`, `/health/ready`, `/health/live` | unauthenticated, minimal detail | |
| GET | `/health/metrics` | unauthenticated, internal only | Prometheus text exposition (`34` §4): RED metrics labelled by **route pattern** (never an id), SLA-sweep success/failure timestamps and process gauges. Answered from memory, so scraping adds no database load |
| GET | `/openapi.json` | spec, non-production exposure |

## 10. OpenAPI and Client Contract

- The OpenAPI document is **generated from the route/schema definitions**, not written
  by hand — a hand-maintained spec drifts within one sprint.
- CI fails if the generated spec differs from the committed one, so a contract change
  is always a reviewable diff.
- The frontend consumes the spec for request/response **types**, so a backend field
  rename surfaces as a compile error rather than a runtime `undefined`.
- `GET /openapi.json` is available in local/staging; in production it is disabled or
  requires authentication.

**Known gap (`A-11`):** frontend and backend are separate packages with no shared
workspace. Until a shared types package or spec-driven generation is wired up, Zod
schemas and TS types are duplicated and will drift. This requires an ADR before the
API stabilises.

## 11. Versioning and Deprecation

| Change | Classification |
|---|---|
| Additive field, new endpoint, new enum value | Non-breaking |
| New required field, removed field, renamed field, changed type, narrowed enum | Breaking |
| Changed default sort or pagination semantics | Breaking in practice |

Breaking changes require a new path version. Deprecations are announced by a
`Deprecation` header plus a sunset date, supported for at least one release cycle, and
logged when the deprecated path is used so real usage is measurable rather than guessed.

## 12. Related

- `12-VALIDATION-RULES.md` — what makes a payload valid
- `07-ROLES-AND-AUTHORIZATION.md` — permission semantics behind each endpoint
- `09-DATA-INTEGRITY-AND-INDEXING.md` — pagination mechanics
- `13-BACKEND-ARCHITECTURE.md` — how endpoints are implemented
- `14-FRONTEND-ARCHITECTURE.md` — the API client
