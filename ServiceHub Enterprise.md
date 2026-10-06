# ServiceHub — Enterprise Service Management Platform

**Document:** Master Charter and Architecture
**Version:** 2.0
**Status:** Approved for execution (charter) — implementation requires the phase gates in §28
**Owner:** Tech Lead · **Reviewers:** Product Lead, Security Lead, DevOps
**Companion set:** `docs/00-DOCUMENTATION-PLAN.md` … `docs/43-CHANGELOG.md` (44 documents)
**Supersedes:** version 1.0 of this charter (the 106-document Documentation Architecture in §4)

> **How to read this document.** This is the **master charter**: it defines the project,
> the repository, the documentation set, the production architecture, the technology
> baseline and the governance model. It is deliberately an *index and a set of
> boundaries* — it does not restate the detailed contracts. Each detail has exactly one
> home in the 44 documents of §4, and this document links to them rather than
> duplicating them (rule R1, §4.3).

---

# 1. Project Definition

**Project Name:** ServiceHub
**Project Type:** Enterprise Service Management Platform
**Architecture:** Full-Stack Web Application
**Frontend:** React + TypeScript + Vite + Tailwind CSS
**Backend:** Node.js + Express.js + TypeScript
**Database:** PostgreSQL
**ORM:** Prisma
**API Style:** REST API
**Authentication:** Secure authentication with Argon2id password hashing — *server-side
sessions in a shared store, `httpOnly` cookie with a CSRF token, closed by **D-1** →
`ADR-0001`, see §27*
**Validation:** Zod
**Logging:** Pino
**API Documentation:** OpenAPI / Swagger
**Testing:** Vitest, React Testing Library, Supertest, Playwright (E2E), k6 (performance)
**Deployment:** Docker + Docker Compose + CI/CD

## 1.1 What ServiceHub Does (Core Domain Scope)

ServiceHub is an enterprise service management platform for **organisations that deliver
internal services to their people** — IT, facilities, HR, finance. It is not a generic
ticketing tool: it is an intake-and-delivery system with measurable obligations (SLA),
governance (approvals), and accountability (audit).

It covers eight functional areas. Full contracts are in the documents named.

| # | Area | What it is | Document |
|---|---|---|---|
| 1 | **Service Catalog** | The intake contract: what can be requested, with typed forms, defaults and routing | `21` |
| 2 | **Service Requests** | Requestable work raised from the catalog, with a lifecycle and SLA | `22` |
| 3 | **Incident Management** | Unplanned service interruptions, prioritised by impact × urgency | `23` |
| 4 | **Task Management** | Child units of work within requests and incidents | `24` |
| 5 | **SLA Management** | Targets, business calendars, clocks, breaches and attainment | `25` |
| 6 | **Approval Management** | Auditable, ordered approval workflows attached to gated work | `26` |
| 7 | **Knowledge Base** | Published content that deflects work before it is raised | `27` |
| 8 | **Asset Management** | The register of what is held, by whom, with assignment history | `28` |

Supporting capabilities: notifications and messaging (`29`), search and reporting
(`30`), audit logging (`31`), integrations (`32`), scalability and database protection
(`33`), observability (`34`), deployment (`35`), operations and recovery (`36`),
testing (`37`).

## 1.2 Who Uses It

| Actor | Primary need |
|---|---|
| Requester | Raise a request, see status and expected turnaround |
| Agent | Work assigned records, resolve within SLA |
| Team Lead | Assign, escalate, override clocks, report |
| Approver | Approve or reject gated work with full context |
| Administrator | Configure catalog, SLA, calendars, identity, integrations |
| Auditor / Security | Reconstruct who did what, when, and under what authority |
| Executive / Stakeholder | SLA attainment, volumes, trends |

Role and permission definitions are `07`; identity and authentication are `06`.

---

# 2. Core Development Principle

```text
DOCUMENT
   ↓
ANALYZE
   ↓
DEFINE REQUIREMENTS
   ↓
DEFINE FLOWS
   ↓
DEFINE ARCHITECTURE
   ↓
DEFINE DATABASE
   ↓
DEFINE API CONTRACTS
   ↓
DEFINE UI/UX
   ↓
REVIEW
   ↓
APPROVE
   ↓
IMPLEMENT
   ↓
TEST
   ↓
SECURITY REVIEW
   ↓
CODE REVIEW
   ↓
UPDATE DOCUMENTATION
   ↓
ACCEPTANCE VALIDATION
   ↓
NEXT PHASE
```

**Reconciliation (v2.0).** This waterfall gate and the iterative AI-agent workflow in
`39` are not incompatible if *phases* are gated and *work inside a phase* iterates. That
reconciliation is formalised in `40` §1 and §28 of this document. "Approve" is
**mechanical** — a named document set reaching `Approved`, its blocking decisions
closed, and its exit criteria demonstrated — not a meeting.

---

# 3. Repository Structure

The application must use the following structure.

