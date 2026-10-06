# 34 — Observability

**Status:** Approved · **Owner:** DevOps · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 70, 71, 72 (logging, observability, health checks)

> **Scope:** logs, metrics, traces, health checks and alerts for the running system.
> **Audit** is a separate, immutable artifact (`31`). **Monitoring the protection
> layers' signals** is described in `33` §14; this document defines the signals
> themselves and how they are collected and alerted on.

---

## 1. Purpose

Observability exists to answer two questions fast: *is the system healthy right now*,
and *what exactly happened in this specific request*. Without both, an incident is
debugged by guessing, and a fix is verified by hoping.

The design rule that makes it work: **one correlation id threads a request through
every log, metric label and trace**, so "this slow request" and "this log line" are the
same object rather than two datasets.

## 2. The Three Signals

| Signal | Answers | Cost profile | Retention |
|---|---|---|---|
| Logs | What happened, in detail, for one request | Highest volume | Short (days), then pruned |
| Metrics | How is the system behaving in aggregate | Low volume | Long (months+) |
| Traces | Where did this request spend its time | Sampled | Short |

Logs are for the specific; metrics are for the aggregate; traces connect them. Using
logs for aggregate questions is why log bills explode and dashboards stay slow.

## 3. Logging

### 3.1 Structure

- **Structured JSON** via Pino (`03` §9), one line per event, machine-parseable.
- Every line carries a `correlationId`; request-scoped lines also carry `userId`,
  `route`, and, where relevant, `entityType`/`entityId`.
- Levels: `error` (actionable failure), `warn` (degraded but handled), `info` (lifecycle
  events), `debug` (development; off in production by default).

### 3.2 Rules

| # | Rule | Reason |
|---|---|---|
| L1 | **Never log secrets, tokens, passwords, or full request bodies of sensitive endpoints** | Logs are widely readable and long-lived; a leaked token in a log is a live credential |
| L2 | PII is minimised and redacted per classification (`19`) | Logs are not covered by the same retention discipline as the database |
| L3 | Errors log the stack and the correlation id, not the user's data | Debuggability without exposure |
| L4 | Log level is controlled by configuration, not a rebuild | Incident triage needs more detail on demand |
| L5 | Log volume is bounded; high-cardinality or per-item logging in loops is prohibited | Cost and signal-to-noise |
| L6 | Client errors (4xx) are logged at `info`/`warn`, not `error` | Prevents alert fatigue from user typos |

### 3.3 Where logs go

- Local development: human-readable console.
- Deployed: stdout as structured JSON, collected by the platform's log driver
  (`35`). **The application does not write log files** — a container that writes to a
  local file is stateful and loses logs on restart (`03` §7).

### 3.4 Correlation

The correlation id is: generated at the edge if absent, propagated in a header,
included in every log line, recorded in every audit entry (`31`), and returned to the
client on errors so a user can report it. A support ticket with a correlation id is
resolvable; one without it is a guess.

## 4. Metrics

### 4.1 Categories

| Category | Examples |
|---|---|
| RED (request health) | Rate, Errors, Duration per route |
| Runtime | Event-loop lag, memory, CPU, GC |
| Database | Pool utilisation, active connections, slow queries, lock waits, replication lag, statement timeouts |
| Cache | Hit/miss ratio per region, eviction rate |
| Queue | Depth, processing rate, failures, dead letters, job duration |
| Domain | Open requests/incidents, SLA at-risk and breached, approval backlog, notification delivery rate |
| Business/security | Login failures, access denials, override rate, export count |

Domain metrics are the ones that tie system health to service health — a perfectly
healthy runtime serving a flooded incident queue is not healthy.

### 4.2 Rules

- Consistent labels: `route`, `method`, `status_class`, `job`, `region`. **No
  high-cardinality labels** (no user id, no record id) — they destroy metrics backends.
- Histograms for latency; counters for events; gauges for current state.
- Every metric named is owned by a document; there is no metric nobody can act on.

## 5. Tracing

- Distributed tracing is **sampled** (head-based, with error-biased tail sampling).
- Spans cover: HTTP request → middleware → controller → service → repository → query,
  and queue consumer → handler → external call.
- External calls (`32`) are spans, so a slow integration is visible rather than merely
  "the request was slow".
- Database spans include the query fingerprint (not the parameter values, which may be
  PII).

## 6. Health Checks

