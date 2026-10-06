# 02 — Requirements

**Status:** Approved · **Owner:** Product Lead · **Reviewers:** Tech Lead, QA Lead · **Approved:** 2026-10-01
**Note:** Parts A and B, the qualitative statements of Part C, and the **quantified**
NFR targets in Part C are all approved. The targets were closed by `ADR-0007` (**D-7**),
2026-10-01.

This document consolidates what the original plan spread across requirements
process, functional requirements, non-functional requirements, performance
requirements and test cases. Test *cases* live in `37-TESTING.md`; requirement
*traceability* lives here.

---

## Part A — How Requirements Are Written

### A.1 Identifiers

| Prefix | Type | Home |
|---|---|---|
| `FR-<MODULE>-<nnn>` | Functional requirement | Part B |
| `NFR-<AREA>-<nnn>` | Non-functional requirement | Part C |
| `SEC-<nnn>` | Security control | `17`, `19`, `31` |
| `UI-<nnn>` | UI/UX requirement | `16` |
| `BE-<nnn>` | Backend requirement | `13` |
| `FE-<nnn>` | Frontend requirement | `14` |

Modules: `AUTH`, `USER`, `CATALOG`, `REQ`, `INC`, `TASK`, `SLA`, `APPR`, `KB`,
`ASSET`, `NOTIF`, `SEARCH`, `REPORT`, `AUDIT`, `FILE`, `INTEG`.

### A.2 Rules