```text
servicehub/
│
├── frontend/
│   ├── node_modules/
│   ├── src/
│   │   ├── @types/
│   │   ├── api/
│   │   ├── assets/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── routes/
│   │   ├── templates/
│   │   ├── themes/
│   │   ├── utils/
│   │   ├── validators/
│   │   ├── app.tsx
│   │   └── main.tsx
│   ├── tests/                  ← E2E specs (Playwright); see §3.1
│   ├── .env
│   ├── .env.example
│   ├── .gitignore
│   ├── index.html
│   ├── package.json
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── README.md
│
├── backend/
│   ├── node_modules/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── src/
│   │   ├── @types/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── helpers/
│   │   ├── middlewares/
│   │   ├── models/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── validators/
│   │   ├── integrations/
│   │   ├── jobs/
│   │   ├── utils/
│   │   ├── server.ts
│   │   └── app.ts
│   ├── tests/
│   ├── .env
│   ├── .env.example
│   ├── .gitignore
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
│
├── docs/
├── .github/
│   └── workflows/
├── .gitignore
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── LICENSE
└── docker-compose.yml
```

**Structure rule:** the provided `frontend/src/` and `backend/src/` structures **must
not be changed**. Modules map onto them per `13`/`14`.

`backend/prisma/` is required because PostgreSQL + Prisma requires the Prisma schema and
migration history.

## 3.1 Two Structure Resolutions (v2.0)

The original structure was ambiguous in two places. Both are resolved here **without
changing any mandated `src/` path**:

1. **Frontend tests.** `frontend/src/` has no test directory, yet Vitest and React
   Testing Library are mandated. Resolution: **unit/component tests are co-located**
   next to the code they test (`*.test.tsx`), and **E2E specs live in `frontend/tests/`**.
   Authoritative rule: `38` §3.
2. **Frontend environment example.** `frontend/.env` was listed but not
   `frontend/.env.example`; the latter is required so the configuration surface is
   documented without committing values (`35` §2).

**Also note:** anything in a `VITE_` variable is compiled into the client and is
**public**. No secret may appear in a frontend environment variable (`35` §2, `38` §8).

---

# 4. Documentation Architecture

## 4.1 The Set (44 documents)

`docs/` holds **44 documents**, reorganised from the original 106 by **ownership
boundary and lifecycle** so that every fact has exactly one home. The plan, its rules
(R1–R7) and the complete `00`–`105` coverage map are in `docs/00-DOCUMENTATION-PLAN.md`.

```text
docs/
│
│  ── Governance ────────────────────────────────────────────────────────────
├── 00-DOCUMENTATION-PLAN.md          Tech Lead        rules, ownership, coverage map
├── 01-PROJECT-FOUNDATION.md          Product Lead     what ServiceHub is
├── 02-REQUIREMENTS.md                Product Lead     functional + non-functional
│
│  ── Architecture and contracts ────────────────────────────────────────────
├── 03-ARCHITECTURE.md                Tech Lead        system/app/production layers
├── 04-WORKFLOWS-AND-FLOWS.md         Tech Lead        end-to-end flows
├── 05-FEATURE-MAP-AND-DEPENDENCIES.md Product Lead    feature inventory + deps
├── 06-IDENTITY-AND-AUTHENTICATION.md Security Lead    login, sessions, MFA
├── 07-ROLES-AND-AUTHORIZATION.md     Security Lead    RBAC + object-level access
├── 08-DATA-MODEL.md                  Backend Lead     entities, fields, relations
├── 09-DATA-INTEGRITY-AND-INDEXING.md Backend Lead     constraints, indexes, FTS
├── 10-MIGRATIONS-AND-SEEDING.md      DBA              schema evolution, seeds
├── 11-API-CONTRACT.md                Backend Lead     endpoints, shapes, errors, OpenAPI
├── 12-VALIDATION-RULES.md            Backend Lead     Zod schemas, boundaries
├── 13-BACKEND-ARCHITECTURE.md        Backend Lead     layering, modules, jobs
├── 14-FRONTEND-ARCHITECTURE.md       Frontend Lead    routing, state, API client
├── 15-DESIGN-SYSTEM.md               Design Lead      tokens, components
├── 16-UI-UX-AND-ACCESSIBILITY.md     Design Lead      pages, forms, a11y
│
│  ── Security ──────────────────────────────────────────────────────────────
├── 17-SECURITY-ARCHITECTURE.md       Security Lead    posture, secrets, secure coding
├── 18-THREAT-MODEL.md                Security Lead    threats, trust boundaries
├── 19-DATA-PROTECTION-AND-FILES.md   Security Lead    classification, retention, files
├── 20-SECURITY-TESTING.md            Security Lead    the security test suite
│
│  ── Domain features ───────────────────────────────────────────────────────
├── 21-SERVICE-CATALOG.md             Product Lead
├── 22-SERVICE-REQUESTS.md            Product Lead
├── 23-INCIDENT-MANAGEMENT.md         Product Lead
├── 24-TASK-MANAGEMENT.md             Product Lead
├── 25-SLA-MANAGEMENT.md              Product Lead
├── 26-APPROVAL-MANAGEMENT.md         Product Lead
├── 27-KNOWLEDGE-BASE.md              Product Lead
├── 28-ASSET-MANAGEMENT.md            Product Lead
│
│  ── Platform capabilities ─────────────────────────────────────────────────
├── 29-NOTIFICATIONS-AND-MESSAGING.md Backend Lead     email/SMS/in-app + outbox
├── 30-SEARCH-AND-REPORTING.md        Backend Lead     read model, metrics
├── 31-AUDIT-LOGGING.md               Security Lead    append-only audit
├── 32-INTEGRATIONS.md                Backend Lead     adapters, webhooks
│
│  ── Runtime, delivery and operations ──────────────────────────────────────
├── 33-SCALABILITY-AND-DATABASE-PROTECTION.md Tech Lead  the protection strategy
├── 34-OBSERVABILITY.md               DevOps           logs, metrics, health, alerts
├── 35-DEPLOYMENT-AND-CI-CD.md        DevOps           env, containers, pipeline
├── 36-OPERATIONS-AND-RECOVERY.md     DevOps           backup, DR, runbooks
├── 37-TESTING.md                     QA Lead          strategy, levels, performance
│
│  ── Standards and process ─────────────────────────────────────────────────
├── 38-CODE-QUALITY-AND-GUIDELINES.md Tech Lead        conventions, review standard
├── 39-AI-AGENT-INSTRUCTIONS-AND-WORKFLOW.md Tech Lead  agent operating contract
├── 40-IMPLEMENTATION-PLAN-AND-PHASES.md Tech Lead       phases and gates
├── 41-DEFINITION-OF-DONE.md          Tech Lead
├── 42-ADRS-AND-CHANGE-REQUESTS.md    Tech Lead        decisions and changes
└── 43-CHANGELOG.md                   Tech Lead        append-only history
```

