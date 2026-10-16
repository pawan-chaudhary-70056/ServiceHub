# 33 — Scalability and Database Protection

**Status:** Approved · **Owner:** Tech Lead · **Reviewers:** DBA, DevOps · **Approved:** 2026-10-01
**Consolidates:** old 18, 19, 90 (database scalability, protection, production scalability)
**Decided by:** `ADR-0002` (D-2 — multi-tenant), `ADR-0003` (D-3 — Redis + PgBouncer)

> **Scope:** how the system stays fast and available as load grows, and how PostgreSQL
> is protected from pressure it should not receive. **Query and index design** are
> `09`. **The report/search workload** is `30`. **Deployment topology** is `03` and `35`.

---

## 1. The Principle

Scaling is not "add hardware when it gets slow". It is the ordered removal of
unnecessary work before adding capacity:

```
Measure → identify bottleneck → optimize application → optimize queries →
improve indexes → cache → queue → tune the pool → scale backends → read replicas →
scale the database
```

**The order matters.** Adding replicas to mask an N+1 query is the most expensive way
to fix a code defect, and it hides the defect where it will later be rediscovered at
ten times the cost. Each step below is justified by a measurement, recorded as an ADR
when it is taken (`42`).

## 2. Why the Database Is the First Bottleneck

Application servers are stateless and scale by adding instances (`03` §7). PostgreSQL
is a single primary with a finite connection budget, finite CPU, and shared memory.
Under load, the failure order is predictable:

| Symptom | Cause | Correct response |
|---|---|---|
| Connection exhaustion | Too many pools / too many instances × pool size | Pool sizing, PgBouncer, fewer connections — **not** raising `max_connections` |
| CPU saturation | Unindexed scans, N+1, expensive sorts | Query and index fixes (`09`) |
| Lock contention | Long transactions, hot rows | Shorter transactions, retry, better isolation choices |
| I/O saturation | Table scans, unbounded exports, vacuum | Indexing, archival, async exports |
| Cache/queue sprawl | Everything synchronous | Move work off the request path |

Raising `max_connections` treats the symptom and makes CPU-context-switching the next
failure. PostgreSQL performs best with a modest number of active connections; the
protection strategy is about **work reduction**, not connection multiplication.

## 3. Protection Layer by Layer

```
                 USER REQUESTS
                       │
                       ▼
              Load balancer (TLS, static assets)
                       │
                       ▼
              Backend instances (stateless)
                       │
                       ▼
              RATE LIMITING            ← admit fewer, earlier
                       │
                       ▼
              CACHE CHECK              ← avoid the query entirely
                 ┌─────┴─────┐
                 ▼           ▼
              HIT         MISS
                 │           │
                 ▼           ▼
             RESPONSE   EFFICIENT QUERY   ← fewer/cheaper queries
                             │
                             ▼
                      CONNECTION POOL      ← bound concurrency
                             │
                             ▼
                        POSTGRESQL
                       ┌─────┴─────┐
                       ▼           ▼
                   PRIMARY     READ REPLICA   ← move reads off
```

Each layer removes work before it reaches the next. A layer that only reroutes work
(none of the above) is not protection.

## 4. Connection Pooling

| Concern | Rule |
|---|---|
| Pool per instance | Bounded, explicit (`connection_limit`), never Prisma's default under load |
| Total budget | `instances × pool size + workers ≤ Postgres connection budget − reserve` |
| Pooling mode | **Transaction/session pooling via PgBouncer** when instance count grows, so the app can hold many logical connections against few real ones |
| Prepared statements | Verified against the pooler's mode; unsupported modes are configured explicitly |
| Timeouts | `connection_timeout` and `statement_timeout` set, so a stuck query releases its connection |
| Idle connections | Released; idle-in-transaction is a monitored anti-pattern |
| Long transactions | Prohibited beyond a threshold; batch jobs chunk their work |

**The arithmetic is stated deliberately.** "Each of 6 backend instances opens 20
connections, plus 4 workers × 5, against a database that wants ~100 active" is a
capacity plan; vague pooling is how a healthy database dies at 3 a.m.

## 5. Caching

### 5.1 Eligible data

| Candidate | TTL | Invalidation |
|---|---|---|
| Category tree, active catalog items | minutes–hours | on any catalog mutation (`21`) |
| SLA policies/calendars (read path) | minutes | on policy/calendar change |
| Permissions/roles for a user | short | on role change; **bounded staleness stated** |
| Published KB articles | minutes | on publish/archive/visibility change (`27`) |
| Dashboard aggregates (`30` §3.4) | short (60 s, `REPORT_CACHE_TTL_SECONDS`) | on write of the class the metric reads (`report-cache.ts`; `43` increment 33) |
| Reference lists (catalog, SLA policies, KB) | short–minutes | on the mutation that changes the list |
| Session lookups (server-side sessions, `ADR-0001`) | session lifetime | on logout/revocation |

