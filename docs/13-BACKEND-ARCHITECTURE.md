# 13 — Backend Architecture

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 27, 28 (backend requirements, backend architecture) and the
backend half of old 29 (backend flow) and old 26 (error handling)

> **Scope:** the internals of the application layer. System-level components are `03`;
> the sequence of a request is `04`; the wire contract is `11`.

---

## 1. Layer Responsibilities

```
src/
├── config/          typed env loading, validated at boot
├── middlewares/     correlation, authn, rate limit, validation, error handling
├── routes/          path → controller wiring + permission annotations
├── controllers/     HTTP translation only
├── services/        all business rules, transactions, authorization decisions
├── models/          persistence access (Prisma) and query construction
├── validators/      Zod schemas per request shape
├── helpers/         pure, stateless utilities
├── integrations/    external system adapters (email, SMS, storage, webhooks)
├── jobs/            queue producers and consumers
├── utils/           logging, errors, time, pagination primitives
├── @types/          global type augmentations (Express request, env)
├── app.ts           express app assembly (no listen)
├── server.ts        process bootstrap, graceful shutdown
```

This structure is fixed (charter §3). Modules from `05` are expressed as
subdirectories inside `services/`, `controllers/`, `routes/` and `models/` — for
example `services/requests/`, `services/sla/`.

## 2. Layer Rules

| Layer | May import | Must never |
|---|---|---|
| `routes` | controllers, middleware | contain logic beyond wiring |
| `controllers` | services, validators, utils | touch Prisma, contain business rules |
| `services` | models, integrations, jobs, utils, helpers, other services via interfaces | touch `req`/`res`, import express types |
| `models` | prisma client, helpers | contain business rules |
| `integrations` | http clients, config, utils | import services (no cycles) |
| `jobs` | services, integrations, models | import controllers |

**Rule: no service method receives an Express object.** A service takes plain
arguments and returns plain results. This is what makes services unit-testable without
an HTTP harness, and it is the most commonly violated rule in Express codebases.

**Rule: cross-module access goes through the module's service interface**, never
through its repository or its Prisma model directly (`03` §4). Enforced by import lint.

## 3. Request Path Assembly

```
app.ts
  ├─ trust proxy
  ├─ security headers (helmet)
  ├─ body parsers with explicit size limits
  ├─ correlation id + request logging
  ├─ rate limiter (global bucket)
  ├─ session/token resolution
  ├─ routes
  │    ├─ route-specific rate limiter
  │    ├─ schema validation middleware
  │    ├─ permission annotation
  │    └─ controller
  ├─ 404 handler
  └─ error handler (single, terminal)
```

**Order matters and is not arbitrary:** correlation before logging (so every log line
is attributable), authentication before authorization, validation before service
entry, and the error handler last so it catches everything above it.

## 4. Controller Contract

A controller does exactly five things and nothing else:

1. Read the **already-validated** input (typed by the schema).
2. Read the caller context (identity, entitlement set, correlation id).
3. Call one service method.
4. Map the result or thrown error to a status code and body.
5. Return.

```ts
export const createRequest = async (req: Request, res: Response, next: Next) => {
  try {
    const result = await requestService.create({
      input: req.validated.body,
      actor: req.context.actor,
      correlationId: req.context.correlationId,
    });
    res.status(201).location(`/api/v1/requests/${result.id}`).json(result);
  } catch (err) { next(err); }
};
```

No `if` on business conditions, no `try` around anything but delegation, no mapping
from database fields to API fields beyond what the service returned.

## 5. Service Contract

| Aspect | Rule |
|---|---|
| Input | Plain, validated, typed arguments |
| Output | Plain DTOs, never Prisma models leaked to the controller |
| Authorization | Performed **inside** the service (`07` §6) |
| Transactions | Opened by the service, not the controller or repository |
| Side effects | Only via injected interfaces (jobs, integrations) so they can be stubbed |
| Errors | Throws typed domain errors; never returns `null` to mean "denied" |
| Purity | No ambient reads of `process.env`, the clock, or randomness — inject them |

**Injecting the clock and randomness** is what makes SLA arithmetic, reference
generation and lockout windows testable without sleeping or mocking `Date` globally.
SLA tests in particular are intractable otherwise.

### Domain error taxonomy

```
AppError
 ├── ValidationError      → 422
 ├── AuthenticationError  → 401
 ├── AuthorizationError   → 403 / 404 (by visibility rule)
 ├── NotFoundError        → 404
 ├── ConflictError        → 409
 ├── IllegalTransitionError → 409
 ├── RateLimitError       → 429
 └── DependencyError      → 503
```

