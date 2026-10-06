# 37 — Testing

**Status:** Approved · **Owner:** QA Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 74, 75, 76, 77, 78, 79, 81 (strategy, cases, unit, integration, API, E2E, performance)
**Decided by:** `ADR-0007` (D-7) — performance pass/fail uses the targets in `02` C.1

> **Scope:** the whole test strategy — levels, what each level must prove, fixtures,
> performance/load testing. **Security testing** is `20`. **Test-case *content* for
> domain behaviour** lives in each domain document's Acceptance Criteria section; this
> document defines how those criteria are proven, not what they say.

---

## 1. Purpose and the test pyramid

Testing exists to make the system's claims checkable. The organising idea is the
pyramid: many fast tests at the bottom, fewer slower tests as you go up, because each
level up costs more runtime and more flakiness per assertion.

```
        ▲   few, slow, high-confidence
   E2E (2–5%)          critical user journeys
   Integration/API (20–30%)   routes ↔ database ↔ jobs
   Unit (65–75%)       services, validators, pure logic, fast
        ▼   many, fast, precise
```

**Where domain tests live:** each document `21`–`33` states Acceptance Criteria. Those
criteria are the source of the domain test cases. This document says *at which level*
each is tested and *how* the level is built, so a criterion is proven once, at the
right layer.

## 2. What Each Level Proves

| Level | Proves | Must not attempt | Tooling |
|---|---|---|---|
| Unit | Pure logic: validation rules, state transitions, SLA arithmetic, permission predicates | Database or HTTP behaviour | Vitest |
| Component (frontend) | Rendering, form UX, accessibility | Server rules | Vitest + React Testing Library |
| Integration | Service + database behaviour: constraints, transactions, idempotency, concurrency | Browser UX | Vitest + real Postgres (ephemeral) |
| API | Contract: status codes, validation, authorization, error shape, pagination | UI rendering | Supertest |
| E2E | Critical journeys end to end, including the client | Exhaustive matrices | Playwright |
| Performance/load | The system meets quantified targets under concurrency | Functional correctness | Load tool (k6 or equivalent) |

**The line that matters most:** business rules are tested at the **service/integration**
level, not only through the API and not only in the UI. A rule tested only through the
UI is untested for every other caller.

## 3. Test Data and Fixtures

| Rule | Reason |
|---|---|
| Every integration test runs against a **real PostgreSQL** instance, ephemeral per run | Mocking the database tests the mock; constraints, transactions and locking are the behaviour under test |
| Each test isolates its data (transaction rollback or unique fixtures) | Order-independent, parallel-safe |
| Factories build valid entities; tests override only what they assert | Readable, resilient to schema additions |
| No production data in any test environment | Privacy (`19`) |
| Time is injected, never read from the system clock in domain logic | SLA and deadline tests must be deterministic (`25`) |
| Randomness is seeded | Reproducible failures |

**Deterministic time is non-negotiable for SLA.** A test of working-hours arithmetic
that reads the real clock passes in one time zone and fails in another, and can pass
during DST and fail after it.

## 4. Coverage Strategy

Coverage is a **signal, not a target**. A fixed percentage gate invites tests written to
raise the number — assertions on getters, snapshots of nothing.

| Area | Expectation |
|---|---|
| Business rules / state machines | Every transition and guard has a unit or integration test |
| Authorization | Every permission boundary has a **negative** test (denial proven, not assumed) |
| Validation | Every rule has an accept and a reject case |
| SLA/TZ/DST arithmetic | Explicit boundary tests (the `25` worked examples) |
| Error paths | Each documented error code has a test |
| Changed code | Coverage must not regress on changed lines |

**The rule reviewers enforce:** a new branch of logic without a test that fails when the
branch is removed is not done (`41`).

## 5. What Must Be Tested at the API Level

Per `11`/`12`:

- The success path returns the documented shape and status.
- Validation rejects with `422` and a field-level, machine-readable error.
- Authorization rejects with `403` for a wrong-role caller and `404` for a caller who
  cannot see the object — **the 404-vs-403 distinction is tested, not assumed** (`17`).
- Pagination is cursor-stable under concurrent inserts.
- Idempotency keys make a repeated mutating request a no-op.
- Rate limits return `429` with the documented headers.
- Errors never leak stack traces, SQL, or internal ids.

## 6. What Must Be Tested at the Integration Level

- Database constraints actually reject invalid data (unique, FK, `CHECK`, partial unique
  indexes such as the single-open-assignment rule in `28`).
