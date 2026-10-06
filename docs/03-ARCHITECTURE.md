# 03 — Architecture

**Status:** Approved · **Owner:** Tech Lead · **Reviewers:** Backend Lead, DevOps · **Approved:** 2026-10-01
**Consolidates:** old 04, 05, 89 (system, application, production architecture)
**Decided by:** `ADR-0003` (D-3 — Redis cache/broker, PgBouncer pooler), `ADR-0005` (D-5 — Kubernetes)

> **Scope of this document:** what the system is made of, how the parts are allowed
> to depend on each other, and how it is deployed. **Flows are not here** — see
> `04-WORKFLOWS-AND-FLOWS.md`. **Scaling strategy is not here** — see
> `33-SCALABILITY-AND-DATABASE-PROTECTION.md`.

---

## 1. Architectural Style

ServiceHub is a **modular monolith** with an explicitly separated asynchronous tier.

- One deployable backend process, internally divided into modules with enforced
  dependency direction (§4). Not microservices: the team size and transaction
  patterns do not justify distributed consistency costs.
- One deployable frontend SPA, served as static assets over the CDN/LB.
- One PostgreSQL database as the system of record.
- One asynchronous tier (queue + workers) for anything that must not block a
  request.

**The modular split is enforced at the database level too:** modules communicate
through exported service interfaces, never by reading each other's tables directly.
A module that needs another module's data calls its service. This is what makes the
monolith decomposable later if it ever must be.

## 2. Layer Model

```
┌──────────────────────────────────────────────────────────────┐
│ CLIENT        React SPA (TypeScript, Vite, Tailwind)         │
│               talks only to the REST API                     │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS / JSON
┌───────────────────────────▼──────────────────────────────────┐
│ EDGE          TLS termination · Load balancer · Rate limiting │
│               static asset delivery                           │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ APPLICATION   Express app (Node.js, TypeScript)               │
│                                                              │
│   Middleware → Routes → Controllers → Services → Repositories │
│                        │                    │                 │
│                   Validation (Zod)      Prisma client         │
└───────┬───────────────────────────────┬──────────────────────┘
        │ enqueue                       │ pooled connections
┌───────▼───────────────┐   ┌───────────▼──────────────────────┐
│ ASYNC TIER            │   │ DATA TIER                         │
│ Queue + Workers       │   │ PostgreSQL primary                │
│ (email, SLA, reports) │   │ (+ read replica when measured)    │
└───────────────────────┘   └──────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│ CROSS-CUTTING   Cache · Audit · Logging · Metrics · Config    │
└──────────────────────────────────────────────────────────────┘
```

## 3. Component Inventory

| Component | Responsibility | Owns | Must not |
|---|---|---|---|
| SPA | Rendering, client-side routing, form UX, optimistic UI | No business rules | Enforce authorization or validation |
| Edge / LB | TLS, routing, rate limiting, asset caching | Request admission | Know about domain logic |
| Middleware layer | Correlation id, authn, rate limit, logging, error shaping | Request context | Contain domain logic |
| Routes | Path → controller mapping, permission annotation | The URL surface | Contain logic beyond mapping |
| Controllers | HTTP translation: parse, validate, call service, shape response | No domain logic | Touch Prisma directly |
| Services | Business rules, state machines, transactions, authorization decisions | All domain invariants | Know about `req`/`res` |
| Repositories (`models/`) | Prisma access, query shape, pagination | Query construction | Contain business rules |
| Workers | Async job execution | Job retry/idempotency | Serve HTTP |
| Integrations | Adapters for external systems | Protocol translation | Leak vendor types into the domain |
| Audit writer | Append-only audit records | Audit record shape | Be bypassable per-module |

Dependency direction is strictly downward and never sideways between modules:

```
routes → controllers → services → repositories → prisma
                          │
                          ├→ integrations (via interfaces only)
                          ├→ jobs (enqueue only)
                          └→ cache (via a cache interface only)
```

