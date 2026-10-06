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
| GET | `/teams` | `catalog:read` — tenant's active teams (read-only; membership management later) |
| GET/POST | `/teams`, `/teams/{id}` | `admin:config` / team-scoped read |
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
| GET | `/requests/{id}/history` | audit projection | Not yet implemented |

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

### SLA (`25`), KB (`27`), Assets (`28`)
Same pattern per resource. Notable action endpoints:

| Method | Path | Permission |
|---|---|---|
| GET | `/sla/clocks/{id}` | scoped |
| POST | `/sla/clocks/{id}/override` | `sla:clock:override` + reason |
| POST | `/kb/articles/{id}/publish` | `kb:article:publish` |
| POST | `/assets/{id}/assign` | `asset:assign` |

### Platform (`29`–`32`)
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | The caller's in-app notifications; cursor-paginated; the page carries `unreadCount` |
| POST | `/notifications/{id}/read`, `/notifications/read-all` | Self only; idempotent. A notification the caller does not own is a `404` |
| GET/PUT | `/me/notification-preferences` | Self only; per event and channel. A TRANSACTIONAL event (`29` N6) cannot be disabled — the request is refused with `422`, not silently ignored |
| GET | `/search` | Unified search across readable sources; **no single permission** — each source is scoped to the caller (`30` §2.3 S1). Params `q`, `types`, `limit`, `cursor`; response states the sources searched and any `EXACT_ONLY` fallback |
| GET | `/reports/{metric}` | `report:read`; a cross-team metric (`sla.attainment`) needs `report:read.all` (`30` §4). Metrics: `requests.summary`, `incidents.summary`, `tasks.summary`, `sla.attainment`. Response carries period, time zone and scope (`30` §3.2 R2) |
| POST | `/reports/{metric}/export` | `report:export`; queues an async job (`30` §3.1/§3.4), returns `202` with `{ export }` — never blocks on the aggregate. Body `{ from?, to? }`; audited with its filters (`30` R5) |
| GET | `/reports/jobs/{id}` | `report:export`; the caller's own export job and, once `SUCCEEDED`, its time-limited `downloadUrl` (`30` §5). Another user's job is a `404` |
| GET | `/reports/jobs/{id}/download` | `report:export`; the CSV, `text/csv` with a `Content-Disposition` filename. Refused with `404` unless the caller requested it and the link has not expired (`30` §5) |
| GET | `/audit` | `audit:read`; cursor paginated |
| POST/GET | `/attachments` | access inherits parent |
| GET | `/health`, `/health/ready`, `/health/live` | unauthenticated, minimal detail |
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