Only these cross the service boundary. Anything else is a bug and becomes a `500`
with a correlation id and a full server-side log — never a leaked stack trace.

## 6. Persistence Rules

- Prisma is the only data access mechanism (NFR-CONST-002). Raw SQL requires
  justification, review, and a comment explaining why the query builder was
  insufficient.
- Queries live in `models/`, never inline in a service. This gives one place to audit
  query shape, pagination and scope filters.
- Every collection query takes an explicit limit (`09` §6).
- Repositories never return unpaginated arrays for user-facing lists.
- `select`/`include` are always explicit; implicit full-row reads are rejected in
  review because they silently widen the payload as the schema grows.
- Scope filters are part of the query, not a post-filter (`07` §6).

## 7. Transactions and Events

```
service method
   │
   ├─ prisma.$transaction(async tx => {
   │      write domain state
   │      write audit record          ← same transaction
   │      write outbox event          ← same transaction
   │   })
   │
   └─ after commit: outbox drain worker publishes to the queue
```

The **transactional outbox** solves the fundamental problem that you cannot
atomically commit a database write and an enqueue. Writing the event as a row in the
same transaction means a crash cannot lose it; the drain worker then publishes with
at-least-once delivery, and consumers are idempotent (`03` §6).

**Never** call an external service inside a transaction, and never `await` a job
enqueue as a condition of success.

## 8. Background Jobs

| Concern | Rule |
|---|---|
| Registration | Jobs declare a name, a versioned payload schema (Zod, same as HTTP), and a handler |
| Validation | Payloads are validated on consumption, not trusted because we produced them |
| Idempotency | Every handler is safe to run twice; keyed on an idempotency key |
| Retries | Bounded, exponential backoff, jittered |
| Dead letter | After the attempt limit; alerted, inspectable, replayable |
| Scheduling | Cron-style jobs run under a distributed lock so exactly one instance executes |
| Observability | Each run emits a metric and a structured log line with the job id |

## 9. Configuration

- Config is loaded **once** at boot into a typed object and validated with Zod; a
  missing or malformed variable stops the process immediately rather than failing at
  first use.
- `config` is imported; `process.env` is never read outside it.
- Secrets come from the environment or a secret store, never from files in the image
  (`17`, `35`).
- Every variable is documented in `.env.example` with its purpose and safe default.

**Fail-fast at boot** is deliberate: a misconfigured instance that starts and serves
errors is far worse than one that refuses to start and triggers a rollout failure.

## 10. Logging and Error Handling

- **Pino** structured JSON (NFR-CONST-006). One logger, injected, never `console`.
- Every log line carries `correlationId`, and where relevant `userId`, `route`,
  `durationMs`, `status`.
- A redaction filter removes passwords, tokens, secrets, and full request bodies on
  auth routes before serialisation (`34`).
- Errors are logged **once**, at the terminal handler, with the stack — not at every
  layer on the way up. Logging at each layer produces four copies of one failure and
  makes real incident volume unreadable.
- `500` responses carry no internal detail; the correlation id is the bridge.

## 11. Health and Shutdown

| Endpoint | Checks | Used by |
|---|---|---|
| `/health/live` | Process is running | Orchestrator liveness |
| `/health/ready` | Database reachable, config loaded, workers registered | Load balancer readiness |
| `/health` | Aggregate with dependency detail | Humans (restricted in production) |

Graceful shutdown sequence: stop accepting new connections → wait for in-flight
requests to complete (bounded) → stop workers → close the database pool → exit. The
drain window must be shorter than the load balancer's deregistration grace period, or
in-flight requests are cut off mid-response.

## 12. Testing Seams

| Layer | Test style |
|---|---|
| Service | Unit, with stubbed repositories/integrations and an injected clock |
| Controller | Integration through the HTTP layer, real validation, stubbed service |
| Repository | Integration against a real PostgreSQL instance (never a different engine) |
| Job handler | Unit with a validated payload + a real database transaction |
| End-to-end | Full stack over the real HTTP surface |

Tests run against **PostgreSQL**, not SQLite or an in-memory substitute: constraints,
enums, JSONB behaviour and transaction semantics differ, and testing against a
different engine tests a different system.

## 13. Related

- `03-ARCHITECTURE.md` — where this layer sits
- `11-API-CONTRACT.md` — what the controllers expose
- `12-VALIDATION-RULES.md` — the schemas in `validators/`
- `09-DATA-INTEGRITY-AND-INDEXING.md` — the queries in `models/`
- `34-OBSERVABILITY.md` · `37-TESTING.md`