> **`Repositories` and the mandated structure.** The charter's `backend/src/` has no
> `repositories/` directory, so the repository (persistence) layer is implemented in
> the mandated `models/` directory — `models/` *is* the repository layer. The
> import-boundary lint enforces that only services may import it and that it imports
> nothing upward (`13` §2). The resolution is recorded in `43`.

## 4. Module Boundaries

Modules map to the domain documents `21`–`28` plus platform modules.
Dependency rules:

| Module | May depend on | Must not depend on |
|---|---|---|
| identity | — | any domain module |
| authorization | identity | any domain module |
| catalog | identity, authorization | requests, incidents |
| requests | catalog, authorization, sla | incidents |
| incidents | catalog, authorization, sla | requests |
| tasks | requests, incidents, authorization | — |
| approvals | requests, authorization | incidents |
| sla | catalog, authorization | tasks, approvals |
| knowledge | identity, authorization | requests, incidents |
| assets | identity, authorization | requests, incidents |
| notifications | (event consumers only) | nothing directly — event-driven |
| audit | (write-only sink) | nothing |

**Enforcement:** an import-boundary lint rule rejects cross-module imports that
violate this table. The table is the contract; the lint rule is the mechanism.

`notifications` and `audit` are intentionally dependency-free sinks fed by events,
so adding a notification or an audit record never requires changing a domain module.

## 5. Request Lifecycle (synchronous path)

1. Edge terminates TLS, applies coarse IP rate limiting, forwards.
2. Middleware assigns/propagates a correlation id; opens a log context.
3. Authentication resolves the caller (server-side session, `ADR-0001`).
4. Route-specific rate limit applies (tighter for auth, upload, search).
5. Controller parses and validates input with Zod; invalid input short-circuits
   with `422` and never reaches the service.
6. Service performs **authorization** (role **and** object level), then business
   logic inside a transaction where multiple writes are involved.
7. Repository executes parameterized, indexed, paginated queries.
8. Mutations write an audit record **in the same transaction** as the change.
9. Any non-immediate work (email, notifications, reports) is **enqueued**, never
   awaited inline.
10. Response is shaped into the documented envelope; errors become problem
    responses (`11-API-CONTRACT.md`).

Detail and sequence diagrams: `04-WORKFLOWS-AND-FLOWS.md`.

## 6. Asynchronous Tier

Purpose: keep request latency independent of work that is slow, bursty, or external.

| Job class | Examples | Trigger |
|---|---|---|
| Delivery | email, SMS, webhooks | domain events |
| Scheduling | SLA breach sweep, escalation, digest | cron (single leader) |
| Compute | report generation, bulk export, large import | user request |
| Integration | inbound sync, outbound reconcile | cron or event |
| Maintenance | retention pruning, archival, orphan cleanup | cron |

**Rules**
1. Jobs are **idempotent** — every worker may process a message more than once.
2. Jobs carry an idempotency key; effects are keyed on it.
3. Jobs are **versioned**; changing a payload shape adds a version, never mutates
   an old one in flight.
4. A job never assumes a prior job ran; it verifies state.
5. Poison messages are dead-lettered after bounded attempts, with an alert.
6. Scheduled jobs run under a **distributed lock** so that N backend instances do
   not each run the scheduler — the classic horizontal-scaling defect.

The tier runs on **Redis** as the broker, and the cache is the same Redis instance
under a distinct key namespace (`ADR-0003`). Connections are bounded by **PgBouncer**
(`ADR-0003`); the deployment target is **Kubernetes** (`ADR-0005`), which supplies the
probes, rolling deploys and secret injection described below and in `35`.

## 7. Deployment Topology

### Development
```
docker compose: frontend (vite) · backend (nodemon/tsx) · postgres · redis · mailhog
```