## 4.2 Why the Original 106 Were Consolidated

The original set defined every topic by **viewpoint** — for each subject a
`REQUIREMENTS` doc, an `ARCHITECTURE` doc, a `FLOW` doc, and often a `SECURITY` doc. The
same fact therefore lived in three to five files and could drift silently, with no
reader knowing which was authoritative. The 44-document set groups by **artifact and
lifecycle** instead. Highlights:

| Consolidation | From | To |
|---|---|---|
| Requirements + NFR + test cases | `01`, `02`, `03`, `73`, `75` | `02` |
| System + application + production architecture | `04`, `05`, `89` | `03` |
| All flow diagrams | `06`, `07`, `23`, `29`, `33` | `04` |
| Data model + relationships + flow | `12`, `13`, `14`, `17` | `08` |
| API spec + endpoints + shapes + errors + OpenAPI | `20`, `21`, `22`, `26`, `30` | `11` |
| Security requirements + architecture + flow + controls + secrets + secure coding | `43`–`46`, `53`, `97` | `17` |
| Database scalability + protection + production scalability | `18`, `19`, `90` | `33` |
| Logging + observability + health checks | `70`, `71`, `72` | `34` |
| Deployment + env + Docker + CI/CD | `83`–`86` | `35` |
| Backup + disaster recovery | `87`, `88` | `36` |
| All testing levels + performance testing | `74`, `76`–`79`, `81` | `37` |
| Duplicate security testing | `52`, `80` | `20` (they duplicated each other) |

**Nothing was dropped.** Every original document number `00`–`105` maps to exactly one
new home, except six view-split documents that map to two homes each, with a stated
split rule — see `00` §4 and §5. The six splits are: `73` (targets / optimisation /
load-test), `25` and `41` (server schema vs form UX), `24` (authentication vs
authorization), `39` (route table vs navigation UX), and `53` (secret policy vs secret
injection).

## 4.3 Rules That Make Overlap Structurally Impossible

Stated in full in `00` §2. The load-bearing ones:

- **R1** — One artifact, one home. Every fact is stated once; other mentions are marked
  pointers `(see NN §x)`.
- **R2** — Ownership is by artifact. A document has one accountable owner.
- **R5** — Only `Approved` documents may be implemented against.
- **R7** — No document may exist solely to restate another.

## 4.4 Document Status

| Status | May be implemented against? |
|---|---|
| Draft | No |
| In Review | No |
| Approved | Yes |
| Superseded | No |

**Current state:** the Phase 0 set (`00`, `01`, `02`, `40`, `41`, `42`, `43`), the
**entire Phase 1 design set** (`03`–`19`, `38`, `39`) and the **Phase 2 core documents**
(`20`, `21`, `22`–`26`, `29`–`31`, `33`–`37`) are **Approved** (2026-10-01), so **Gate 1
is passed** and the **Phase 2 entry gate is met**; all decisions `D-1`–`D-9` are closed
(`D-1`–`D-8` by `ADR-0001`–`ADR-0008`, and **`D-9` by `ADR-0012`**, accepted
2026-10-02) (§27). **Gate 2 is not passed** — its exit criteria are demonstrated
behaviour from a built system, which does not yet exist. The Phase 3 documents (`27`,
`28`, `32`) remain **Draft** until their owner signs off at their phase gate (§28).
Nothing may be implemented until the owning document is `Approved` at its phase gate
(§28).

---

# 5. Production Architecture

ServiceHub is designed so that the production environment can scale horizontally
**without making the database the first bottleneck**.

## 5.1 Production Request Flow

```text
                         INTERNET
                            │
                            ▼
                 ┌─────────────────────┐
                 │    Load Balancer    │  TLS · rate limiting · static assets
                 └──────────┬──────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ Backend 01 │  │ Backend 02 │  │ Backend N  │  stateless
     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
           └───────────────┼───────────────┘
                           │
                           ▼
                 ┌───────────────────┐
                 │   Cache / Queue   │  Redis-compatible cache + broker
                 │  ───────────────  │
                 │  Cache            │
                 │  Background Jobs  │
                 │  Async Processing │
                 └─────────┬─────────┘
                           │
                           ▼
                 ┌───────────────────┐
                 │ Connection Pool   │  Prisma + PgBouncer-compatible pooler
                 └─────────┬─────────┘
                           │
                           ▼
                 ┌───────────────────┐
                 │    PostgreSQL     │  primary (+ read replica when measured)
                 └───────────────────┘
```