- A mutation and its audit row commit or roll back **together** (`31`).
- The outbox row is written in the same transaction as the mutation (`29`).
- Concurrency: two simultaneous writers on the same resource produce exactly one
  success and one defined outcome (no lost updates, no silent overwrite).
- Idempotent jobs redispatched twice produce one effect.

## 7. End-to-End

E2E is reserved for journeys whose **integration** is the risk, not the steps:

| Journey | Why E2E |
|---|---|
| Sign in → raise a request → approval → resolution | Spans auth, catalog, requests, approvals, SLA |
| Raise an incident → assign → resolve → notification | Spans incidents, notifications |
| Search finds a restricted record only for an authorised user | Cross-cutting authorization in the real stack |
| Admin edits a catalog item → previous request unchanged | The in-flight-fidelity rule end to end |

E2E tests run against a deployed staging environment, are the slowest and most flaky
tier, and are quarantined-and-fixed rather than retried until green.

## 8. Performance and Load Testing

Targets are quantified in `02` (**D-7**). Without numbers there is no pass/fail, so
this section defines the method and marks the thresholds as pending.

| Test | Question |
|---|---|
| Baseline | What is p50/p95/p99 at expected concurrency? |
| Load | Does the system meet targets at expected peak? |
| Stress | Where is the first bottleneck, and does it degrade or fail hard? |
| Spike | Does a sudden burst recover, or stay degraded? |
| Soak | Does it leak (memory, connections, locks) over hours? |
| Database-specific | Connection-pool exhaustion, slow-query behaviour, replica lag under load |

Method rules:

- Test against production-shaped data volume; a load test on an empty database measures
  nothing.
- Measure the **protection layers** (`33` §14), not just end-to-end latency, so the
  bottleneck is identified, not merely observed.
- Warm up before measuring; report percentiles, never only averages.
- Every performance optimization is justified by a before/after measurement (ADR, `42`).

## 9. Flaky Tests

A flaky test is a defect in the test or the system, treated as such:

| Rule | Reason |
|---|---|
| Flaky tests are quarantined with an owner and a deadline, never silently skipped | Skipping hides a real failure the next time it is real |
| Common causes are fixed at the source — real clock, shared state, ordering, network | Retries mask flakes and slow the suite |
| E2E flakiness from timing is replaced with awaited conditions, not sleeps | Deterministic waits |
| The suite must be deterministic under parallel execution | Non-determinism destroys trust in green |

## 10. CI Execution

| Stage | Tests | Blocks merge |
|---|---|---|
| Fast | Lint, typecheck, unit, component | Yes |
| Integration | Service + database + API against ephemeral Postgres | Yes |
| Security | `20` checks | Yes for high/critical |
| E2E | Against staging, on merge and before release | Yes for release |
| Performance | Scheduled and on demand | Against targets (**D-7**) |

## 11. Test Environments

| Environment | Data | Purpose |
|---|---|---|
| CI | Ephemeral, migrations + seed, per run | Deterministic pass/fail |
| Local | Compose stack (`35` §3) | Development feedback |
| Staging | Production-shaped, anonymised | E2E and performance |

## 12. Open Decisions

| ID | Decision | Effect |
|---|---|---|
| D-7 | Quantified NFR targets | Performance tests have no pass/fail until closed |
| D-3 | Cache/queue provider | **Closed** (`ADR-0003`, Redis) — integration and load tests of the async tier |

## 13. Acceptance Criteria

1. Every Acceptance Criterion in documents `21`–`33` maps to at least one automated
   test at the stated level; the mapping is reviewable.
2. Authorization boundaries have negative tests; the 404-vs-403 distinction is asserted.
3. Integration tests run against real PostgreSQL and prove constraints and transactional
   audit/outbox behaviour.
4. SLA arithmetic is tested with injected time, including a DST boundary and a paused
   interval.
5. A repeated mutating request with the same idempotency key causes one effect.
6. E2E covers the four journeys in §7 and passes on staging before release.
7. No test depends on wall-clock time, execution order, or shared mutable state.
8. Flaky tests are quarantined with an owner and a deadline; none are silently skipped.
9. Load tests produce p50/p95/p99 and layer signals, and are compared to targets once
   **D-7** is closed.

## 14. Related

- `20-SECURITY-TESTING.md` — the security test suite
- `25-SLA-MANAGEMENT.md` — the boundary cases that must be unit-tested
- `31-AUDIT-LOGGING.md` · `29-NOTIFICATIONS-AND-MESSAGING.md` — transactional guarantees to prove
- `34-OBSERVABILITY.md` — the signals load tests read
- `35-DEPLOYMENT-AND-CI-CD.md` — where these tests run
