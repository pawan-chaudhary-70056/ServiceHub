# 01 — Project Foundation

**Status:** Approved · **Phase:** 0 · **Owner:** Product Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01 · **Audience:** All stakeholders, developers, AI agents

## 1. What ServiceHub Is

ServiceHub is an **Enterprise Service Management (ESM) platform**: employees and
customers raise requests against a governed service catalog, and the platform
routes, approves, fulfils, and measures that work under Service Level Agreements,
with a full audit trail.

It is *not* a generic ticketing tool. The defining property of ServiceHub is that
**every unit of work belongs to the catalog, is governed by an SLA, is moved by an
explicit state machine, and leaves an immutable audit record.**

## 2. Problem Statement

Organisations run service delivery across disconnected inboxes, spreadsheets and
chat threads. This produces four failures ServiceHub must eliminate:

1. **No intake control** — work arrives through arbitrary channels with no catalog,
   so it cannot be categorised, priced, approved, or measured.
2. **No accountability** — no owner, no state, no SLA clock, so nothing is late
   until someone complains.
3. **No governance** — approvals are informal and unauditable.
4. **No learning** — no knowledge base, no asset context, no reporting, so the same
   incident recurs.

## 3. Primary Actors

| Actor | Description |
|---|---|
| Requester | Raises requests and incidents; tracks status; does not see internal notes |
| Agent | Works assigned requests/incidents/tasks |
| Team Lead / Manager | Assigns work, owns SLA compliance, sees team queues |
| Approver | Approves or rejects approval steps; no fulfilment duties |
| Knowledge Contributor | Authors and reviews KB articles |
| Asset Manager | Owns assets and their lifecycle |
| Administrator | Configuration: catalog, SLA policies, roles, integrations |
| Auditor | Read-only access to audit records; no mutation rights |
| System | Scheduled jobs, queue workers, SLA timers, integrations |

Full role/permission matrix: `07-ROLES-AND-AUTHORIZATION.md`.

## 4. Scope

### In scope (v1)
- Service catalog and categories
- Service requests with approval workflows
- Incident management
- Task management
- SLA policies, calendars, timers and breach tracking
- Approval management
- Knowledge base
- Asset management (register + assignment, not full CMDB)
- Notifications (in-app + email)
- Search, filtering, sorting
- Reporting and dashboards
- Audit logging
- Users, teams, roles and permissions

### Explicitly out of scope (v1)
- Change Management (CAB, change calendar)
- Problem Management (known errors, root-cause workflow)
- Full CMDB with relationship graph and impact analysis
- Billing, chargeback, cost centres
- Multi-language UI (i18n) — see §7 Open Decisions
- Mobile native apps (responsive web only)

The two out-of-scope ITSM processes are deliberate: see
`42-ADRS-AND-CHANGE-REQUESTS.md` ADR-0011.

## 5. Architecture in One Paragraph

A React + TypeScript single-page application talks over REST to a Node.js +
Express + TypeScript backend. The backend validates every input with Zod,
authenticates the caller, authorises the action at both role and object level,
executes business logic in a service layer, and persists through Prisma to
PostgreSQL. Expensive or non-immediate work (email, notifications, reports,
SLA sweeps) is queued and executed by background workers. Frequently read, slowly
changing data (catalog, categories, reference data) is cached. PostgreSQL is
protected by connection pooling, indexing, pagination, query timeouts, and
rate limiting, and can be read-scaled with replicas when measurements justify it.
Everything mutating writes an audit record.

Detail: `03-ARCHITECTURE.md` and `33-SCALABILITY-AND-DATABASE-PROTECTION.md`.

## 6. Engineering Principles

1. **Document → approve → implement.** No feature is coded before its contract is
   written. See `02-REQUIREMENTS.md` and `40-IMPLEMENTATION-PLAN-AND-PHASES.md`.
2. **The API contract is the boundary.** Frontend and backend agree through
   `11-API-CONTRACT.md`, not through shared assumptions.
3. **Authorise at the object, not just the role.** Role checks are necessary and
   insufficient. Every read/write re-checks ownership and scope.
4. **Never trust the client.** All validation is server-side; client validation is
   UX only.
5. **No unbounded anything.** Every list endpoint is paginated; every query is
   indexed; every external call has a timeout.
6. **Audit is a first-class output, not a log line.** See `31-AUDIT-LOGGING.md`.
7. **Measure before scaling.** Scale the layer that is measured to be the
   bottleneck. See `33-SCALABILITY-AND-DATABASE-PROTECTION.md`.

## 7. Decisions and Their Status

`D-1`–`D-5` are **closed** by `ADR-0001`–`ADR-0005` (`42` §3); `D-6`–`D-8` remain open
and must be settled by ADR before the phases that depend on them. Recorded here so no
document silently assumes an answer.

| ID | Decision | Status | Resolution / default |
|---|---|---|---|
| D-1 | Session cookies vs stateless tokens | **Closed** (`ADR-0001`) | Server-side sessions, httpOnly cookie, CSRF token |
| D-2 | Single-tenant vs multi-tenant | **Closed** (`ADR-0002`) | **Multi-tenant, shared schema**; tenant mandatory in every query/index |
| D-3 | Cache provider and queue broker | **Closed** (`ADR-0003`) | Redis for cache **and** broker; PgBouncer pooler |
| D-4 | File storage backend | **Closed** (`ADR-0004`) | S3-compatible object storage |
| D-5 | Orchestrator for production | **Closed** (`ADR-0005`) | Kubernetes |
| D-6 | Email/SMS provider | **Closed** (`ADR-0006`) | Knock orchestration; SendGrid (email) + Twilio (SMS) |
| D-7 | Quantified NFR targets | **Closed** (`ADR-0007`) | `02` C.1 targets: 99.9% availability, p95 ≤ 300 ms read, RPO ≤ 5 min, RTO ≤ 2 h |
| D-8 | SLA calendar semantics | **Closed** (`ADR-0008`) | Per-policy calendar; default business hours with pause states |

## 8. Definition of Success

ServiceHub v1 succeeds when:

- A requester can raise a catalog item in under 60 seconds and always sees who owns it.
- Every request has an SLA state (on track / at risk / breached) derived from a policy, not hand-set.
- Every approval is either recorded with an actor and timestamp, or absent — never assumed.
- No user can read or mutate an object they are not entitled to, verified by test.
- Every mutation is reconstructable from the audit trail.
- The system sustains its NFR targets under load test with PostgreSQL as the last
  layer to be scaled.

## 9. Related Documents

- `02-REQUIREMENTS.md` — requirement set, traceability, NFR targets
- `05-FEATURE-MAP-AND-DEPENDENCIES.md` — the feature set and its ordering
- `40-IMPLEMENTATION-PLAN-AND-PHASES.md` — how this becomes working software
- `41-DEFINITION-OF-DONE.md` — completion criteria
- `42-ADRS-AND-CHANGE-REQUESTS.md` — decision log