## 5.2 Production Principle

```text
Load Balancer
      ↓
Multiple Backend Servers
      ↓
Cache / Queue
      ↓
Connection Pool
      ↓
PostgreSQL
```

This allows application servers to scale horizontally while controlling database
pressure. The named components are part of the baseline in §23 and are chosen by
**D-3** / **D-4**.

---

# 6. Production Scalability Flow

```text
Users
  ↓
Load Balancer
  ↓
┌───────────────────────────────────┐
│       Backend Application Layer   │
│                                   │
│ Backend 1                         │
│ Backend 2                         │
│ Backend 3                         │
│ Backend N                         │
└────────────────┬──────────────────┘
                 │
        ┌────────┴─────────┐
        ▼                  ▼
     Cache              Queue
        │                  │
        │                  ▼
        │             Background Jobs
        │                  │
        └────────┬─────────┘
                 ▼
         Connection Pool
                 │
                 ▼
             PostgreSQL
```

---

# 7. Database Protection Architecture

A high number of simultaneous users does **not** mean the database should receive an
independent connection per user. ServiceHub protects PostgreSQL with multiple layers.

```text
                     USER REQUESTS
                           │
                           ▼
                    Load Balancer
                           │
                           ▼
                 Multiple Backend Servers
                           │
                           ▼
                    Rate Limiting
                           │
                           ▼
                      Cache Layer
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
             Cache Hit           Cache Miss
                 │                   │
                 ▼                   ▼
              Response       Application Logic
                                     │
                                     ▼
                              Efficient Query
                                     │
                                     ▼
                               Connection Pool
                                     │
                                     ▼
                                  PostgreSQL
```

---

# 8. Main Database Protection Mechanisms

```text
 1. Connection Pooling
 2. Caching
 3. Rate Limiting
 4. Efficient Queries
 5. Proper Database Indexing
 6. Pagination
 7. Read Replicas Where Required
 8. Queueing / Asynchronous Processing
 9. Transactions Where Required
10. Query Timeouts / Resource Controls
11. Monitoring and Alerting
12. Archival of cold data
```

The objective is **not simply to prevent PostgreSQL from crashing**. The architecture
controls database pressure, reduces unnecessary database work, distributes application
traffic, processes expensive work asynchronously, and scales according to **measured**
bottlenecks. Full strategy: `33`.

---

# 9. Connection Pooling Flow

Without connection pooling:

```text
User 1 ──────→ Database Connection
User 2 ──────→ Database Connection
User 3 ──────→ Database Connection
User 4 ──────→ Database Connection
...
User N ──────→ Database Connection
```

This creates excessive database connection pressure.

With pooling:

```text
Requests
   │
   ▼
Backend Servers
   │
   ▼
Connection Pool
   │
   ├── Connection 1
   ├── Connection 2
   ├── Connection 3
   ├── Connection 4
   └── Connection N
   │
   ▼
PostgreSQL
```

Connections are reused rather than created without bound. Prisma configuration and the
deployment architecture must account for database connection limits, and the budget is
stated arithmetic: `instances × pool size + workers ≤ Postgres budget − reserve`
(`33` §4). Raising `max_connections` is **not** the response to exhaustion.

---

# 10. Caching Flow

Frequently requested or relatively stable data is eligible for caching.

```text
Request
  ↓
Cache Check
  ↓
┌───────────────┴───────────────┐
▼                               ▼
Cache Hit                    Cache Miss
▼                               ▼
Return Cached Data          PostgreSQL Query
                                │
                                ▼
                           Store in Cache
                                │
                                ▼
                              Return
```

Cache candidates:

- Service catalog data and categories
- Public configuration and reference data
- Non-sensitive dashboard aggregates
- Frequently repeated read operations

**Rules that are not optional** (`33` §5):

- **Never cache a permission-filtered view under a shared key** — key by viewer class, or
  cache unfiltered and filter after authorization.
- Every region has an explicit TTL and an invalidation path.
- The cache is **best-effort**: a cache outage degrades to the database, never fails the
  request.
- Sensitive or rapidly changing data is not cached indiscriminately.

---

# 11. Rate Limiting Flow

```text
Incoming Request
       ↓
Rate Limiter
       ↓
 ┌─────┴──────┐
 ▼            ▼
Allowed    Limit Exceeded
 ▼            ▼
Continue   429 Response
 │
 ▼
Backend
```

Distinct limits are required for:

```text
Authentication
Password Reset
Public APIs
Search
File Upload
Export / Reporting
Administrative APIs
General API Requests
```

Limits are per-identity where authenticated and per-IP where not; they **fail closed**
for authentication endpoints and **fail open with logging** for read-only traffic during
a limiter outage (`33` §6).

---

# 12. Efficient Query Flow

```text
Application Request
       ↓
Service Logic
       ↓
Query Construction
       ↓
Use Required Fields Only
       ↓
Use Appropriate Filters
       ↓
Use Pagination
       ↓
Use Indexed Columns
       ↓
Avoid Unnecessary Queries
       ↓
Execute Prisma Query
       ↓
PostgreSQL
```

The application must avoid:

- Unbounded queries
- Unnecessary full-table scans
- N+1 query patterns
- Fetching unnecessary columns
- Loading huge datasets into memory
- Missing pagination
- Unnecessary repeated queries
- External I/O inside a transaction