| Probe | Question | Behaviour on failure | Must not |
|---|---|---|---|
| Liveness | Is the process alive and not deadlocked? | Restart the instance | Check dependencies — a dependency outage would restart-healthy instances into a crash loop |
| Readiness | Can it serve traffic now? | Remove from the LB pool (drain) | Require the optional cache/queue to be up |
| Startup | Has initialisation completed? | Delay readiness | — |
| Deep/dependency | Are the database, cache, queue reachable? | Report status; alert | Gate liveness |

### Health endpoints

| Path | Purpose | Auth |
|---|---|---|
| `/health/live` | Liveness | Internal only |
| `/health/ready` | Readiness (checks the database with a cheap query) | Internal only |
| `/health/deps` | Dependency detail for humans/alerting | Internal only, or authenticated |

**Liveness must not depend on the database.** If it does, a brief database blip
restarts every instance simultaneously, converting a degradation into an outage — the
most common observability-induced failure.

## 7. Alerting

### 7.1 Principles

- **Alert on symptoms that affect users, not on every internal blip.** A dashboard can
  show a hundred metrics; only a handful deserve a page.
- Every alert has: an owner, a threshold justified by data, a runbook link (`36`), and
  a defined response. An alert without a runbook is noise.
- Alerts are actionable; if the documented action is "wait", it is a dashboard, not an
  alert.
- Alert on **rate and duration**, not just absolute state, to avoid flapping.

### 7.2 Core alerts

| Alert | Condition | Severity |
|---|---|---|
| Error rate high | 5xx ratio above threshold over a window | Page |
| Latency SLO burn | p95/p99 above target (`02`, D-7) sustained | Page |
| Readiness failing across instances | Majority unready | Page |
| Database connection pool saturated | Utilisation above threshold | Page |
| Replication lag high | Above threshold | Warn → Page |
| Queue depth / dead letters growing | Sustained growth | Warn → Page |
| SLA sweep stalled | Last successful run older than interval | Page (silent SLA failure, `25` §6) |
| Login failure / denial spike | Above baseline | Page (security, `17`) |
| Backups stale | Last success older than window | Page (`36`) |
| Disk near full | Above threshold | Warn → Page |

### 7.3 Escalation and noise

- Alerts route by ownership (backend, database, infrastructure) so they reach someone
  who can act.
- Suppression during deploys is explicit and time-boxed; a deploy that hides errors
  hides the deploy that broke it.
- Post-incident, every alert that fired without a useful action is either fixed or
  deleted. Alert fatigue is treated as a defect, not a cultural problem.

## 8. Dashboards

| Dashboard | Audience |
|---|---|
| Service overview | On-call: RED metrics, health, error budget |
| Database | DBA: connections, slow queries, locks, lag, bloat |
| Queue/workers | On-call: depth, failures, dead letters, job latency |
| Domain/operations | Ops lead: SLA, incident load, approval backlog |
| Security | Security: auth failures, denials, overrides, exports |

Each panel names the metric's owning document so a misleading panel is fixed in one
place.

## 9. Support and Debugging Workflow

```
User reports a problem
    ↓  correlation id from the error response
Search logs by correlationId
    ↓
Reconstruct the request: route, user, timings, errors
    ↓
Follow to the audit entry for the mutation (31)
    ↓
Trace shows the slow span or failure point
    ↓
Metric shows whether it is isolated or systemic
```

This is the workflow the whole document exists to enable.

## 10. Open Decisions

| ID | Decision | Effect |
|---|---|---|
| D-5 | Orchestrator | **Closed** (`ADR-0005`, Kubernetes) — health-probe mechanics and log collection follow the platform |
| D-7 | Quantified targets | Alert thresholds for latency/error burn |

## 11. Acceptance Criteria

1. Every error response carries a correlation id resolvable in logs.
2. No secret or token appears in any log line — verified by a scan.
3. Liveness does not check the database; a database outage does not restart instances.
4. Readiness failing removes an instance from rotation without a restart.
5. Every page-level alert has a runbook link and an owner.
6. Metrics avoid high-cardinality labels; no user or record id appears as a label.
7. A stalled SLA sweep alarms; a silent SLA failure is not possible (`25`).
8. Logs are emitted to stdout as structured JSON; the app writes no local files.

## 12. Related

- `31-AUDIT-LOGGING.md` — the immutable record alongside operational logs
- `33-SCALABILITY-AND-DATABASE-PROTECTION.md` — the signals the layers expose
- `35-DEPLOYMENT-AND-CI-CD.md` — probes, log collection, environment
- `36-OPERATIONS-AND-RECOVERY.md` — runbooks the alerts link to
- `17-SECURITY-ARCHITECTURE.md` — security-relevant signals