### 5.2 Rules

| # | Rule | Reason |
|---|---|---|
| C1 | Cache **after** authorization, or key by viewer class — never cache a permission-filtered view under a shared key | The classic cache authz leak |
| C2 | Explicit TTL on every region; no unbounded cache | Bounded staleness |
| C3 | Invalidate on write, in the same pathway as the write | Otherwise stale data survives its TTL |
| C4 | Cache is **best-effort**: a cache outage degrades to the database, never fails a request | Availability |
| C5 | Cache keys include the scope/tenant dimension (`ADR-0002`) | Cross-tenant leakage prevention |
| C6 | Never cache secrets, credentials or one-time tokens | Security |
| C7 | Stampede protection: jittered TTLs and single-flight on expensive keys | Prevents a thundering herd on expiry |
| C8 | Cache hit/miss is measured per region | Uncached-but-cached-looking code is invisible otherwise |

**A cache that is correct but keyed wrongly is a data breach; a cache that is keyed
correctly but never invalidated is a correctness bug.** Both are prevented by C1–C3.

## 6. Rate Limiting

| Surface | Rationale for a distinct limit |
|---|---|
| Authentication / password reset | Credential-stuffing and enumeration defence (`17`) |
| Search | Expensive queries; protects the database |
| File upload | Upload is the most resource-intensive user action (`19`) |
| Export / report generation | Moves work to async and bounds it |
| Public / unauthenticated APIs | Abuse protection |
| Administrative APIs | Limits blast radius of a compromised admin session |
| General API | Baseline per-user and per-IP |

Enforcement is layered: coarse at the edge, finer per route in middleware (`03` §5).
Limits are per-identity where authenticated and per-IP where not, and they **fail
closed** for authentication endpoints and **fail open (with logging)** for read-only
traffic during a limiter outage — the asymmetry is deliberate.

## 7. Query Discipline

| Rule | Detail |
|---|---|
| Required fields only | No `SELECT *` shaping at the service; repositories select what is used |
| Pagination everywhere | Cursor for records (`11` §6); no unbounded list endpoint |
| Indexed predicates | Every filter maps to an index (`30` §2.5) |
| No N+1 | Explicit includes/joins; detected in review and by query-count tests (`37`) |
| Bounded transactions | No external call, no email, no file I/O inside a transaction |
| Statement timeout | Every query has one; runaway queries are cancelled and alerted (`34`) |
| `EXPLAIN` review | Required for new queries over large tables (`38`) |
| Aggregates in SQL | Never load all rows to aggregate in the app (`30` §3.4) |
| Read-after-write | Writes and their immediate reads go to the **primary**; only replica-safe reads use a replica |

## 8. Indexing (references `09`)

Index design belongs to `09`; this document states the *operational* rules:

- An index exists because a query needs it, evidenced by a query pattern.
- Unused indexes are dropped (they cost writes and storage).
- Index creation on a live large table uses `CONCURRENTLY` (`10`).
- Index bloat is monitored; vacuum/analyze are observed (`34`).

## 9. Read Replicas

```
Application
   ├── WRITE / read-after-write ──▶ Primary
   └── replica-safe reads ────────▶ Replica (async replication lag)
```

| Rule | Reason |
|---|---|
| Adopted only when measured read load justifies it | Complexity and lag cost |
| Never for read-after-write | Replication lag would show the user stale data |
| Lag is monitored; on lag above a threshold, reads fail back to the primary | Correctness over offload |
| Replica failure is invisible to correctness | Fail back to primary with an alert (`03` §8) |
| Reporting where staleness is acceptable is the first candidate | Offload the heaviest reads first |

## 10. Queueing and Async Processing

Long or bursty work leaves the request path (`03` §6):

| Work | Why async |
|---|---|
| Email/SMS/notifications | External, slow, retried (`29`) |
| SLA breach sweep, escalation, digests | Scheduled, single-leader |
| Report generation, bulk export/import | CPU/IO heavy, user waits elsewhere |
| Integration sync/reconcile | External, unreliable |
| Retention/archival/cleanup | Maintenance, no user waiting |

Rules: jobs idempotent, versioned, single-leader for schedules, dead-lettered with
alert, and never a substitute for a transaction that must be atomic.

## 11. Transactions and Isolation