### Production (target)
```
                     Internet
                        │
                        ▼
                ┌───────────────┐
                │ Load balancer │  TLS · rate limit · static assets
                └───────┬───────┘
            ┌───────────┼───────────┐
            ▼           ▼           ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ Backend1 │ │ Backend2 │ │ BackendN │   stateless, no local state
      └────┬─────┘ └────┬─────┘ └────┬─────┘
           └────────────┼────────────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
      ┌───────────────┐   ┌───────────────┐
      │ Cache / Queue │   │   Workers     │
      └───────┬───────┘   └───────┬───────┘
              └─────────┬─────────┘
                        ▼
              ┌───────────────────┐
              │ Connection pool   │
              └─────────┬─────────┘
                        ▼
              ┌───────────────────┐        ┌───────────────┐
              │ PostgreSQL primary├───────►│ Read replica  │
              └───────────────────┘ repl.  └───────────────┘
```

**Statelessness rule:** a backend instance must hold no state that another instance
needs — no local sessions, no local uploads, no local caches, no local job locks.
This is what makes the horizontal story true; violating it is the most common way
"scales horizontally" turns out to be false. Object storage (`ADR-0004`) exists for
exactly this reason.

Orchestrator is **Kubernetes** (`ADR-0005`); the topology above is orchestrator-independent, so the choice affects delivery (`35`) and probes (`34`) rather than this diagram.

## 8. Failure Behaviour

| Failure | Behaviour |
|---|---|
| Instance unhealthy | LB drains it (readiness probe fails); traffic routes to healthy peers |
| Instance mid-request at shutdown | Graceful shutdown: stop accepting, finish in-flight, then exit |
| Cache unavailable | Degrade to database reads; **never** fail the request because cache is down |
| Queue unavailable | Mutating request still returns success; delivery is retried; alert |
| Worker crash | Message redelivered; idempotency prevents duplicate effect |
| Replica unavailable | Read traffic fails back to primary; alert |
| Primary unavailable | Read-only degraded mode or hard failure depending on capability; alert |
| External integration down | Timeout, bounded retry with backoff, circuit breaker, dead-letter |
| Slow query | Statement timeout cancels it; alert; never an unbounded wait |

**Retry discipline:** retries are bounded, exponentially backed off, jittered, and
only applied to idempotent operations. Blind retries multiply load precisely when
the system is already struggling. Non-idempotent operations (payment-like effects,
external side effects) are never auto-retried without an idempotency key.

## 9. Cross-Cutting Concerns

| Concern | Mechanism | Documented in |
|---|---|---|
| Configuration | Typed env loading, validated at boot; fail fast on missing | `35` |
| Secrets | Injected at runtime, never in the image or the repo | `17`, `35` |
| Logging | Pino structured JSON with correlation id | `34` |
| Metrics/health | Liveness, readiness, dependency health | `34` |
| Audit | Append-only, transactional with the mutation | `31` |
| Caching | Named cache regions with explicit TTL and invalidation | `33` |
| Authorization | Enforced in services, not only in routes | `07` |
| Validation | Zod at every boundary | `12` |
| Errors | Single problem-response shape | `11` |

## 10. Explicit Exclusions

- No microservices, no service mesh, no event sourcing in v1.
- No second datastore for OLTP. Search may use PostgreSQL full-text before any
  external index is considered (`30`).
- No server-side rendering; the SPA is static.
- No local-disk persistence of any kind in production (`19`).

## 11. Decisions This Document Closes or Depends On

| Decision | Status | Effect if unresolved |
|---|---|---|
| D-2 tenancy | Closed — `ADR-0002` (multi-tenant) | Scope is a mandatory query and index dimension |
| D-3 cache/queue provider | Closed — `ADR-0003` (Redis + PgBouncer) | Async tier runs on Redis; connections bounded by PgBouncer |
| D-5 orchestrator | Closed — `ADR-0005` (Kubernetes) | Probes, rolling deploys and secret injection per `35` |

## 12. Related

- `04-WORKFLOWS-AND-FLOWS.md` — the flows this structure carries
- `13-BACKEND-ARCHITECTURE.md` — inside the application layer
- `14-FRONTEND-ARCHITECTURE.md` — inside the client
- `33-SCALABILITY-AND-DATABASE-PROTECTION.md` — how this scales
- `34-OBSERVABILITY.md` · `35-DEPLOYMENT-AND-CI-CD.md` · `36-OPERATIONS-AND-RECOVERY.md`