---

# 13. Database Indexing Flow

```text
Query
 ↓
PostgreSQL Query Planner
 ↓
Appropriate Index?
 │
 ├── YES → Index Scan → Result
 │
 └── NO  → Potentially Expensive Scan (or a sequential scan worth reviewing)
```

Indexes are designed around **actual access patterns**. Candidate fields:

```text
Primary Keys
Foreign Keys
Unique Fields
Status
Created At
Updated At
Organization / Scope IDs
Frequently Queried Search Fields
Common Filtering Fields
Full-text search vectors (tsvector · GIN)
```

Indexes are **not** added blindly: they cost storage and write maintenance. An index
exists because a query needs it, and unused indexes are dropped. Details: `09`; creation
on live tables: `10`; operational rules: `33` §8.

---

# 14. Read Replica Architecture

For sufficiently large production workloads, read replicas may be introduced.

```text
                    Application
                         │
                ┌────────┴────────┐
                ▼                 ▼
             WRITE              READ
                │                 │
                ▼                 ▼
     PostgreSQL Primary     Read Replica
                │                 ▲
                └──── Replication ┘
```

Write operations continue through the primary. Eligible read-heavy operations may be
directed to replicas. The application must account for replication lag and must never
assume a replica holds the latest write. **Read-after-write always uses the primary**
(`33` §9).

---

# 15. Queue-Based Processing

Long-running or non-immediate operations must not block normal API requests.

```text
User Request
     ↓
Backend
     ↓
Create Required Database State
     ↓
Create Job  (written to the outbox in the same transaction)
     ↓
Queue
     ↓
Immediate API Response

Queue Worker
     ↓
Process Job  (idempotent · retried · dead-lettered on failure)
     ↓
External Service / Email / Report / Heavy Task
     ↓
Update Result
     ↓
Audit
```

Queue-based operations:

- Email sending and SMS sending
- Large report generation
- Notification delivery
- Scheduled SLA processing
- Background cleanup and archival
- External integrations
- Large file processing

**The outbox is the reliability boundary** (`29` §3): the job row is written in the same
transaction as the domain mutation, so "the record changed but no one was told" is
impossible, and a provider outage never rolls back a business change.

---

# 16. Database Load Protection — Complete Flow

```text
                         USERS
                           │
                           ▼
                    LOAD BALANCER
                           │
                           ▼
                MULTIPLE BACKEND SERVERS
                           │
                           ▼
                    RATE LIMITING
                           │
                           ▼
                    REQUEST VALIDATION
                           │
                           ▼
                     CACHE CHECK
                      /         \
                    HIT         MISS
                    │             │
                    ▼             ▼
                RESPONSE     BUSINESS LOGIC
                                  │
                                  ▼
                            QUERY OPTIMIZATION
                                  │
                                  ▼
                             INDEXED QUERY
                                  │
                                  ▼
                           CONNECTION POOL
                                  │
                                  ▼
                             POSTGRESQL
                                  │
                       ┌──────────┴──────────┐
                       ▼                     ▼
                     WRITE                  READ
                       │                     │
                       ▼                     ▼
                  PRIMARY DB          READ REPLICA
                       │                     │
                       └──────────┬──────────┘
                                  ▼
                               RESPONSE
```

---

# 17. Complete Production Architecture

```text
                              INTERNET
                                  │
                                  ▼
                         ┌─────────────────┐
                         │  Load Balancer  │
                         └────────┬────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        ┌───────────┐       ┌───────────┐       ┌───────────┐
        │ Backend 1 │       │ Backend 2 │       │ Backend N │
        └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
              └───────────────────┼───────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
              ┌───────────┐               ┌───────────┐
              │   Cache   │               │   Queue   │
              └─────┬─────┘               └─────┬─────┘
                    │                           │
                    │                           ▼
                    │                    Background Workers
                    │                           │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ Connection Pool │
                         └────────┬────────┘
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                    PostgreSQL         Read Replica
                     Primary          (when required)
                         │                 ▲
                         └──── Replication ┘
```

**Statelessness rule:** a backend instance holds no state another instance needs — no
local sessions, no local uploads, no local caches, no local job locks. Object storage
(**D-4**) exists precisely for this; violating statelessness is the most common way
"scales horizontally" turns out to be false (`03` §7).

---

# 18. Production Failure Protection

```text
Request
  ↓
Load Balancer
  ↓
Backend Server
  ↓
Server Available?
  │
 ┌┴──────────────┐
 ▼               ▼
YES              NO
 │               │
 ▼               ▼
Continue   Route to Healthy Server
 │
 ▼
Database Available?
 │
 ┌┴──────────────┐
 ▼               ▼
YES              ▼
 │        Safe Error / Retry Policy
 ▼        / Queue / Failover
Continue
```

Production architecture must include:

- Health checks, readiness checks, liveness checks
- Graceful shutdown and connection draining
- Retry policies where safe
- Timeout policies
- Circuit-breaker patterns where appropriate
- Queue-based recovery where appropriate
- Database backup and disaster recovery
- Monitoring and alerting

**Two rules that are frequently violated:**

1. **Liveness must not check the database** (`34` §6). If it does, a brief database blip
   restarts every instance at once, converting a degradation into an outage.
2. **Retries must be bounded, backed off, jittered, and applied only to idempotent
   operations.** Blind retries multiply load exactly when the system is already
   struggling.

---