1. **Statement** — one sentence, active voice, testable.
2. **Acceptance** — observable and binary, verifiable without reading code.
3. **Priority** — MoSCoW (Must / Should / Could / Won't).
4. **Traceability** — source, dependent features, covering test.

A statement without binary acceptance criteria is a goal, not a requirement, and
belongs in `01-PROJECT-FOUNDATION.md`.

**Bad:** *Requests should be easy to create.*
**Good:** *A requester can create a request from an active catalog item supplying all
fields marked required on that item. Acceptance: a missing required field returns
`422` with per-field errors and creates no record; a complete submission creates
exactly one request in state `NEW` with a generated reference, the catalog item's
default SLA policy, and one audit record.*

### A.3 Priority

| Priority | Meaning |
|---|---|
| Must | v1 is not shippable without it |
| Should | Significant value; deferral needs an explicit decision |
| Could | Scheduled only if capacity allows |
| Won't | Excluded from v1, recorded so it is not re-litigated |

### A.4 Traceability Chain

```
FR → feature doc (21–28) → API endpoint (11) → DB object (08) → UI surface (16)
   → test case (37) → acceptance (41)
```

Every `Must` requirement needs at least one covering test in `37-TESTING.md`. A
`Must` with no covering test is an open defect against the phase.

### A.5 Source Confidence

Domain practice and the charter are authoritative. Interviews are Medium. Benchmarks
are Low and treated as hypotheses. Assumptions must be marked inline:

```
> **ASSUMPTION A-07:** Approvers are always internal employees.
> If false, FR-APPR-004 becomes Must.
```

### A.6 Change Control

A `Must` requirement that changes after its phase is approved becomes a Change
Request in `42-ADRS-AND-CHANGE-REQUESTS.md`, recording impact on schema, API, UI and
tests, plus the approval decision. Requirements never change silently.

### A.7 Status

`Draft → Reviewed → Approved → Implemented → Verified → Accepted`, or
`Deferred`/`Rejected` with a recorded reason. Only Approved may be implemented;
only Verified may be Accepted.

---

## Part B — Functional Requirements

### B.1 Authentication & Identity

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-AUTH-001 | Registered active user authenticates with email + password | Valid → session; invalid → `401` generic (no enumeration); inactive refused | Must |
| FR-AUTH-002 | User can log out | Session invalidated **server-side**, not only cleared client-side | Must |
| FR-AUTH-003 | Sessions expire on idle and absolute timeout | Expired request → `401`; UI redirects to login preserving destination | Must |
| FR-AUTH-004 | Passwords hashed with Argon2id to policy | No plaintext in DB, logs or responses | Must |
| FR-AUTH-005 | Password reset by email | Token single-use, time-limited, invalidated on use or password change | Must |
| FR-AUTH-006 | Lockout after repeated failures | Independent of IP rate limiting | Should |
| FR-AUTH-007 | TOTP MFA for administrators | Enrol, verify, recover | Could (v1.1) |

### B.2 Users, Teams, Roles

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-USER-001 | Admin creates/edits/deactivates users | Deactivation blocks login **and revokes live sessions**; history stays attributed | Must |
| FR-USER-002 | Users hold roles; permissions are the union | Effective permission set is derivable and testable | Must |
| FR-USER-003 | Users belong to teams; teams can own work | Team assignment routes to team queue | Must |
| FR-USER-004 | Self-service profile edit | User cannot edit own roles | Should |
| FR-USER-005 | Time-bounded approval delegation | Delegated decision is attributed to both parties | Could |

### B.3 Service Catalog

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-CATALOG-001 | Admin defines items in categories with fields, default priority, SLA policy, fulfilment team | Item is requestable once active | Must |
| FR-CATALOG-002 | Requesters browse/search active items | Only active items appear | Must |
| FR-CATALOG-003 | Items are draft/active/retired | Retired cannot be requested; existing requests intact | Must |
| FR-CATALOG-004 | Dynamic form fields per item (text, number, date, select, multi-select, boolean, file) | Required rules enforced server-side | Must |
| FR-CATALOG-005 | Edits do not alter in-flight requests | In-flight request retains its original field set | Should |

Detail: `21-SERVICE-CATALOG.md`.

### B.4 Service Requests

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-REQ-001 | Create request from catalog item | See A.2 example | Must |
| FR-REQ-002 | Unique human-readable reference | e.g. `REQ-2026-000123`, unique under concurrency | Must |
| FR-REQ-003 | Enforced state machine | `NEW→TRIAGED→APPROVAL_PENDING→APPROVED/REJECTED→IN_PROGRESS→FULFILLED→CLOSED`, `CANCELLED` from non-terminal; illegal → `409` | Must |
| FR-REQ-004 | Assignment to user or team | Assignment change is audited | Must |
| FR-REQ-005 | Requester-visible updates | Requester sees public data, **never internal notes** | Must |
| FR-REQ-006 | Requester cancellation | Allowed until FULFILLED/CLOSED | Must |
| FR-REQ-007 | Filter/sort/paginate lists | By status, priority, category, assignee, requester, team, SLA state, dates | Must |
| FR-REQ-008 | Bulk assign/status update | Partial failure reported per item | Could |

Detail: `22-SERVICE-REQUESTS.md`.

### B.5 Incident Management

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-INC-001 | Any authenticated user reports an incident | Title, description, impact, urgency captured | Must |
| FR-INC-002 | Priority derived from impact × urgency | Manual override requires reason and is audited | Must |
| FR-INC-003 | Incident state machine | `NEW→IN_PROGRESS→RESOLVED→CLOSED`, `REOPENED` from RESOLVED/CLOSED | Must |
| FR-INC-004 | Major incident flag | Increases notification breadth and audit detail; no separate state machine in v1 | Should |
| FR-INC-005 | Resolution required to resolve | Closure requires resolution | Must |
| FR-INC-006 | Resolution can create KB draft | Draft is not auto-published | Should |

Detail: `23-INCIDENT-MANAGEMENT.md`.

### B.6 Task Management

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-TASK-001 | Tasks as children of requests/incidents | Title, assignee, due date, state | Must |
| FR-TASK-002 | Task state machine | `TODO→IN_PROGRESS→DONE`, `BLOCKED`, `CANCELLED` | Must |
| FR-TASK-003 | Parent cannot close with open children | Override requires recorded reason | Must |

Detail: `24-TASK-MANAGEMENT.md`.

### B.7 SLA Management

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-SLA-001 | Policies with target + warn thresholds per priority, bound to a calendar | Policy assignment is deterministic | Must |
| FR-SLA-002 | Timer start condition per policy | Start event is recorded, not inferred | Must |
| FR-SLA-003 | Pause/resume excludes paused time | Elapsed time excludes paused intervals exactly once | Must |
| FR-SLA-004 | Derived SLA state exposed | `ON_TRACK`/`AT_RISK`/`BREACHED`/`PAUSED`, never hand-edited | Must |
| FR-SLA-005 | Scheduled sweep records breaches | Breach timestamp recorded at detection | Must |
| FR-SLA-006 | Calendar defines working days/hours/holidays in a named time zone | All arithmetic is time-zone aware | Must |
| FR-SLA-007 | Attainment reportable per policy/team/priority/period | Reproducible from stored timestamps | Must |

Detail: `25-SLA-MANAGEMENT.md`. **D-8 open.**

### B.8 Approval Management

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-APPR-001 | Ordered steps; each with approvers and mode `ANY`/`ALL` | Workflow advances only on satisfaction | Must |
| FR-APPR-002 | Decisions record actor, decision, time, comment | Decisions immutable once recorded | Must |
| FR-APPR-003 | Rejection terminates workflow | Returns to requester with reason | Must |
| FR-APPR-004 | Optional step deadline | Expiry recorded and policy-configurable | Should |
| FR-APPR-005 | Pending approval visible only to entitled users | Non-approvers receive `403` | Must |

Detail: `26-APPROVAL-MANAGEMENT.md`.

### B.9 Knowledge Base

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-KB-001 | Authoring in a category tree | Archive rather than delete | Must |
| FR-KB-002 | Review workflow | `DRAFT→IN_REVIEW→PUBLISHED→ARCHIVED` | Should |
| FR-KB-003 | Only published articles visible in search | Drafts excluded for all non-authors | Must |
| FR-KB-004 | Keyword search over title, body, tags | Returns ranked results | Must |
| FR-KB-005 | Reader feedback helpful/unhelpful | One vote per user per article | Could |
| FR-KB-006 | Link articles to/from work items | Bidirectional link visible from both | Should |

Detail: `27-KNOWLEDGE-BASE.md`.

### B.10 Asset Management

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-ASSET-001 | Asset register | Type, tag, serial, status, location, custodian, purchase/warranty | Must |
| FR-ASSET-002 | Assignment to user or location | History retained, not overwritten | Must |
| FR-ASSET-003 | Lifecycle | `IN_STOCK→ASSIGNED→IN_REPAIR→RETIRED→DISPOSED` | Must |
| FR-ASSET-004 | Work items reference assets | Asset shows related work history | Must |
| FR-ASSET-005 | CMDB relationships | — | Won't (ADR-0011) |

Detail: `28-ASSET-MANAGEMENT.md`.

### B.11 Notifications

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-NOTIF-001 | Configured events produce notifications | Assignment, approval request/decision, status change, SLA at-risk/breach, comment | Must |
| FR-NOTIF-002 | In-app mandatory; email for approval, assignment, SLA breach; SMS optional | Mandatory events cannot be disabled | Must |
| FR-NOTIF-003 | Delivery is asynchronous | Originating API latency is unaffected by delivery | Must |
| FR-NOTIF-004 | User preference for optional categories | Security events non-optional | Should |
| FR-NOTIF-005 | Delivery record per notification | Target, channel, status, attempts, failure reason | Must |

Detail: `29-NOTIFICATIONS-AND-MESSAGING.md`. **D-6 open.**

### B.12 Search, Reporting, Audit, Files

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-SEARCH-001 | Unified search across requests, incidents, KB, assets | Results scoped to caller permissions | Must |
| FR-REPORT-001 | Dashboards: open work, SLA attainment, workload, trends | Filterable and exportable | Must |
| FR-AUDIT-001 | Every mutation writes append-only audit | Actor, action, target, before/after, time, correlation id | Must |
| FR-FILE-001 | Attachments on requests, incidents, KB | Type/size restricted; retrieval access-controlled | Must |

Detail: `30-SEARCH-AND-REPORTING.md`, `31-AUDIT-LOGGING.md`,
`19-DATA-PROTECTION-AND-FILES.md`.

### B.13 Integration

| ID | Requirement | Acceptance summary | Pri |
|---|---|---|---|
| FR-INTEG-001 | Outbound webhooks for configured events | Signed payloads, retry with backoff, delivery log | Should |
| FR-INTEG-002 | Inbound API to create requests | Authenticated by API key or service account | Could |
| FR-INTEG-003 | SSO/SAML for enterprise | Maps to existing users; no auto-provisioning in v1 | Could |

Detail: `32-INTEGRATIONS.md`.

### B.14 Out of Scope for v1 (`Won't`)

Change management / CAB; problem management / known errors; CMDB relationship graph;
billing and chargeback; multi-language UI. Removing an entry requires a Change
Request (ADR-0011).

---

## Part C — Non-Functional Requirements

### C.1 Approved Targets (`ADR-0007`, **D-7** — closed 2026-10-01)

| ID | Area | Target |
|---|---|---|
| NFR-PERF-001 | API read latency | p95 ≤ 300 ms server-side |
| NFR-PERF-002 | API write latency | p95 ≤ 500 ms |
| NFR-PERF-003 | List endpoint (50 items) | p95 ≤ 400 ms |
| NFR-PERF-004 | Search | p95 ≤ 800 ms |
| NFR-PERF-005 | Dashboard load | p95 ≤ 1.5 s end-to-end |
| NFR-PERF-006 | Report generation | Async above 5 s; returns a job handle |
| NFR-PERF-007 | First contentful paint | p75 ≤ 2.0 s, mid-tier device |
| NFR-SCALE-001 | Concurrency | 500 concurrent users; 10 000 registered |
| NFR-SCALE-002 | Write throughput | 50 writes/s sustained |
| NFR-SCALE-003 | Read throughput | 500 reads/s sustained |
| NFR-SCALE-004 | Data volume horizon | 5 M tickets, 500 K assets, 20 M audit rows |
| NFR-SCALE-005 | Job throughput | 1 000 jobs/min with ≤ 10 workers |
| NFR-AVAIL-001 | Availability | 99.9 % monthly, business hours |
| NFR-AVAIL-002 | Maintenance window | ≤ 4 h/month, announced ≥ 72 h |
| NFR-RECOV-001 | RPO | ≤ 5 minutes |
| NFR-RECOV-002 | RTO | ≤ 2 hours |
| NFR-SEC-001 | Transit encryption | TLS 1.2+ |
| NFR-SEC-002 | Password hashing | Argon2id, ≥ 64 MiB memory, ≥ 3 iterations |
| NFR-SEC-003 | Session idle timeout | ≤ 30 minutes, configurable |
| NFR-SEC-004 | Vulnerability remediation | Critical ≤ 7 days, High ≤ 30 days |
| NFR-DATA-001 | Audit retention | ≥ 24 months, append-only |
| NFR-DATA-002 | Backup retention | Daily 35 d, weekly 6 mo, monthly 24 mo |
| NFR-OBS-001 | Log retention | ≥ 90 days searchable |
| NFR-OBS-002 | Alert latency | ≤ 5 minutes |
| NFR-UX-001 | Accessibility | WCAG 2.1 AA on primary flows |
| NFR-UX-002 | Browser support | Last 2 versions of Chrome, Firefox, Safari, Edge |
| NFR-MAINT-001 | Service-layer coverage | ≥ 80 % lines |
| NFR-MAINT-002 | Lint/typecheck | Zero errors; warnings fatal in CI |
| NFR-PORT-001 | Deployment | Container-based, no manual server config |
| NFR-PORT-002 | Zero-downtime deploy | Required for minor releases |

### C.2 Interpretation Rules

- **p95** measured server-side, rolling 7 days, excluding maintenance. Long report
  jobs are measured as job metrics, not API latency.
- **NFR-SCALE-004** is the figure that forces early design work: audit querying and
  retention are designed for 20 M rows from day one (`33`, `31`).
- **NFR-AVAIL-001** applies to business hours in the primary operating time zone;
  24×7 would change the deployment and DR posture and is not assumed.
- **NFR-PERF-006** is a decision rule, not a suggestion: work that cannot meet its
  latency budget synchronously is queued (`04-WORKFLOWS-AND-FLOWS.md`).

### C.3 Verification Method

| Area | Verified by | Where |
|---|---|---|
| Latency, throughput | Load test on production-like data | `37-TESTING.md` |
| Scalability | Horizontal backend scale test | `33-SCALABILITY-AND-DATABASE-PROTECTION.md` |
| Availability, RPO/RTO | Documented procedure + restore drill | `36-OPERATIONS-AND-RECOVERY.md` |
| Security | SAST, DAST, dependency scan, manual review | `20-SECURITY-TESTING.md` |
| Accessibility | Automated axe + manual keyboard pass | `16-UI-UX-AND-ACCESSIBILITY.md` |
| Coverage | CI-enforced threshold | `37-TESTING.md` |

An NFR with no verification method is an aspiration, not a requirement.

### C.4 Constraints (Fixed)

| ID | Constraint |
|---|---|
| NFR-CONST-001 | PostgreSQL is the system of record; no second OLTP store in v1 |
| NFR-CONST-002 | Prisma is the only ORM; raw SQL must be justified and reviewed |
| NFR-CONST-003 | JSON over HTTPS, REST only |
| NFR-CONST-004 | `frontend/src` and `backend/src` structures are fixed |
| NFR-CONST-005 | Every input validated with Zod at the boundary |
| NFR-CONST-006 | Structured logs (Pino JSON) |

### C.5 Anti-Requirements

ServiceHub must **not**:

- open a database connection per request outside the pool;
- serve uploads from a single instance's local disk;
- run a scheduled job independently on every backend instance;
- execute unbounded queries or return unbounded lists;
- perform synchronously work that can be queued;
- cache sensitive or per-user-authorised data in a shared cache;
- trust client-supplied identifiers for authorization decisions.

Each maps to a control in `19`, `33` or `34`.

---

## Part D — Requirement Status Register

| Requirement group | Status | Blocked by |
|---|---|---|
| B.1 Authentication | Draft | — (`D-1` closed by `ADR-0001`) |
| B.2–B.6 Core work management | Draft | — |
| B.7 SLA | Draft | D-8 |
| B.8–B.10 Approvals, KB, Assets | Draft | — |
| B.11 Notifications | Draft | D-6 |
| B.12–B.13 Search, reporting, audit, files, integrations | Draft | — (`D-2`/`D-4` closed by `ADR-0002`/`ADR-0004`) |
| C Non-functional | Draft | — (`D-7` closed by `ADR-0007`) |

No requirement may be marked `Approved` while its blocking decision is open.