| Concern | Rule |
|---|---|
| Scope | Short; no external I/O inside |
| Default isolation | Read Committed; higher only where a specific anomaly requires it, documented |
| Hot rows | Avoid long-held locks on frequently updated rows (counters, statuses) |
| Retries | Only for serialization/deadlock failures, bounded, idempotent |
| Multi-step invariants | One transaction; do not split an invariant across requests |

## 12. Timeouts, Limits and Resource Controls

| Control | Purpose |
|---|---|
| `statement_timeout` | Cancel runaway queries |
| `idle_in_transaction_session_timeout` | Release stuck transactions |
| `connection_timeout` | Fail fast rather than queue forever |
| Request timeout at the edge | Bound total request duration |
| Job timeout and max attempts | Bound worker work |
| Export size/row caps | Bound memory and storage |
| Upload size caps | Bound ingestion (`19`) |

Every limit has an alert and a documented value; a limit nobody knows exists is a
latency incident waiting to happen.

## 13. Data Growth and Archival

| Concern | Approach |
|---|---|
| Record growth | Closed records past the active window move to archive partitioning |
| Audit growth | Archived but **never pruned before 24 months** (`31`) |
| Notification/job growth | Pruned per retention (`19`) |
| Search index growth | FTS follows the record's lifecycle; archived records leave the index |
| Reporting over history | Reads archives via the reporting path, not the live transactional path |

**Archival is a feature, not a cleanup script.** The live tables stay small so the hot
path stays fast; history remains queryable where it is needed.

## 14. Monitoring the Protection Layers

Each layer has a signal and an alert (`34`): pool utilisation, cache hit rate, rate
limit rejections, slow-query count, lock waits, replication lag, queue depth, dead
letters, statement-timeout count. Absence of a signal is treated as "not implemented",
not "healthy".

## 15. Horizontal Scaling of the Application

The application scales by adding instances only if it is **stateless** (`03` §7): no
local sessions, uploads, caches, or job locks. The two horizontal-scaling defects to
watch for:

1. **Scheduled jobs running per instance** — the SLA sweep firing N times (`25` §6).
   Fixed by the distributed lock / single leader.
2. **Local state assumed shared** — uploads on local disk disappearing when a different
   instance serves the download. Fixed by object storage (`ADR-0004`).

## 16. Failure and Degradation

| Failure | Behaviour |
|---|---|
| Cache down | Degrade to database; alert; never fail the request |
| Queue down | Mutations still commit (outbox); delivery deferred; alert |
| Replica down / lagging | Fail back to primary; alert |
| Primary read-only / failover | Writes fail with a clear error; reads continue; alert and runbook (`36`) |
| Pool exhausted | Fail fast with `503` and a retry hint; alert — **never** queue unboundedly |
| Slow query storm | Statement timeout cancels; the offending query is identified and fixed |

## 17. Capacity and Load Testing

Targets are quantified in `02` C.1 (`ADR-0007`); the method is in `37`:
load test the documented concurrency, measure each layer's signal, and identify the
first bottleneck before it identifies itself in production.

## 18. Decisions

| ID | Decision | Effect |
|---|---|---|
| D-2 | Tenancy | **Closed** (`ADR-0002`) — tenant is a mandatory key and scoping dimension |
| D-3 | Cache and queue provider | **Closed** (`ADR-0003`) — Redis cache and broker, PgBouncer pooler |
| D-7 | Quantified targets | Open — defines "fast enough" and when to scale |

## 19. Acceptance Criteria

1. The connection budget (instances × pool + workers) is documented, tested, and below
   the database's active-connection target with a reserve.
2. No cache region lacks an explicit TTL and invalidation path.
3. No permission-filtered view is cached under a shared key — verified by test.
4. Cache and queue outages degrade rather than fail requests.
5. Every list endpoint is paginated; no endpoint can return an unbounded result.
6. Every query has a statement timeout; runaway queries are cancelled and alerted.
7. Scheduled jobs run on exactly one instance under multiple backends.
8. Read-after-write never uses a replica.
9. Archival keeps the hot tables bounded; audit is never pruned before 24 months.
10. Each protection layer exposes a monitored signal with an alert.

## 20. Related

- `03-ARCHITECTURE.md` — topology, async tier, failure behaviour
- `09-DATA-INTEGRITY-AND-INDEXING.md` — the indexes queries depend on
- `10-MIGRATIONS-AND-SEEDING.md` — safe index creation on live tables
- `30-SEARCH-AND-REPORTING.md` — the read-heavy workload this protects against
- `34-OBSERVABILITY.md` · `36-OPERATIONS-AND-RECOVERY.md` · `37-TESTING.md`