# 19. Scalability Principle

```text
                    MORE USERS
                        │
                        ▼
                Load Balancer
                        │
                        ▼
          Add More Backend Servers
                        │
                        ▼
                 Cache Frequently
                        │
                        ▼
              Queue Heavy Workloads
                        │
                        ▼
             Optimize Database Queries
                        │
                        ▼
               Improve Indexes
                        │
                        ▼
               Tune Connection Pool
                        │
                        ▼
                Add Read Replicas
                 When Necessary
```

The application should not immediately solve every performance problem by adding
database hardware. The preferred order:

```text
Measure
  ↓
Identify Bottleneck
  ↓
Optimize Application
  ↓
Optimize Queries
  ↓
Optimize Indexes
  ↓
Cache
  ↓
Queue
  ↓
Tune Connection Pool
  ↓
Scale Backend
  ↓
Read Replicas
  ↓
Database Scaling
```

---

# 20. Security + Production Architecture

Production scalability must not bypass security.

```text
Internet
   ↓
Load Balancer
   ↓
TLS / HTTPS
   ↓
Rate Limiting
   ↓
Backend Servers
   ↓
Authentication
   ↓
Authorization
   ↓
Validation
   ↓
Business Logic
   ↓
Cache / Queue / Database
   ↓
Audit
   ↓
Monitoring
```

Security controls remain active whether the application has one backend server or many.
Security posture is `17`; threats and trust boundaries are `18`; the audit trail is `31`.

---

# 21. Complete ServiceHub Architecture

```text
                               SERVICEHUB
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       ▼                           ▼                           ▼
   USER / UI                 PRODUCTION LAYER             DATA LAYER
       │                           │                           │
       ▼                           ▼                           ▼
 React + TS                 Load Balancer               PostgreSQL
 Vite                       Backend Servers             Prisma
 Tailwind                   Cache                       Migrations
                            Queue                       Indexes
                            Workers                     Replicas
       │                           │                           │
       └───────────────────────────┼───────────────────────────┘
                                   │
                                   ▼
                            APPLICATION LAYER
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
          Authentication      Business Logic      Integrations
          Authorization       Services            Jobs
          Validation          Controllers         Notifications
          Security            Routes              External APIs
                │                  │                  │
                └──────────────────┼──────────────────┘
                                   │
                                   ▼
                         CROSS-CUTTING CONTROLS
                                   │
             ┌─────────────────────┼─────────────────────┐
             ▼                     ▼                     ▼
          Security              Audit             Observability
             │                     │                     │
             └─────────────────────┼─────────────────────┘
                                   │
                                   ▼
                         TESTING + CI/CD
                                   │
                                   ▼
                            PRODUCTION
```

---

# 22. Final Documentation Goal

The complete documentation must allow each audience to answer its questions **without
reading code**.

## 22.1 Non-Technical Stakeholders

```text
What is ServiceHub?          → 01
       ↓
Who uses it?                 → 01 §1.2, 07
       ↓
What services are available? → 21
       ↓
How does a request work?     → 04, 22
       ↓
Who handles it?              → 22, 24
       ↓
Who approves it?             → 26
       ↓
How are SLAs monitored?      → 25
       ↓
How is the activity audited? → 31
```

## 22.2 Developers

```text
What must be built?          → 02
       ↓
Where should it be built?    → §3 of this charter, 13, 14
       ↓
How does the UI work?        → 14, 15, 16
       ↓
How does the API work?       → 11, 12
       ↓
How does the backend work?   → 13
       ↓
How does PostgreSQL work?    → 08, 09, 10
       ↓
How is the application secured? → 17, 18, 19
       ↓
How is it tested?            → 20, 37
       ↓
How does it scale?           → 33
```

## 22.3 AI Coding Agents

```text
PROJECT              → 01
 ↓
REQUIREMENTS         → 02
 ↓
ARCHITECTURE         → 03
 ↓
FLOWS                → 04
 ↓
FOLDER STRUCTURE     → §3 of this charter, 13, 14
 ↓
FEATURE              → 05, 21–28
 ↓
UI                   → 15, 16
 ↓
API                  → 11
 ↓
DATABASE             → 08, 09, 10
 ↓
SECURITY             → 17
 ↓
AUDIT                → 31
 ↓
TESTS                → 37
 ↓
IMPLEMENTATION PHASE → 40
 ↓
ACCEPTANCE CRITERIA  → 41
```

The agent operating contract — read-before-write, never invent a decision, verify
honestly, and the fifteen hard rules — is `39`.

---

# 23. Final Technology Baseline

## 23.1 Decided

```text
Frontend
├── React
├── TypeScript
├── Vite
├── Tailwind CSS
├── React Router
├── TanStack Query
├── React Hook Form
├── Zod
└── API Client

Backend
├── Node.js
├── Express.js
├── TypeScript
├── Zod
├── Argon2id
├── Pino
└── REST API

Database
├── PostgreSQL
└── Prisma ORM

Testing
├── Vitest
├── React Testing Library
├── Supertest
├── Playwright (E2E)
├── Security Testing
└── k6 or equivalent (Performance Testing)

Infrastructure
├── Docker
├── Docker Compose
├── Git
├── GitHub
└── CI/CD
```

## 23.2 Required by the Architecture but Previously Unnamed

The version 1.0 baseline omitted five components that §5–§21 silently depend on. They
are now explicit, with their deciding ADR:

| Component | Role | Decision |
|---|---|---|
| **Cache** (Redis-compatible) | Cache regions with TTL and invalidation (`33` §5) | **D-3** → `ADR-0003` |
| **Queue / Broker** | Async tier: delivery, scheduling, compute, integration (`03` §6, `33` §10) | **D-3** → `ADR-0003` |
| **Connection pooler** (PgBouncer-compatible) | Bounds real database connections (`33` §4) | part of the `D-3` pool plan |
| **Object storage** (S3-compatible) | File bytes, so backends stay stateless (`19`, `03` §7) | **D-4** → `ADR-0004` |
| **Orchestrator** | Rolling deploys, probes, secret injection (`35`, `36`) | **D-5** → `ADR-0005` |

## 23.3 Security Baseline (with `17`)

```text
Security
├── Authentication              (mechanism: D-1)
├── Authorization               (RBAC)
├── Object-Level Authorization  (per-record access)
├── Input Validation            (Zod at every boundary)
├── Rate Limiting               (per surface, §11)
├── CORS
├── Security Headers
├── Secure File Handling
├── Secrets Management
├── Audit Logging               (append-only)
└── Supply-chain scanning       (dependencies + container images)
```

**Object-level authorization is the single most important control.** Most real ITSM
breaches are not broken authentication; they are a valid user reading a record that is
not theirs (IDOR on ticket identifiers). It is enforced in the **service layer**, and it
has negative tests (`07`, `17`, `20`, `37` §5).

---

# 24. Final Master Development Flow

```text
                         SERVICEHUB
                             │
                             ▼
                       REQUIREMENTS
                             │
                             ▼
                       USER ANALYSIS
                             │
                             ▼
                         UI DESIGN
                             │
                             ▼
                          UI FLOW
                             │
                             ▼
                      FEATURE STRUCTURE
                             │
                             ▼
                        FEATURE FLOW
                             │
                             ▼
                    APPLICATION FLOW
                             │
                             ▼
                   SYSTEM ARCHITECTURE
                             │
                             ▼
                   FRONTEND ARCHITECTURE
                             │
                             ▼
                    BACKEND ARCHITECTURE
                             │
                             ▼
                       API ARCHITECTURE
                             │
                             ▼
                    DATABASE ARCHITECTURE
                             │
                             ▼
                    SECURITY ARCHITECTURE
                             │
                             ▼
                      AUDIT ARCHITECTURE
                             │
                             ▼
                   PRODUCTION ARCHITECTURE
                             │
                             ▼
                    SCALABILITY DESIGN
                             │
                             ▼
                     TESTING ARCHITECTURE
                             │
                             ▼
                     DEPLOYMENT DESIGN
                             │
                             ▼
                       IMPLEMENTATION
                             │
                             ▼
                           TEST
                             │
                             ▼
                     SECURITY REVIEW
                             │
                             ▼
                       CODE REVIEW
                             │
                             ▼
                  DOCUMENTATION UPDATE
                             │
                             ▼
                    ACCEPTANCE VALIDATION
                             │
                             ▼
                        NEXT PHASE
```

---

# 25. Final Production Flow

```text
Users
  ↓
Load Balancer
  ↓
Multiple Backend Servers
  ↓
Rate Limiting
  ↓
Authentication / Authorization
  ↓
Validation
  ↓
Business Logic
  ↓
Cache / Queue
  ↓
Connection Pool
  ↓
PostgreSQL
  ↓
Audit Logging
  ↓
Notifications / Background Jobs
  ↓
API Response
  ↓
Frontend
  ↓
UI Update
```

## 25.1 Database Protection Principle

```text
Database Protection
        │
        ├── Connection Pooling
        ├── Caching
        ├── Rate Limiting
        ├── Efficient Queries
        ├── Proper Indexing
        ├── Pagination
        ├── Read Replicas
        ├── Queueing
        ├── Transaction Control
        ├── Query Timeouts
        ├── Archival
        └── Monitoring
```

The objective is **not simply to prevent PostgreSQL from crashing**. The architecture
controls database pressure, reduces unnecessary database work, distributes application
traffic, processes expensive work asynchronously, and scales the system according to
measured bottlenecks.

---

# 26. Final Development Principle

```text
READ
 ↓
UNDERSTAND
 ↓
ANALYZE
 ↓
DESIGN
 ↓
DOCUMENT
 ↓
REVIEW
 ↓
APPROVE
 ↓
IMPLEMENT
 ↓
TEST
 ↓
SECURITY REVIEW
 ↓
CODE REVIEW
 ↓
UPDATE DOCUMENTATION
 ↓
VALIDATE
 ↓
NEXT PHASE
```

---

# 27. Open Decisions Register

These decisions **block document approval** (not drafting). Each is closed by an ADR in
`42` before the documents it blocks can reach `Approved`; until then the affected
documents stay `Draft`, and neither humans nor agents may implement a chosen option
silently (`39` A15).

| ID | Decision | Owner | Blocks | ADR |
|---|---|---|---|---|
| **D-1** | Session cookies vs stateless tokens | Security Lead | `06`, `14`, `17` | `ADR-0001` |
| **D-2** | Single-tenant vs multi-tenant | Tech Lead | `07`, `08`, `09`, `33` | `ADR-0002` |
| **D-3** | Cache provider, queue broker, pooler | Tech Lead | `03`, `33`, `35` | `ADR-0003` |
| **D-4** | File storage backend | DevOps | `19`, `36` | `ADR-0004` |
| **D-5** | Production orchestrator | DevOps | `03`, `35`, `36` | `ADR-0005` |
| **D-6** | Email/SMS provider | Backend Lead | `29` | `ADR-0006` |
| **D-7** | Quantified NFR targets (availability, p95 latency, RPO/RTO, retention, concurrency) | Product Lead | `02`, `36`, `37` | `ADR-0007` |
| **D-8** | SLA calendar and pause semantics | Product Lead | `25` | `ADR-0008` |
| **D-9** | Platform tenancy root, superadmin bootstrap and user onboarding | Tech Lead | `04`, `06`, `07`, `08`, `09`, `10` | `ADR-0012` |

**All decisions `D-1`–`D-9` are closed** (`Accepted`, recorded in `42` §3): `D-1`–`D-5`
at Gate 1 and `D-6`–`D-8` before the Phase 2 entry gate (2026-10-01); **`D-9` was
accepted on 2026-10-02** once the platform spine was found to have no defined beginning
(a tenant root, a platform operator and an onboarding flow were all missing).

Further choices are recorded as `Proposed` ADRs because they carry lasting cost:
`ADR-0009` (search technology — `30` recommends PostgreSQL full-text for v1),
`ADR-0010` (frontend test location — resolved in §3.1 and `38` §3), and `ADR-0011`
(CMDB relationship modelling out of scope for v1 — `02` records this as `Won't`).

**Gate impact:** `D-1`–`D-5` blocked the Phase 1 design gate and are closed; `D-6`–`D-8`
and `D-9` gated the Phase 2 core build and are closed. `D-7` drives the pass/fail
performance targets (`37`).

---

# 28. Governance, Gates and Change Control

## 28.1 Status Model

Every document is `Draft → In Review → Approved → Superseded`. Only `Approved`
documents may be implemented against. Code that contradicts an `Approved` document is a
defect in one of the two — resolved by a document fix or an ADR, never by silence.

## 28.2 Phase Gates

A phase is **gated at entry and demonstrated at exit**; work inside a phase iterates.

| Phase | Entry gate (documents `Approved`) | Exit milestone |
|---|---|---|
| 0 Foundation | `00`, `01`, `02`*, `40`, `41`, `42`, `43` | Scope agreed; `D`-list owned |
| 1 Design | `03`–`19`, `38`, `39` | Contracts frozen; `D-1`–`D-5` closed |
| 2 Core build | `20`–`37` for core features; `D-6`–`D-9` closed | Raise → approve → resolve → notify, with audit |
| 3 Extended | extended feature docs | KB, assets, integrations, reporting live |
| 4 Hardening | all documents | Security review, load targets, DR rehearsal, acceptance |

\* `02` may be approved qualitatively first, with **D-7** closed as an amendment.

A gate passes only when: the named documents are `Approved`; their blocking decisions
are closed by ADRs; the exit criteria are **demonstrated** (tests, measurements,
recorded rehearsals); and a drift audit found no implemented behaviour contradicting an
`Approved` document.

## 28.3 Architecture Decision Records

Required for closing any `D`-decision, for a choice between materially different
approaches with lasting cost, and for any deviation from an `Approved` document. An ADR
is immutable once accepted; a reversal is a superseding ADR. **Alternatives are
mandatory** — an ADR without them records an assertion, not a decision.

## 28.4 Change Requests

Required when scope, a requirement, a contract, an API shape or a security control
changes. A CR updates every `Approved` document it affects **in the same change**.
Weakening a security control additionally requires the Security Lead's approval and an
ADR. The append-only change log is `43`.

## 28.5 Definition of Done

Per-change completion is `41`. It is not equivalent to a phase gate: a phase
additionally requires its document set approved and its decisions closed.

## 28.6 Drift Audit

At every phase gate, product and engineering reconcile implemented behaviour against
`Approved` documents. Divergence produces a document fix or an ADR — never silence. This
is the mechanism that keeps this charter honest over time.

---

# 29. Acceptance of This Charter

This charter is **accepted as the master document** for ServiceHub when:

1. `docs/00-DOCUMENTATION-PLAN.md` … `docs/43-CHANGELOG.md` exist and cover every
   original document number `00`–`105` (`00` §5).
2. Every document has an owner, a status, a stated audience and its open questions listed
   (`00` R6).
3. The decisions `D-1`–`D-9` are recorded with owners and instantiated as ADRs (§27).
4. The folder structure in §3 is preserved, and the two structure resolutions in §3.1 are
   applied.
5. The technology baseline in §23 names every component the production architecture
   (§5–§21) depends on.
6. No document states a decision that is not either decided, or explicitly listed as open
   (`00` R4).

**Current status against 1–6:** (1) satisfied — 44 documents present; (2) satisfied —
the Phase 0 set, the Phase 1 design set and the Phase 2 core documents are `Approved`,
the remainder awaiting their gates; (3) satisfied — all eight decisions closed by
`ADR-0001`–`ADR-0008`; (4) satisfied; (5) satisfied — `D-3`/`D-4`/`D-5` resolved
(Redis/PgBouncer, S3 object storage, Kubernetes), and `D-6` (Knock/SendGrid/Twilio),
`D-7` (the `02` C.1 targets) and `D-8` (per-policy calendars); (6) satisfied.

**This is the final ServiceHub charter and architecture (version 2.0).**
