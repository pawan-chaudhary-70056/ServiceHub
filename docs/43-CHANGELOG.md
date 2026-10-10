# 43 — Changelog

**Status:** Approved · **Owner:** Tech Lead · **Reviewer:** — · **Approved:** 2026-10-01
**Consolidates:** old 105

> **Scope:** the append-only record of changes to the documentation set and, once code
> exists, to the product. **The process that produces entries** is `42` (ADRs and
> Change Requests). **Generated release notes for published versions** follow the same
> entries; they are not a second source of truth.

---

## 1. Purpose and Rules

A changelog is only useful if it is **honest, ordered, and linked**. Three rules:

| # | Rule |
|---|---|
| L1 | Entries are append-only; a correction is a new entry, never an edit of an old one |
| L2 | Every entry names the documents and/or modules affected and links to the ADR/CR that justified it |
| L3 | Dates are real; entries are added as changes happen, not reconstructed at the end |

**L3 is the rule that is always broken.** A changelog written retrospectively is a
narrative, not a record — it omits the reversals, which are the most instructive part.

## 2. Entry Format

```
## <YYYY-MM-DD> — <one-line summary>
Type:     Docs | Feature | Fix | Security | Performance | Breaking | Process
Refs:     CR-NNNN / ADR-NNNN / issue
Affects:  documents and modules
Notes:    what changed and, where non-obvious, why. Include a **Supersedes** line when
          an earlier statement is replaced rather than removed.
```

## 3. Documentation Changelog

### 2026-10-11 — Operator password recovery: a guarded, audited reset command
- **Type:** Feature / Process
- **Refs:** `10` §8, `06` §4/§6/§7, `31` §3.1, `33` C3, `17`, `43`
- **Affects:** `docs/10` §8, `43`; backend `prisma/reset-operator-password.ts` (new),
  `package.json` (`operator:reset-password`), `.env.example`
- **Notes:**
  - **The gap this closes is a real one and was found in use, not in review.** The bootstrap
    is deliberately guarded — once a platform operator exists it refuses, because a second
    operator is a deliberate act. That left **no supported way to recover the first
    operator's password**: the only stored form is an Argon2id hash, and the plaintext was
    supplied once via `BOOTSTRAP_OPERATOR_PASSWORD`. The alternative was an ad-hoc console
    edit under time pressure, which is how a superadmin credential ends up shared in a chat.
  - **Same discipline as the bootstrap.** No default or invented password
    (`OPERATOR_NEW_PASSWORD` is required); it refuses an ambiguous target rather than picking
    one (more than one operator with no `OPERATOR_EMAIL`); it validates against the
    application's **own** policy and hashing helpers, so the reset cannot drift from what
    login accepts or from the configured Argon2id parameters; it **revokes every live
    session** (`06` §7 — a reset that leaves an attacker's session alive has not reset
    anything); and it writes a `password.reset` audit row with actor type `SYSTEM` in the
    same transaction as the change (`31` §3.1), carrying `via: operator-reset-command` so a
    security review can tell an operator-driven change from a self-service one.
  - **It never prints the password.** Whoever supplied it already has it, and a tool that
    echoes a credential is a tool that writes one into a shell history.
  - **Verified end to end, not just typechecked.** The guards were exercised (missing
    password, unknown email, policy failure — all refused with exit code 1 and a specific
    message), then a generated policy-satisfying password was applied and the login flow was
    driven against a running server: `POST /api/v1/auth/login` returned `200` with the
    session and CSRF cookies and the platform permission set, while a wrong password returned
    `401` — which is what proves the credential actually changed. The audit row and the
    updated `passwordChangedAt` were read back from the database.
  - **Operational note.** This is a credential surface: `OPERATOR_NEW_PASSWORD` must be
    supplied through the environment (or a secret manager, `17`) and never committed, and the
    command is intended to be run by someone entitled to it, with the audit row as the record.

### 2026-10-11 — Phase 3 increment 29: Report and audit exports move to object storage (`CR-0003` superseded)
- **Type:** Feature / Breaking (internal) / Docs
- **Refs:** `ADR-0004`, `19` §7.1/§7.3/§7.4, `30` §3.1/§5, `31` §10, `33` §11, `42` §4.5/§6, `40` §12, `43`
- **Affects:** `docs/42` §4.5/§6, `40` §12, `43`; backend `prisma/schema.prisma`
  (`ReportExport`), migration `20261010194724_report_export_object_storage`,
  `models/report-export.model.ts`, `services/report-export.service.ts`,
  `services/audit-export.service.ts`, `controllers/search.controller.ts`,
  `controllers/audit.controller.ts`, `services/index.ts`; tests
  `tests/report-export.integration.test.ts`
- **Notes:**
  - **`CR-0003`'s interim is over.** Report exports stored the rendered CSV inline in a
    `report_exports.content` column, accepted by the Tech Lead on 2026-10-07 as a Phase 2
    deviation from `ADR-0004` that was to be resolved "with the S3 adapter in Phase 3". The
    adapter landed (attachments), so this is that migration: the worker renders the CSV, writes
    it through the storage adapter and persists **only the key**. The column is dropped in
    migration `20261010194724_report_export_object_storage`.
  - **Two consequences that were the point of the deviation's expiry.** An export produced by
    one instance is downloadable from another, and a database dump is no longer a bulk data
    export — which is exactly the property `ADR-0004` exists to give.
  - **Downloads follow `19` §7.3, shared with attachments.** `s3` issues a short-lived signed
    URL and the API **redirects** (no bytes through the backend); `local` streams the file.
    Report and audit exports go through one function (`openStoredExport`), so the two cannot
    drift into serving differently — a difference an operator would only find in a ticket.
  - **Authorize, then read.** Ownership, readiness and expiry are checked before any storage
    access, so a guessed id or an expired link causes no object-store fetch at all. Expiry
    deliberately does not delete the object: retention is a maintenance job (`19` §7.4), and a
    purge must not be a side effect of one download attempt.
  - **`CR-0003` is recorded `Superseded`**, not edited away: the register (`42` §6) and §4.5 both
    carry a dated resolution line, and the original text is left intact (`43` L1).
  - **Verified.** The integration suite drives a real export through the worker and then asserts
    the row carries a storage key matching the key pattern and that the object is readable
    through the configured driver, in addition to the existing download assertions.

### 2026-10-11 — Phase 3 increment 28: The worker as its own process tier
- **Type:** Feature / Process
- **Refs:** `03` §3/§6/§7 (J5), `34` §4/§6, `35` §3/§6, `33` §1, `40` §12, `43`
- **Affects:** `docs/40` §12, `43`; backend `src/worker.ts` (new), `src/server.ts`,
  `src/config/env.ts`, `src/config/index.ts`, `src/jobs/index.ts`, `package.json`,
  `Dockerfile`; tests `tests/process-role.test.ts`
- **Notes:**
  - **The schedulers now have their own workload.** Every worker previously ran in-process in
    the API, so the API tier owned the queue by accident. `PROCESS_ROLE` makes the tier
    explicit — `all` (HTTP **and** schedulers, the honest single-process developer default),
    `api` (HTTP only) and `worker` (schedulers only, **no HTTP listener**, because `docs/03` §3
    says a worker must not serve HTTP). This is the "separate worker process / queue consumer"
    item the changelog has carried since increment 3.
  - **The wrong tier is refused, not started.** Each entrypoint exits with a fatal log when
    asked for the other tier's work, so a misconfigured deployment fails at boot instead of
    double-scheduling: `N` API instances each taking the per-tick lock is the defect `docs/03`
    J5 names, and the lock hides it until the lock has a bad day. Verified by running both
    entrypoints with the opposite role — both exit `1` with the refusal logged.
  - **Scaling is now independent of the API.** API instances scale with request load and the
    worker with queue depth (`docs/33` §1, "scale by measurement"), a stuck job cannot occupy
    an API process, and deploying the API no longer restarts the workers mid-job. The
    leadership model is unchanged: each scheduler still takes its short-lived Redis lock per
    tick, so `N` worker replicas are safe and exactly one sweeper runs per tick.
  - **The image has a worker target.** `backend/Dockerfile` gains a `worker` stage from the
    production stage with `HEALTHCHECK NONE` — the inherited probe checks `/health/live`, and a
    worker serves no HTTP by design, so an inherited probe would report a healthy worker as dead
    forever.
  - **Verified, not asserted.** `npm run build` then `PROCESS_ROLE=worker node dist/worker.js`
    starts and logs the worker banner; `PROCESS_ROLE=worker node dist/server.js` and
    `PROCESS_ROLE=api node dist/worker.js` both refuse with exit code 1. `tests/process-role.test.ts`
    pins the role predicates and the rejection of an unknown role.

### 2026-10-11 — Phase 3 increment 27: Worker liveness for every job, and the alerting/dashboard layer
- **Type:** Feature / Docs / Process
- **Refs:** `34` §4/§7/§8/§11, `25` §6, `32` §8, `35` §6, `40` §12, `43`
- **Affects:** `docs/40` §12, `43`; backend `services/webhook-scheduler.ts`,
  `services/notification-scheduler.ts`, `services/report-export-scheduler.ts`,
  `services/inbound-webhook-scheduler.ts`, `services/roster-sync-scheduler.ts`; new
  `ops/observability/{README.md,prometheus/prometheus.yml,prometheus/alerts.yml,grafana/dashboards/servicehub-overview.json}`;
  `docker-compose.yml`; tests `tests/observability-assets.test.ts`
- **Notes:**
  - **Only the SLA sweep reported its runs, so five of six workers were invisible.** `34` §7.2
    pages on "SLA sweep stalled" *and* "queue depth / dead letters growing", but
    `recordJobRun` was called from exactly one scheduler — so "has the notification drain
    succeeded recently?" could not be asked, and a stalled drain looked identical to an idle
    one. Every scheduler now records its run: `notification_drain`, `report_export`,
    `webhook_delivery`, `inbound_webhook` and `roster_sync`, alongside the existing
    `sla_sweep`. The signal was already in `34`; this makes it emitted.
  - **The alert rules are a deployment artifact with the same rigour as code.**
    `ops/observability/prometheus/alerts.yml` implements the `34` §7.2 core-alert table —
    availability, error ratio, latency SLO burn, worker stalls, failing jobs, open integration
    circuits, bulkhead saturation, memory and restart loops. Each rule names an **owner**, a
    **severity**, the **threshold and where it came from**, and a **`runbook_url`** into `36`,
    because §7.1 says an alert without a runbook is noise. Rate-based conditions are expressed
    on rates, not absolute state, so a single blip cannot flap a page (§7.1).
  - **A drift guard, because these references are strings.** Nothing in TypeScript checked the
    metric names written in the rules and the dashboard, so a rename in the registry would
    have broken alerting quietly. `tests/observability-assets.test.ts` asserts that every
    `servicehub_*` metric named in `ops/observability` is a family the registry actually
    exposes, that every alert carries owner/severity/runbook/an expression, and that every
    dashboard panel has a query.
  - **Local parity.** A `prometheus` service is wired into `docker-compose.yml` reading the
    same rule file, so the alerts can be evaluated against the real metrics without a
    deployment.
  - **Stated limits.** The rules have not been evaluated against a running Prometheus in this
    repository (`promtool check rules` needs Prometheus, which is not installed here); the YAML
    and JSON are syntax-validated locally and structurally by the test above. No Grafana
    container is wired, and no tracing exporter exists (`34` §5) — the correlation id already
    threads a request through logs and audit, and a collector is the remaining step.

### 2026-10-11 — Phase 3 increment 26: The integration reliability patterns and the `admin:config` configuration surface
- **Type:** Feature / Docs
- **Refs:** `32` §2/§7/§8/§11/§12/§13, `34` §4, `17` §3, `35` §6, `11` §9, `12`, `19` §3, `31`, `37`
- **Affects:** `docs/11` §9, `40` §12, `43`; backend `integrations/resilience.ts`,
  `integrations/index.ts` (unchanged), `services/webhook.service.ts`,
  `services/notification.service.ts`, `services/integration-config.service.ts`,
  `services/metrics.service.ts`, `services/audit-events.ts`, `controllers/integration-config.controller.ts`,
  `routes/webhook.routes.ts`, `models/integration-setting.model.ts`, `models/index.ts`,
  `validators/integration-config.validators.ts`, `config/env.ts`, `prisma/schema.prisma`;
  frontend `api/integrations.api.ts`, `pages/integrations.page.tsx`; tests
  `tests/resilience.test.ts`, `tests/integration-config.integration.test.ts`,
  `tests/setup.ts`, `frontend/src/pages/integrations.page.test.tsx`
- **Notes:**
  - **The two missing `32` §8 patterns now exist and are applied.** §8 lists timeout, retry,
    circuit breaker, bulkhead, dead letter and backpressure; timeout, bounded retry and dead
    letter were already in place per adapter, and **circuit breaker and bulkhead were not**.
    `integrations/resilience.ts` adds both as one reliability layer, keyed **per named
    integration** — the isolation boundary — so `email` and `webhook:<subscriptionId>` share
    neither a breaker nor a bulkhead. An open breaker fails fast instead of paying a timeout
    per attempt, and a bounded bulkhead (with a bounded wait queue) stops one slow remote from
    consuming the capacity of another (§8 bulkhead, §9 "no single integration failure").
  - **Wrapped where the external call is, not around it.** `deliverPendingWebhooks` now sends
    each delivery through `runResilient('webhook:<subscriptionId>', …)` and the notification
    drain sends through `runResilient('email', …)`. Both convert a rejection into the
    **same negative result** their adapter returns, so a fast-fail is retried and eventually
    dead-lettered exactly like a transport failure — no new path, no throw onto the request
    path. The registry is process-global by design: the memory of recent failures *is* the
    pattern.
  - **An explicit dead-letter retry clears the breaker.** An operator requeueing a delivery is
    asserting the subscriber has been fixed, so `retryDeadLetterForCaller` resets that
    subscription's circuit. Without it the automatic fast-fail would reject the human's action
    for the rest of the cooldown; the breaker exists to stop *automatic* retries, not to
    overrule an operator.
  - **The configuration surface the document names now exists** (`32` §11 "Configure
    integrations — `admin:config` (audited)", §12 `POST/PATCH /admin/integrations/{id}`).
    `GET/PATCH /admin/integrations/config[/{key}]` plus `POST …/{key}/test` serve a catalogue
    (`email`, `directory`, `webhooks`, `inbound_webhooks`) with the effective reliability
    tuning, an enabled flag, a connectivity test and a **credential reference**. The reference
    is the point: credentials are runtime-injected and never persisted (`17` §3, `35`), so the
    field accepts `env:NAME` and **rejects a value** with `422` — a request cannot smuggle a
    secret into a field whose purpose is to hold none. Every change is audited with a
    before/after that carries the reference and never the secret.
  - **Configuration is validated per key**, against the catalogue rather than a free-form blob,
    and the same catalogue drives the admin UI so the screen cannot drift from the backend.
  - **Metrics.** Three gauges join `34` §4: `servicehub_integration_circuit_state`
    (0 closed / 1 half-open / 2 open), `…_bulkhead_in_flight` and `…_bulkhead_queued`, per
    integration — the fastest way to see "the remote is down" and whether an integration is
    starting to back up before its queue dead-letters.
  - **Test isolation was a real defect this exposed.** A test that deliberately drives a
    provider to failure left an open circuit for every later test in the file, because the
    registry is process-global. `tests/setup.ts` now clears it between tests (dynamically
    imported, so setup still does not import application config before the environment
    defaults are set). Two pre-existing suite failures were caused by exactly this leak and are
    fixed at the cause, not by relaxing an assertion.
  - **M4's remaining gap narrows to the object-storage decision and the async antivirus
    hook.** Circuit-breaker/bulkhead tuning and credential/configuration administration were
    the two named blockers; both are delivered here. What is still open for M4 is the
    time-based report metrics and cached aggregates, the N8 provider webhooks, per-identity
    rate-limit keying, the separate worker process, the observability stack (`34`) and every
    Phase 4 hardening criterion.

### 2026-10-09 — Phase 3 increment 25: Notification depth, team administration UI, and two more report metrics
- **Type:** Feature / Fix / Docs
- **Refs:** `29` §4/§5/§8, `26` A7, `23` §8, `24` §3, `30` §3.3, `07` §6, `11` §9, `16`, `37`
- **Affects:** `docs/11` §9, `40` §12, `43`; backend `services/notification-templates.ts`,
  `services/notification-events.ts`, `services/notification.service.ts`,
  `services/approval.service.ts`, `services/incident.service.ts`, `models/user.model.ts`,
  `models/report.model.ts`, `services/report.service.ts`; frontend `api/teams.api.ts`,
  `pages/teams.page.tsx`, `pages/reports.page.tsx`, `routes/index.tsx`,
  `components/app-shell.tsx`; tests `tests/notification-templates.test.ts`,
  `tests/notifications.integration.test.ts`, `tests/search.integration.test.ts`,
  `frontend/src/pages/teams.page.test.tsx`, `frontend/src/pages/reports.page.test.tsx`
- **Notes:**
  - **Notification depth (`29` §5, F-12).** Two templates existed — invitation and password
    reset — so **no operational event could send an email at all**: a payload named people by
    id, and the worker only knew how to read an address. Ten domain templates now exist
    (request/incident/task assignment, task raised, approval requested/advanced/reassigned,
    approval approved/rejected, incident resolved) and the worker resolves a payload's
    **user ids** to addresses at send time (`resolveEmailRecipients`). Resolving late is the
    point: a queued event goes to the mailbox the person has *now*, the payload holds no
    personal data at rest (`19` §3), and the same declaration serves the in-app channel.
  - **One event, several recipients, still exactly once.** An approval step addresses a list
    of approvers, so the email path became a loop over recipients, each under its own
    `(eventId, recipient, channel)` dedupe key (`29` N3/N4). The outbox row is released only
    when **every** recipient is terminal; a recipient awaiting a retry keeps the row
    undrained, and those already `SENT` are skipped rather than mailed twice. `result.delivered`
    now counts messages, not events.
  - **A latent crash, found by the new tests.** In-app delivery trusted the payload: an id that
    no longer resolved to a user violated `notifications_user_id_fkey` and **threw out of the
    drain**, breaking the "never throws" invariant of `29` §3. Both channels now narrow
    declared ids with `findNotifiableUserIds` — the user must exist **and** belong to the
    event's tenant (`ADR-0002`), so a stale id is skipped with a warning and a foreign id can
    never surface another tenant's work in someone's in-app centre. The test that caught it
    (an approver who has left the tenant) is kept as the regression case.
  - **Payloads enriched where the recipient was simply missing (`29` §5).** The reassignment
    payload carried no request id, so its in-app notification had **no link to follow**; it now
    carries `requestId` and `reference`. Approval outcome events now name the `requesterId`
    (`26` A7: the decision moves the request on its own, so the requester is told), and the
    incident-resolution event names the `reporterId` (`23` §8). Both now also produce an in-app
    entry, which is the gap `#3` of `tochange.md` §7 named.
  - **Team administration UI (`07` §6).** The membership write surface landed in increment 24
    with no way to reach it: a team could be created by an API call and by a test fixture, and
    membership could not be managed at all. `/teams` (guarded by `user:manage`, in the primary
    navigation beside Users) lists teams, creates one, shows a team's members with their role,
    adds or re-roles a member and removes one. The picker offers **active tenant users only**,
    because the server refuses anyone else and a picker that offers a refusal is a trap.
  - **Two more metrics (`30` §3.3).** `tasks.workload` (owner `24`) reports open load by
    status, the overdue subset and completions in the period; `overdue` is a **snapshot at
    generation time**, because "how much work is late right now" is what an overdue count
    answers, while `completedInWindow` is the genuine period measure. `notifications.delivery`
    (owner `29`) reports outcomes by status with delivery and failure rates, and is
    **cross-team only** — a row is one person's delivery attempt, so a narrower scope would be
    a report of other people's mail metadata. A `SKIPPED` row is a recipient preference
    (`29` §7), never a failure, and is excluded from the failure rate.
  - **Verification (all run after the last change to each artifact, `pipefail` preserved).**
    Backend `format:check`, `eslint`, `tsc --noEmit`, `tsc -p tsconfig.build.json` clean;
    **336 tests / 36 files** pass (was 326). Frontend `format:check`, `eslint`, `tsc --noEmit`
    clean, `vite build` succeeds, **79 tests / 24 files** pass (was 72). Both CI secret-scan
    passes return no match over the working tree. No check was skipped and no assertion
    weakened; `tsc` caught a real mistake during the work — the completed task status is
    `DONE`, not `COMPLETED`.
  - **Still not implemented, and named so the next increment does not have to rediscover it.**
    The time-based metrics (`30` §3.3: mean/median time to resolve, MTTR, approval turnaround)
    need a duration percentile the query layer does not express yet; the KB (`27` §6) and asset
    (`28`) metrics, materialised aggregates with a short-TTL cache (`30` §3.4), the N8 provider
    webhooks (bounce/complaint/delivery feedback), per-identity rate-limit keying, a separate
    worker process, the observability stack (`34`), the browser E2E journeys (`37` §7) and the
    Phase 4 hardening items are all still open (`40` §12).

### 2026-10-09 — Fix: the secret-scan gate was failing on its own test fixtures
- **Type:** Fix / Security
- **Refs:** `20` §3 ("Secrets scan: any match, without exception"), `37` §2 (fixtures), `38`
- **Affects:** `.github/workflows/ci.yml` (secret-scan job), `backend/tests/storage-s3.test.ts`,
  `40` §12, `43`
- **Notes:**
  - **A gate that cannot pass is not a gate.** The single-pattern scan matched 13 tracked test
    files, because `const OPERATOR_PASSWORD = 'Operator-Passphrase!23'` is a secret-shaped name
    assigned 19 characters — exactly what the pattern looks for. Verified against the command
    CI runs (`git grep` over tracked files): it exits `0` on `main`, so the job fails on every
    push and the real signal is buried under fixture noise.
  - **The fix is not an exclusion, it is two passes with different jobs.** Pass 1 keeps the
    broad "secret-shaped name" pattern for source and configuration and excludes test files,
    reason stated in the workflow. Pass 2 restores coverage where it matters most — a live
    credential pasted into a fixture — by matching **provider credential shapes** (private-key
    blocks, AWS `AKIA…`, Stripe/`whsec_`/SendGrid prefixes) across **every** file, tests
    included. Neither pass is weaker than the check it replaces for the risk it names.
  - **The new pass caught this session's own fixture.** `backend/tests/storage-s3.test.ts` used
    a fake access key id shaped like a real AWS one; it now uses a deliberately unshaped value,
    with the reason recorded at the fixture, so the next person does not reintroduce it.
  - **Verification.** Both passes were run over the whole working tree (not just tracked files)
    and return no match; the three workflow files still parse and expose the same jobs; the
    changed test files pass (`20` tests across the storage and attachment suites).
  - **Supersedes.** The `secret-scan` step as written in `ci.yml` before this entry; `20` §3's
    rule is unchanged — any match still fails the build, without exception.

### 2026-10-09 — Phase 3 increment 24: Security headers, session self-service, team administration, metrics and the security-scan pipeline
- **Type:** Security / Feature / Docs
- **Refs:** `17` §5, `06` §7, `07` §3/§6, `34` §4/§6/§7, `20` §2/§3, `19` §1, `11` §9, `38` §3
- **Affects:** `docs/11` §9, `40` §7/§12, `43`; backend `src/app.ts`,
  `src/services/metrics.service.ts`, `src/middlewares/metrics.ts`,
  `src/controllers/health.controller.ts`, `src/routes/health.routes.ts`,
  `src/services/sla-sweep-scheduler.ts`, `src/services/auth.service.ts`,
  `src/controllers/auth.controller.ts`, `src/routes/auth.routes.ts`,
  `src/models/session.model.ts`, `src/services/teams.service.ts`,
  `src/controllers/teams.controller.ts`, `src/routes/teams.routes.ts`,
  `src/validators/team.validators.ts`, `src/models/team.model.ts`,
  `src/services/audit-events.ts`, `src/services/index.ts`; frontend `nginx.conf`,
  `index.html`, `public/favicon.svg`, `public/.well-known/security.txt`,
  `api/auth.api.ts`, `pages/security.page.tsx`, `routes/index.tsx`,
  `components/app-shell.tsx`; CI
  `.github/workflows/codeql.yml`, `.github/workflows/dast.yml`, `.github/workflows/ci.yml`,
  `.zap/rules.tsv`; tests `tests/metrics.test.ts`,
  `tests/sessions-and-teams.integration.test.ts`, `tests/health.test.ts`
- **Notes:**
  - **Security headers are pinned, not defaulted (`17` §5).** `helmet()` was replaced with an
    explicit policy — `default-src 'self'`, no `unsafe-inline` for scripts, `frame-ancestors
    'none'`, HSTS for a year — and `frontend/nginx.conf` now sends **CSP and HSTS** (they were
    absent). nginx inherits `add_header` destructively inside a `location`, so each location
    that sets a cache header repeats the security set rather than silently dropping it. A test
    asserts the directives, so a dependency bump cannot relax them unnoticed.
  - **Session self-service (`06` §7).** `GET /auth/sessions` and `DELETE /auth/sessions/{id}`:
    the query is keyed on the authenticated user, so there is no id to substitute; another
    user's session is `404`; revocation is durable (the row is kept) and audited as
    `session.revoke` with the cache entry dropped afterwards. The **account security page**
    (`/account/security`) is the surface — a session list that labels the current device and
    offers a one-click revocation, because a control a user cannot reach is a control in name
    only.
  - **Team administration (`07` §3/§6).** Teams were read-only, so a team could only be
    created by a test fixture. `POST /teams` and the membership write surface (`GET`/`POST`
    `/teams/{id}/members`, `DELETE /teams/{id}/members/{userId}`) now take `user:manage`,
    not `catalog:read` — membership decides which records a team-scoped grant resolves to,
    so it is user administration. A member must be an **active user of the same tenant**
    (`422` otherwise), and creation/removal are both audited.
  - **Metrics (`34` §4).** A dependency-free Prometheus registry exposes RED metrics
    labelled by **route pattern** (a concrete path or record id never becomes a label —
    cardinality *and* a data-protection concern), a latency histogram, process gauges, and
    `job_last_success/failure_timestamp_seconds`. The SLA sweep records its runs, because
    "sweep stalled" is a page-level alert (`34` §7) and a silent SLA failure must be
    impossible (`25` §6). `GET /health/metrics` answers from memory: scraping adds no
    database load.
  - **Security scans wired (`20` §2/§3).** CodeQL SAST on every PR (`security-extended`),
    a Trivy IaC/container scan on every build, and a nightly OWASP ZAP baseline against
    the configured staging target with the accepted-rule list in `.zap/rules.tsv`. These
    are **pipelines, not evidence**: none has run in a real environment yet, which is why
    Gate 2 is still not claimed (see `40` §12).
  - **Coverage.** `tests/metrics.test.ts` (7) pins the label rules, buckets and the scrape
    endpoint; `tests/sessions-and-teams.integration.test.ts` (8) covers ownership, the
    cross-tenant team `404`, the `user:manage` guard and both audit events;
    `tests/health.test.ts` gains the header assertions.

### 2026-10-09 — Phase 3 increment 23: File attachments (`19` §7, F-16)
- **Type:** Feature / Docs
- **Refs:** `19` §7/§8, `ADR-0004`, `07` §4, `08` §3, `09` Q11, `FR-FILE-001`, `11` §9,
  `12`, `16`, `22` R10, `28`
- **Affects:** `docs/11` §9, `40` §7, `43`; backend `prisma/schema.prisma` (migration
  `20261009084814_add_attachments`), `models/attachment.model.ts`, `models/index.ts`,
  `helpers/multipart.ts`, `helpers/file-sniff.ts`, `integrations/storage.ts`,
  `services/attachment.service.ts`, `controllers/attachment.controller.ts`,
  `routes/attachment.routes.ts`, `routes/index.ts`, `validators/attachment.validators.ts`,
  `services/index.ts`, `services/audit-events.ts`, `config/env.ts`; frontend
  `api/client.ts` (`apiUpload`), `api/attachments.api.ts`, `components/attachment-panel.tsx`,
  `pages/request-detail.page.tsx`, `pages/incident-detail.page.tsx`, `pages/article.page.tsx`;
  tests `tests/attachments.integration.test.ts`, `tests/file-upload.test.ts`,
  `tests/storage-s3.test.ts`, `tests/storage-local.test.ts`,
  `components/attachment-panel.test.tsx`; `backend/.gitignore`, `backend/tests/setup.ts`
- **Notes:**
  - **F-16 was the only feature in `05` with no code.** The `Attachment` entity is the shared
    child-table design of `08` §3 — keyed on `(entityType, entityId)` with `organizationId` in
    the same predicate (index Q11) — and hangs off requests, incidents and articles
    (`FR-FILE-001`).
  - **Bytes live in object storage (`ADR-0004`), not on a backend.** `integrations/storage.ts`
    defines the domain-owned `FileStorage` boundary with an **S3-compatible driver** (SigV4
    presigned GET for serving, header-signed PUT for storing — no vendor SDK) and a **local
    driver** for development and tests. `env.ts` **refuses to boot in production** with the
    local driver, because instance-local files are exactly the failure `19` §7.1 describes.
  - **The upload path is separate from the 1 MB JSON parser (`19` §7.2 rule 4).** A bounded
    multipart reader enforces the cap **while reading**, so a lying `Content-Length` is cut off
    mid-stream rather than buffered; extent, count and type are then checked before any write.
  - **The scan step is synchronous sniffing, and the status gate is the control.** A payload
    that sniffs as HTML, script, SVG or an executable — or whose bytes disagree with its
    declared type — is rejected `422 FILE_REJECTED`, retained as a `QUARANTINED` row and
    audited; the stored content type is the **sniffed** one. Nothing is retrievable until the
    row is `AVAILABLE`, and a `PENDING`/`QUARANTINED` row is a `404` on every path — listing
    included. An asynchronous antivirus hook is the remaining gap (recorded, not hidden).
  - **Attachments are never more visible than their parent (`07` §4).** There is no
    attachment permission: list, upload and download all resolve the parent through the owning
    service's own object-level check, an invisible parent is `404`, and authorization is
    re-checked on **every** download so a revoked session or a lost record access stops the
    bytes. Downloads are audited (`attachment.download`), because an attachment is classified
    Confidential (`19` §1).
  - **Serving follows `19` §7.3.** Non-images are `application/octet-stream` with an
    `attachment` disposition (never renderable in a tab), images inline with their real type,
    always `nosniff`, `Cache-Control: private, no-store` and a restrictive CSP; the S3 driver
    redirects to a signed, short-lived URL instead of proxying bytes.
  - **Caps:** 10 MB per file, 25 MB per request, 20 per record (all configurable
    `FILE_*` values), with the per-record count checked **inside** the write transaction.
  - **UI.** `AttachmentPanel` on request, incident and article detail: lists what the server
    called available with size, uploader and a download link; uploads with the same cap stated
    as a cause and a remedy (`16`); and hides the form where the caller has no authoring grant.
  - **Coverage.** `tests/attachments.integration.test.ts` (11) walks §8's own list — unscanned
    not retrievable, quarantined never served, spoof rejected by sniffing, cross-parent `404`,
    revoked session refused, cap enforced, downloads audited, CSRF required, oversized `413`;
    `tests/file-upload.test.ts` (14) pins the parser, the streaming cap and the allow-list;
    `tests/storage-s3.test.ts` (5) and `tests/storage-local.test.ts` (4) cover both drivers —
    the S3 signing path had none, and the test found a real inconsistency: the local driver
    validated storage keys while the S3 driver did not, so a malformed key would have been
    signed and sent. Both now refuse it before a request is built. The S3 suite also exposed
    the honest limit that the driver has never run against a live bucket;
    `components/attachment-panel.test.tsx` (4) covers the panel.

### 2026-10-08 — Phase 3 increment 22: Inbound user-roster sync (`32` §6)
- **Type:** Feature / Docs
- **Refs:** `32` §6/§7/§11/§12/§14, `06` (identity), `07` §5, `11` §9
- **Affects:** `docs/11` §9, `40` §7/§12, `43`; backend `prisma/schema.prisma` (migration
  `20261008052517_add_roster_sync`), `integrations/index.ts`,
  `integrations/directory.ts`, `models/roster.model.ts`, `models/organization.model.ts`,
  `services/roster-sync.service.ts`, `services/roster-sync-scheduler.ts`,
  `controllers/roster-sync.controller.ts`, `validators/roster-sync.validators.ts`,
  `routes/webhook.routes.ts`, `services/index.ts`, `models/index.ts`, `server.ts`,
  `config/env.ts`, `services/audit-events.ts`; tests
  `tests/roster-sync.integration.test.ts`, `tests/webhooks.integration.test.ts`
- **Notes:**
  - **Identity is keyed on the source's immutable `externalId`, never on email (`§6`).** The
    `DirectoryUserMapping` table is the anchor; email is used **once**, to adopt an existing
    local account on first contact, and never afterwards. Adoption is also refused when the
    matching email belongs to another tenant, so a directory cannot reach across tenants.
  - **Deactivate, never delete (`§6`).** A person missing from the roster, or marked inactive,
    is set `INACTIVE`; the user row, its history and its mapping all survive. This is the rule
    that makes a directory outage survivable.
  - **The drift guard aborts rather than "corrects" (`§6`/`§14`).** A run that would
    deactivate more than `ROSTER_SYNC_MAX_REMOVAL_FRACTION` (default 20%) of known people
    stops, records `ABORTED` with the reason and alerts — and applies **nothing**, because the
    guard runs before any write. An operator who intends the removal passes `confirmDrift`,
    and the audit records that they did.
  - **An unreachable directory is not an empty roster.** The adapter is fetched *before* the
    reconciliation loop; a failure records `FAILED` and never reaches the deactivation path.
  - **Idempotent and resumable (`§6`).** A repeat run changes nothing; the state carries a
    checkpoint written per batch, so a long run resumes instead of restarting.
  - **Source of truth per attribute (`§6`).** The roster owns `displayName` only. It does not
    overwrite email, roles or team membership, and it **never reactivates** a locally
    deactivated account — a decision the directory does not know about.
  - **Scheduled, single-leader (`§6`).** `startRosterSyncScheduler` sweeps every tenant under a
    Redis lock and is a **no-op when no directory is configured**, so an environment without
    one does not log a failure on every interval. `GET`/`POST /admin/integrations/roster-sync`
    expose status and an audited manual run.
  - **Adapter boundary (`§3`).** The domain owns `DirectoryAdapter`; the vendor lives only in
    `integrations/directory.ts`, and the unconfigured adapter **fails** rather than reporting
    an empty roster.
  - **Coverage.** `tests/roster-sync.integration.test.ts` (8) covers create/mapping on first
    run, idempotency, the owned-attribute update, deactivation, the drift abort and its
    confirmation, no-resurrection, and tenant-safe adoption; `tests/webhooks.integration.test.ts`
    (now 10) covers the status and trigger endpoints and their guards.
  - **Remaining (`32`):** circuit-breaker/bulkhead tuning and credential/configuration
    administration. M4 stays **partially** met (`40` §7), though inbound sync was its main gap.

### 2026-10-08 — Phase 3 increment 21: The integration health board (`32` §12/§13)
- **Type:** Feature / Docs
- **Refs:** `32` §12/§13, `11` §9, `09` (indexing), `33` §7
- **Affects:** `docs/11` §9, `40` §7/§12, `43`; backend `prisma/schema.prisma` (migration
  `20261008051242_add_inbound_last_attempt_at`), `models/webhook.model.ts`,
  `models/inbound-webhook.model.ts`, `services/integration-health.service.ts`,
  `services/index.ts`, `controllers/webhook.controller.ts`, `routes/webhook.routes.ts`,
  `tests/webhooks.integration.test.ts`; frontend `api/integrations.api.ts`,
  `pages/integrations.page.tsx`, `pages/integrations.page.test.tsx`
- **Notes:**
  - **`GET /admin/integrations` returns one uniform row per integration** — outbound
    subscription or inbound endpoint — carrying last success, last error, dead-letter count,
    success/failure totals and a derived error rate (`32` §12 "status, last success, last
    error"). A single shape across both directions means an operator watching the board does
    not learn two vocabularies.
  - **`healthy` is derived, never stored**, from the rows themselves: unhealthy once a
    dead-lettered failure exists, or a failure more recent than the last success. A stored
    flag could disagree with the data; a derived one cannot.
  - **Aggregated without an N+1 (`09`, `33` §7).** Per-integration counts, maxima and the
    most recent error come from a fixed set of `groupBy`/`distinct` queries, not a loop — a
    health board that runs one query per integration is exactly the query pattern that scales
    worse than the page it serves.
  - **`InboundWebhookEvent` gained `lastAttemptAt`** so "last error at" is the time of the
    failure, not the time the event was received; the outbound model already carried it.
  - **The board is on the integrations page** (`32` §13), unhealthy-first, with a summary
    badge and a 30-second refresh so a failure surfaces without a manual reload.
  - **Coverage.** `tests/webhooks.integration.test.ts` (now 9) asserts a healthy row, a
    dead-lettered row and an inbound row all appear correctly, and that the board is behind
    `integration:read`; `pages/integrations.page.test.tsx` (now 10) adds the health board,
    the **inbound-endpoint create flow** (secret and path revealed once) and **secret
    rotation** for both directions.
  - **Remaining (`32`):** inbound sync (`§6`) and circuit-breaker/bulkhead tuning. M4 stays
    **partially** met (`40` §7).

### 2026-10-08 — Phase 3 increment 20: Integration administration UI and the event vocabulary endpoint (`32` §13)
- **Type:** Feature / Docs
- **Refs:** `32` §4/§5/§7/§11/§12/§13, `11` §9, `14`, `16`
- **Affects:** `docs/11` §9, `43`; backend `controllers/webhook.controller.ts`,
  `routes/webhook.routes.ts`, `tests/webhooks.integration.test.ts`; frontend
  `api/integrations.api.ts`, `pages/integrations.page.tsx`, `routes/index.tsx`,
  `components/app-shell.tsx`, `tests`/`pages/integrations.page.test.tsx`
- **Notes:**
  - **One screen, three surfaces (`32` §13), because an operator diagnosing a broken
    integration needs all of them at once:** webhook subscriptions (outbound, §4), inbound
    endpoints (receive, §5), and a **dead-letter viewer** with explicit retry for both
    directions (§13).
  - **The secret is shown once, from the create response only.** The UI surfaces a minted
    signing or verification secret in a one-time panel and every other view shows only the
    `secretHint`; the page never refetches a secret because the API never returns one again
    (`32` §7).
  - **The page exposes entitlements, it does not enforce them.** Manage controls require
    `integration:manage` and retry controls `integration:retry`; the screen hides what the
    caller cannot use so it is honest, and the server refuses independently (`32` §11,
    `07` §6).
  - **New read endpoint `GET /admin/webhooks/events`** (`integration:read`) returns the
    subscribable event vocabulary from the outbox event catalogue, so the subscription form
    selects real event names instead of a list the UI author maintained by hand (`32` §4).
  - **Coverage.** `pages/integrations.page.test.tsx` (5) asserts the entitlement boundary,
    the one-time secret and the retry path; `tests/webhooks.integration.test.ts` gains a case
    for the event vocabulary endpoint and its guard (now 8).
  - **Remaining (`32`):** inbound sync (`§6`), credential/config administration, the health
    board (`GET /admin/integrations` — last success/last error per integration), and
    circuit-breaker/bulkhead tuning. M4 stays **partially** met (`40` §7).

### 2026-10-08 — Phase 3 increment 19: Inbound webhooks (`32` §5)
- **Type:** Feature / Docs
- **Refs:** `32` §5/§7/§12/§13/§15 (AC2), `18` (trust boundary), `33` §6, `11` §9
- **Affects:** `docs/32` §12, `11` §9, `40` §7/§12, `43`; backend `prisma/schema.prisma`
  (migration `20261008044903_add_inbound_webhooks`), `models/inbound-webhook.model.ts`,
  `services/inbound-webhook.service.ts`, `services/inbound-webhook-scheduler.ts`,
  `controllers/inbound-webhook.controller.ts`, `routes/inbound-webhook.routes.ts`,
  `validators/inbound-webhook.validators.ts`, `routes/index.ts`, `server.ts`, `app.ts`,
  `config/env.ts`, `services/audit-events.ts`; tests
  `tests/inbound-webhooks.integration.test.ts`
- **Notes:**
  - **Order is the design (`32` §5): verify → persist the raw event → ack (`202`) → process
    in a worker.** Receive never processes, so a slow handler cannot make a provider retry
    and amplify load; the raw payload is persisted first, so nothing is lost if it does.
  - **The public route has no session** — the HMAC signature over the raw body is the only
    authentication. The exact bytes are captured by a `verify` hook on the JSON body parser
    (`app.ts`), because re-serialising the parsed object can change key order and break
    verification. Unsigned, malformed, stale-timestamp and unknown-key deliveries all return
    **`401`** — identical, so the endpoint cannot be probed by comparing status codes. The
    route is CSRF-exempt (an external caller holds no cookie session) but stays behind the
    application rate limiter, because an unauthenticated endpoint is what a flood targets.
  - **Idempotency (`docs/32` §5, AC2).** `(endpointId, providerEventId)` is unique, so a
    provider retry is a **no-op that still acks** (stopping the retries). A provider that
    sends no id still gets idempotency: the body digest is the fallback key.
  - **Inbound payloads are untrusted input (`18`).** The signature proves origin and
    integrity, never schema. The body is persisted unvalidated and only parsed as JSON at the
    edge; a handler validates its own shape before acting.
  - **Retention and failure (`32` §5).** The raw payload is retained for a bounded window and
    nulled when it expires (the row is kept). An unprocessable event retries with bounded
    backoff, then **dead-letters** with its raw payload retained for diagnosis; dead-letters
    are visible (`/admin/integrations/inbound-dead-letters`) and explicitly retryable, and
    the retry is audited. An event type with no registered handler is **accepted and marked
    processed**, not failed — recording-only is a valid state.
  - **Secrets (`32` §7).** The verification secret is generated server-side and returned
    **once**; reads expose a `secretHint`; the audit snapshot records `secretRotated: true`,
    never the secret.
  - **Remaining (`32`):** inbound sync (`§6`), credential/config administration, the health
    board (`GET /admin/integrations`), circuit-breaker/bulkhead tuning, and the integration
    admin UI. M4 stays **partially** met (`40` §7).
  - **Evidence.** `tests/inbound-webhooks.integration.test.ts` (7) passes alongside the full
    backend suite.

### 2026-10-08 — Phase 3 increment 18: Record history on all five types, audit export, and `32` approved with the outbound-webhook slice
- **Type:** Feature / Docs
- **Refs:** `31` §5/§9/§10/§11 (AC5), `32` §3/§4/§7/§8/§11/§12/§13/§15, `30` §3.4/§5,
  `07` §3, `11` §9, `40` §7/§12
- **Affects:** `docs/32-INTEGRATIONS.md` (**`Draft` → `Approved` 2026-10-08**), `07` §3,
  `11` §9, `40` §7/§12, `43`; backend `prisma/schema.prisma` (migration
  `20261008042654_add_outbound_webhooks`), `models/webhook.model.ts`,
  `services/webhook.service.ts`, `services/webhook-scheduler.ts`, `services/audit.service.ts`,
  `services/{asset,kb,task}.service.ts`, `services/audit-export.service.ts`,
  `services/report-export.service.ts`, `services/audit-events.ts`,
  `controllers/webhook.controller.ts`, `controllers/audit.controller.ts`,
  `routes/webhook.routes.ts`, `routes/audit.routes.ts`, `routes/index.ts`, `server.ts`,
  `validators/webhook.validators.ts`, `validators/audit.validators.ts`,
  `helpers/permission-catalogue.ts`, `config/env.ts`, `integrations/index.ts`,
  `integrations/webhook-client.ts`, `integrations/webhook-signature.ts`; frontend
  `api/audit.api.ts`, `components/audit-export-panel.tsx`, `components/audit-explorer.tsx`,
  `components/record-history-panel.tsx`, `pages/{my-tasks,asset-detail,article}.page.tsx`;
  tests `tests/webhooks.integration.test.ts`, `tests/webhook-signature.test.ts`,
  `tests/audit.integration.test.ts`, `tests/assets.integration.test.ts`,
  `components/audit-export-panel.test.tsx`
- **Notes:**
  - **Record history completes on all five types (`31` §11).** `assertRecordReadable` now
    resolves a participant's entitlement through the owning service for **request,
    incident, task, asset and article** (`assertTaskVisible`/`assertAssetVisible`/
    `assertArticleVisible` were added), so the record-history tab works everywhere the
    specification lists it. A non-participant still receives the record's own `404`, never a
    `403` that would disclose the record exists.
  - **Audit export (`31` §9/§10) is a separate grant from reading.** `POST /audit/export`
    queues an async job (`30` §3.4/§5) under `audit:export`, audited **with its filters**; a
    `securityOnly` export additionally requires `audit:read.security` and is refused, not
    widened. Scope is **re-derived when the worker runs**, so a queued export cannot outlive
    a permission change. `GET /audit/exports/{id}` and `…/download` are self-scoped
    (`404` for another user's job). The CSV marks its scope and, per row, whether the
    security class was included or redacted.
  - **`32` (Integrations) reached `Approved` on 2026-10-08** on owner authority, satisfying
    the Phase 3 entry gate (`40` §12).
  - **First integration slice: outbound webhooks (`32` §4).** A domain-owned
    `WebhookHttpClient` interface with an HTTP adapter (`webhook-client.ts`) and a recording
    fake for tests; per-subscription **HMAC-SHA256 signatures over the raw body with a
    timestamp** (`webhook-signature.ts`, header `t=…,v1=…`, constant-time verification with a
    tolerance window); subscription management (`/admin/webhooks`, secret returned **once**),
    **fan-out read from the durable outbox** through a per-tenant cursor, and a delivery
    worker with **bounded exponential backoff and full jitter → dead-letter**, plus a
    dead-letter viewer and an audited explicit retry (`/admin/integrations/dead-letters`).
    The payload is **minimal** — `id`, `type`, `occurredAt` and identifier fields only —
    because a webhook is an exfiltration surface (`32` §4/§10). No external call ever runs
    on the request path (`32` §1); a subscriber failure cannot reach authentication or
    request handling (`32` §15 AC6).
  - **Secrets never appear where they must not (`32` §7/§15 AC5).** The signing secret is
    returned only on create; reads expose a `secretHint`; the audit `after` snapshot records
    `secretRotated: true` rather than the secret; and the adapter maps vendor errors to a
    domain reason without echoing a response body.
  - **New grants (`07` §3):** `integration:manage`, `integration:read`, `integration:retry`
    (Administrator).
  - **Remaining (`32`):** inbound webhooks (§5) and inbound sync (§6), credential/config
    administration (`admin:config` surface), the health board (`GET /admin/integrations`),
    circuit-breaker/bulkhead tuning, and the integration admin UI. M4 is therefore
    **partially** met (`40` §7).
  - **Evidence.** `tests/webhooks.integration.test.ts` (7), `tests/webhook-signature.test.ts`
    (5) pass alongside the full backend suite.

### 2026-10-07 — Phase 3 increment 17: Audit log read surface and the audit explorer (F-17)
- **Type:** Feature / Docs
- **Refs:** `31` §2/§5/§9/§10/§11/§13 (AC5), `11` §9, `07` §3
- **Affects:** `models/audit.model.ts`, `models/team.model.ts`, `services/audit.service.ts`,
  `services/audit-events.ts`, `controllers/audit.controller.ts`, `routes/audit.routes.ts`,
  `validators/audit.validators.ts`, `routes/index.ts`, `services/index.ts`; frontend
  `api/audit.api.ts`, `components/audit-diff.tsx`, `components/audit-table.tsx`,
  `components/audit-explorer.tsx`, `components/record-history-panel.tsx`,
  `utils/short-id.ts`, `pages/audit.page.tsx`, `pages/security-activity.page.tsx`,
  `pages/request-detail.page.tsx`, `pages/incident-detail.page.tsx`, `routes/index.tsx`,
  `components/app-shell.tsx`; tests `tests/audit.integration.test.ts`,
  `components/audit-diff.test.tsx`, `components/record-history-panel.test.tsx`,
  `pages/audit.page.test.tsx`, `pages/security-activity.page.test.tsx`
- **Notes:**
  - **Scope is a query predicate, never a post-fetch filter (`31` §5).** `audit:read.all`
    is the tenant; `audit:read.team` resolves to the caller's **team members** (plus
    themselves), applied in `listAuditPage`. An `actorId` outside that scope returns an
    **empty page**, so a lead cannot use the filter as an existence oracle for another
    team's activity.
  - **The security class is withheld, not flagged (`31` §2/§5).** Without
    `audit:read.security` a security-class entry arrives with `redacted: true` and its
    `before`/`after`/`sourceIp`/`userAgent` **already null** — the projection happens before
    the row leaves the service. `securityOnly` and `/audit/security` are refused (`403`)
    for a caller without the grant rather than returned empty.
  - **Reading the log is itself audited (`31` §13 AC5).** Every page records an `audit.read`
    entry (entity `AuditLog`, with the filters and the resolved scope) **in its own
    transaction before the rows are returned**, so a caller cannot receive a page they were
    not recorded as having seen.
  - **A record's history is authorised by the record (`31` §5).**
    `GET /audit/records/{entityType}/{entityId}` carries **no route-level audit guard**: a
    participant reaches it through the owning service's object-level check
    (`assertRequestVisible`/`assertIncidentVisible`), and only an audit grant widens it to
    any record. A record type with no participant-readable projection stays auditor-only.
    This also fixes the route guard that would have excluded every participant the
    specification means to include.
  - **One capability, two grants.** `listAuditEntries` asserts **either** `audit:read.team`
    or `audit:read.all`; asserting the narrower one alone locked an administrator out of the
    log they are entitled to read.
  - **A closed, indexed filter set (`09` §3).** `action`, `actorId`, `(entityType,
    entityId)` and `occurredAt` map to indexed columns; the cursor is the total
    `(occurredAt, id)` tuple. No mutation route exists on this surface (`31` §9) — the
    append-only trigger is the enforcement.
  - **UI (`31` §11).** All four surfaces: a **record history** timeline on requests and
    incidents, an **audit explorer** (filterable, cursor-paginated, field-level diff), a
    **security activity** view, and a **diff viewer** with redaction markers. Each renders
    what the server returned and applies no scope of its own; a withheld entry shows a
    **Redacted** marker rather than an empty diff.
  - **Remaining (`31` §11).** The record-history tab is wired on **requests and incidents**
    only; tasks, assets and articles follow once each has a participant-readable history
    projection (the record half of §5 currently resolves request and incident visibility).
  - **Evidence.** `tests/audit.integration.test.ts` (7) — **244 tests / 26 files pass** in
    the backend, 52 tests / 19 files in the frontend.

### 2026-10-07 — Phase 3 increment 16: Knowledge base and asset register live; CR-0003/CR-0004 resolved
- **Type:** Feature / Fix / Docs
- **Refs:** `27` (Approved), `28` (Approved), `30` §2.1/§2.2, `09` §2/§3, `11` §9,
  `42` §4.5 (`CR-0003`), §4.6 (`CR-0004`), `25` §4/§14, `07` §3
- **Affects:** `27`, `28` (Draft → **Approved**, permission tables reconciled to `07` §3),
  `25` §4, `09`, `11`, `42` §4.5/§4.6/§6, `helpers/permission-catalogue.ts`,
  `services/sla-clock.service.ts`, `helpers/calendar.ts`, `models/kb.model.ts`,
  `services/kb.service.ts`, `models/asset.model.ts`, `services/asset.service.ts`,
  `services/search.service.ts`, `models/search.model.ts`, controllers, routes, validators,
  migrations `20261007044147_knowledge_base_and_assets`, `20261007045627_article_draft_changes`,
  `20261007051500_assets_search_idx`; frontend `components/markdown.tsx`, `api/kb.api.ts`,
  `api/assets.api.ts`, four pages and their tests; tests `tests/kb.integration.test.ts`,
  `tests/assets.integration.test.ts`
- **Notes:**
  - **`CR-0003` Accepted** by the owner: the inline v1 report-export storage stands for the
    remainder of Phase 2; the object-storage migration (`ADR-0004`) is scheduled with the S3
    adapter in Phase 3. No code change.
  - **`CR-0004` Accepted and implemented.** `25` §4 example 2 now states **Wed 15:00**
    (its own inputs and reasoning implied it), and `resumeClock` advances a frozen target by
    the **working minutes inside the pause** rather than its wall-clock length — the AC2
    rule it was violating. A 24×7 calendar still excludes the full pause, so Model B is
    unchanged. Two explicit-timestamp regression tests were added.
  - **Knowledge base (`27`).** Lifecycle `DRAFT → IN_REVIEW → PUBLISHED → ARCHIVED` with
    reject and unarchive, and **publish creates an immutable `ArticleVersion`**. A published
    article is served to readers from that snapshot, so an unreviewed edit cannot leak
    (`AC2`) — `Article.draftChangedAt` is the pending-changes marker. Visibility is a SQL
    **pre-filter on read *and* in search** (rule K3), so a `RESTRICTED` article is absent
    from another reader's results rather than filtered out of them.
  - **Asset register (`28`).** Types with a required-attribute schema, a server-allocated
    `AST-000123` tag, and assignment intervals that are **history and never deleted**. Two
    constraints live in the database because the schema language cannot express them: the
    partial unique index that permits at most one **open** assignment (`AM1`) and the
    `CHECK` that a holder's type agrees with its column. `state` and the open assignment are
    written in one transaction (`AM6`), so no API path can make them disagree.
  - **Search (`30` §2.1).** Articles and assets joined the FTS sources, each with its own
    GIN expression index and the caller's scope applied as a SQL predicate (S1). Articles
    weight `title`/`summary` above `body`; assets index `tag`, `serialNumber` and `name`.
  - **Permission consistency.** `REQUESTER` was missing `asset:read.own`, which `07` §3
    grants (`Asset read = O (own)`); the catalogue now matches the Approved matrix.
  - **Evidence.** `tests/kb.integration.test.ts` (9) and `tests/assets.integration.test.ts`
    (12) — **237 tests / 25 files pass** in the backend, 39 tests / 14 files in the
    frontend.

### 2026-10-06 — Phase 2 increment 15: Security test suite, E2E journeys and SLA worked examples (Gate 2 evidence)
- **Type:** Process / Test
- **Refs:** `20` §3–§9, `37` §7/§14, `25` §4/§14, `42` §4.6 (`CR-0004`), `07` §1/§5, `17`
- **Affects:** backend tests — `tests/security-authorization.integration.test.ts`,
  `tests/security-auth-and-input.integration.test.ts`, `tests/e2e-journeys.integration.test.ts`,
  `tests/sla-worked-examples.test.ts`; docs — `42` §4.6 (`CR-0004`), this entry
- **Notes:** The three automated layers Gate 2 asks for, implemented against the real app
  and a real database. **214 tests / 23 files pass** (was 172/19).
  - **Authorization matrix and IDOR sweep (`20` §4/§5), 15 tests.** Table-driven: owner
    `200`, foreign caller **`404` not `403`** (`07` §1), unauthenticated `401`, missing
    permission `403`, auditor `403` on every mutation, and the administrator refused an
    approval decision (`07` §5 separation of duties). Covers id substitution on reads
    *and* writes, nested-resource ids, cross-tenant ids (`ADR-0002`), report/export
    scope-widening, self-service privilege escalation, and search leakage.
  - **Authentication, input and abuse (`20` §6–§9), 16 tests.** Uniform login failure and
    a single-use reset that revokes sessions; a lockout with `Retry-After`; a **real**
    `429` from the limiter; only a token hash persisted; immediate deactivation. A
    SQL-injection corpus, operator injection, mass assignment, `413`/`422` bounds,
    malformed JSON with no stack trace, and XSS-shaped data round-tripping as data.
  - **End-to-end journeys (`37` §7), 5 tests.** All four journeys: request → approval →
    resolution; incident → assign → resolve → in-app notification; search scoped across
    permission *and* tenant boundaries; and a catalog edit that leaves an in-flight
    request unchanged (`FR-CATALOG-005`).
  - **SLA worked examples (`25` §4), 6 tests.** Examples 1–5 asserted directly; the
    remaining-budget rule (`§14` AC2) and the frozen-target rule (`§14` AC4, example 5)
    verified through the clock mechanics.
  - **Finding — `CR-0004` (Raised).** Example 2's stated inputs yield Wed 15:00, not the
    stated Thu 15:00 (document typo), and `resumeClock` shifts the target by the pause's
    **wall-clock** duration, double-counting non-working time on a cross-day pause and so
    failing `§14` AC2. The owner is asked to correct `25` §4 and fix `resumeClock`; the
    suite asserts the rule, not the disputed literal, so the gap stays visible.

### 2026-10-06 — Phase 2 increment 14: Async report exports with a time-limited download (F-14)
- **Type:** Feature
- **Refs:** `05` §5 (build order 7), `09` §2/§3 (Q60–Q62), `11` §9, `30` §3.1/§3.3/§3.4/§5,
  `42` §4.5 (`CR-0003`), `37`
- **Affects:** backend — `prisma/schema.prisma` (`ReportExport`, enum
  `ReportExportStatus`) and migration `report_exports`; `models/report-export.model.ts`;
  `services/report-export.service.ts`; `services/report-export-scheduler.ts`;
  `controllers/search.controller.ts`; `routes/search.routes.ts`; `services/audit-events.ts`
  (`report.export.requested` / `report.export.completed`); `config/env.ts`; `server.ts`;
  frontend — `api/client.ts` (`apiDownload`), `api/search.api.ts`, `pages/reports.page.tsx`,
  `pages/reports.page.test.tsx`; tests `backend/tests/report-export.integration.test.ts`
- **Notes:** `docs/30` §3.4 requires a large report to run as a **job** and produce a
  **time-limited download**, never blocking a request thread on an aggregate.
  - **Run as the requester (`R3`).** The worker re-derives the requester's permissions and
    calls `runReport` as them, so an export can never exceed what they could read in the
    UI; a cross-team metric they may not read fails the job and is recorded on the row.
  - **Audited with its filters (`R5`).** The request records the metric and period; the
    completion records the row count and expiry — exfiltration is accountable.
  - **Time-limited, self-scoped.** The result carries an `expiresAt`; the download is
    `404` once it lapses, and is limited to the **requester** (another `report:export`
    holder who guesses the id gets a `404`, not data).
  - **Atomic claim.** The queue is drained by a conditional `UPDATE … WHERE status =
    'QUEUED'`, so two instances cannot run the same job; leadership uses the same
    short-lived Redis lock as the other workers (`03` §6).
  - **Honest deviation — `CR-0003`.** v1 stores the CSV **inline** in the row rather than
    in object storage (`19`/`ADR-0004`); the CR is **Raised** and the owner must accept the
    interim or require the adapter. The file row is shaped so a storage key can replace
    the column.

### 2026-10-06 — Phase 2 increment 13: Notification preferences and the in-app centre (F-12)
- **Type:** Feature
- **Refs:** `05` §5 (build order 5), `09` §2/§3, `11` §9, `29` §5/§7/§12/§13, `37`
- **Affects:** backend — `prisma/schema.prisma` (`NotificationPreference`; `Notification`
  gains `title`/`body`/`linkUrl`/`readAt`) and migration
  `20261006083900_notification_preferences_inapp`; `models/notification.model.ts`
  (preferences, in-app list/read); `services/notification-events.ts` (event catalogue);
  `services/notification-centre.service.ts`; `services/notification.service.ts` (in-app
  delivery and preference enforcement); `controllers/notification.controller.ts`;
  `routes/notification.routes.ts`; `validators/notification.validators.ts`; frontend —
  `api/notifications.api.ts`, `components/notification-bell.tsx`,
  `pages/{notifications,notification-preferences}.page.tsx`,
  `pages/notification-preferences.page.test.tsx`, `routes/index.tsx`, `components/app-shell.tsx`
- **Notes:** The two halves of `docs/29` that were named but unbuilt: the preference model
  and the centre the in-app channel delivers into.
  - **Preferences are applied at the last moment (`29` N5).** A disabled OPERATIONAL
    preference suppresses the send; the suppression is recorded as a `SKIPPED`
    `Notification`, so "opted out" is visible and distinct from "failed".
  - **Transactional events cannot be silenced (`29` N6).** The catalogue classifies every
    event; the preference API **refuses** a change that would disable a transactional one
    with `422`, rather than accepting a toggle that does nothing. The UI shows those rows
    fixed on and explains why.
  - **The in-app channel is now delivered.** A `Notification` with `channel = IN_APP`
    carries `title`/`linkUrl`/`readAt`; the worker creates it for events whose payload
    names a recipient (assignee, requester, reporter or approver list). `GET /notifications`
    and its read endpoints are **self-scoped** — another user's notification is a `404`.
  - **Honest gap.** Events whose payload carries no recipient id (e.g. `request.created`,
    `incident.reported`) are email-only until the owning service enriches the payload; the
    event catalogue marks exactly which events are in-app notifiable, so the gap is visible
    in one place rather than duplicated per service.

### 2026-10-06 — Phase 2 increment 12: PostgreSQL full-text search for `/search`
- **Type:** Feature / Performance
- **Refs:** `09` §3 (Q56), `30` §2.2/§2.4/§2.5, `42` §4.4 (`CR-0002`); `ADR-0009`
- **Affects:** backend — migration `20261006082530_search_fts` (four GIN expression
  indexes); `models/search.model.ts` (single-statement `UNION ALL` FTS query);
  `services/search.service.ts`; `tests/search.integration.test.ts`; docs — `42`, `09`
- **Notes:** Replaces the interim pattern match recorded in `CR-0002` with the technology
  `30` §2.2 names, so `CR-0002` is **Withdrawn** (the deviation was never accepted).
  - **Real full-text search.** GIN expression indexes over
    `to_tsvector('english', …)` on `service_requests`, `incidents`, `catalog_items` and
    `users`; the query uses `websearch_to_tsquery` and ranks with `ts_rank`, so a
    multi-term query is a conjunction and results are relevance-ordered.
  - **The two rules still hold, in one statement (`30` §2.3).** Each source branch carries
    its visibility predicate in SQL (S1, before ranking and pagination), and the permitted
    branches are `UNION ALL`-ed, ranked and limited together (S2 — filter → rank →
    paginate in one query).
  - **Snippets via `ts_headline` (`§2.4`).** The excerpt is generated by the database and
    computed only for the returned page, so highlighting cannot force a full scan of the
    match set.
  - **Short queries (`§2.4`).** Fewer than two characters has no full-text terms, so the
    query falls to an exact identifier match; an empty query is a recency browse.
  - `ADR-0009` (search technology) remains `Proposed` for the owner to mark `Accepted` now
    that the code matches `30` §2.2.

### 2026-10-06 — Phase 2 increment 11: Unified search and reporting (F-13, F-14)
- **Type:** Feature
- **Refs:** `05` §5 (build order 7), `09` §2/§3, `11` §9, `30` §2/§3/§4, `37`; `CR-0002`
  (`42` §4.4), `ADR-0009`
- **Affects:** backend — `prisma/schema.prisma` (`SlaClock` period index; migration
  `20261006081305_sla_clock_started_index`); `models/{search,report}.model.ts`;
  `services/{search,report}.service.ts`; `controllers/search.controller.ts`;
  `routes/search.routes.ts`; `validators/search.validators.ts`;
  `helpers/permission-catalogue.ts` (new `report:read.all`, `report:export`; `report:read`
  to `REQUESTER`); `models/index.ts`, `services/index.ts`, `routes/index.ts`; frontend —
  `api/search.api.ts`, `pages/{search,reports}.page.tsx`, `pages/search.page.test.tsx`,
  `routes/index.tsx`, `components/app-shell.tsx`; docs — `42` (CR-0002), `09`, `11`
- **Notes:** The read model of `docs/30`: find-this-now and what-happened-over-time, both
  scoped to what the caller may see.
  - **Search never returns an unreadable record (`30` §2.3 S1/S2).** Every source is
    fetched through a data-layer query that carries the caller's scope, so visibility is a
    SQL predicate applied before ranking and before pagination; the service then ranks the
    bounded candidate set and paginates. A restricted record under a broad query is the
    canonical leak, and the integration test asserts it is absent from results and counts.
    A source the caller cannot read (users without `user:manage`; a draft catalog item for
    a requester) is not searched at all, so absence is not a signal.
  - **Reports are scoped, and a number carries its scope (`30` §3.2 R2/R3).** Figures are
    aggregated in the database from stored timestamps (`R1`), the response states its
    period, time zone and scope, and cross-team reporting (`sla.attainment`) is reserved
    for `report:read.all`. A caller without it is refused with `403`, not quietly narrowed.
  - **Deviation recorded, not silent.** `30` §2.2 names PostgreSQL FTS; v1 uses a scoped
    pattern match instead, because the authorization property is the risk that matters and
    the FTS index is safer to land with its own migration and measurement. Per `00` R5 the
    deviation is recorded as **`CR-0002`** (`42` §4.4, In Review) and **`ADR-0009` remains
    Proposed** — the owner decides whether to accept the interim approach or schedule the
    FTS work. `30` §2.5's indexed-filter rule is honoured for the report queries (the
    `SlaClock` period index is added); the search predicate is the one exception, named in
    the CR.
  - **Not yet built (tracked):** materialised/cached aggregates and async exports with an
    export audit (`30` §3.4 R4/R5), and the full metric catalogue (`30` §3.3).

### 2026-10-06 — Phase 2 increment 10: Notifications outbox drain (F-12)
- **Type:** Feature
- **Refs:** `05` §5 (build order 5), `09` §2/§3, `13` §7, `29` §3/§4/§8/§10, `31`, `32`;
  `ADR-0003`, `ADR-0006`
- **Affects:** backend — `prisma/schema.prisma` (`Notification`; `NotificationChannel`,
  `NotificationStatus`) and migration `20261006074517_notifications`;
  `models/notification.model.ts`; `services/notification.service.ts`;
  `services/notification-templates.ts`; `services/notification-scheduler.ts`;
  `integrations/email.ts`; `models/index.ts`, `services/index.ts`; `config/env.ts`
  (`SENDGRID_API_KEY`, `SENDGRID_API_BASE_URL`, `NOTIFICATION_*`); `server.ts`
- **Notes:** The reliability boundary from `docs/29` §3 finally has a consumer: the outbox
  is drained, emails are delivered, and every send is recorded.
  - **The outbox is now drained, not just written.** Invitation and password-reset events
    were queued in the mutation's transaction and never delivered; the worker renders the
    template, sends via the provider adapter, and records a `Notification`.
  - **Idempotency (`docs/29` N3).** `Notification.dedupeKey` is `(eventId, recipient,
    channel)`, unique, so a redelivered event reuses the row and never sends twice —
    verified by draining the same invitation twice and asserting one send.
  - **Bounded retry then dead-letter (`docs/29` N7).** A provider failure increments the
    attempt count, applies bounded exponential backoff (capped at an hour), and after the
    configured cap dead-letters with an error log. The row is released either way, so a
    permanently failing send cannot block the queue.
  - **A real provider behind the existing domain boundary (`docs/32`).** The `EmailAdapter`
    interface and its `unsupportedEmailAdapter` placeholder already existed; this ships a
    SendGrid Web API adapter (selected by `SENDGRID_API_KEY`, `ADR-0006`) and a
    development logging adapter. A misconfigured production boot is refused rather than
    silently logging mail.
  - **Single leader (`ADR-0003`).** The scheduler takes a short-lived Redis lock per tick,
    so every instance may run it while one drains; with Redis absent it drains locally.
  - **Not yet built (tracked):** per-user channel preferences (`29` §7), in-app
    notifications and the `IN_APP` channel, delivery webhooks (N8), and templates for
    events other than invitation and password reset — an untemplated event is logged and
    marked processed so it is visible rather than retried forever.

### 2026-10-06 — Phase 2 increment 9: Approvals (F-09)
- **Type:** Feature
- **Refs:** `05` §5 (build order 5), `07` §5, `09` §2/§3 (Q40–Q49), `11` §9, `12`, `25`
  §3, `26`, `31`; `ADR-0002`
- **Affects:** backend — `prisma/schema.prisma` (`ApprovalTemplate`, `ApprovalTemplateStep`,
  `ApprovalWorkflow`, `ApprovalStep`, `ApprovalStepApprover`, `ApprovalDecision`;
  `ApprovalMode`, `ApprovalStepStatus`, `ApprovalWorkflowStatus`, `ApprovalDecisionOutcome`)
  and migrations `20261006064000_approvals` and
  `20261006065000_approval_decision_insert_only`; `models/approval.model.ts`;
  `validators/approval.validators.ts`; `services/approval.service.ts`;
  `controllers/approval.controller.ts`; `routes/{approval,request}.routes.ts`;
  `helpers/permission-catalogue.ts` (`approval:reassign`; `TEAM_LEAD`/`ADMINISTRATOR`);
  `models/role.model.ts` (`listActiveUserIdsWithRoleKey`); `services/request.service.ts`
  (instantiate/cancel integration, terminal-transition guard); `services/audit-events.ts`;
  frontend — `api/approvals.api.ts`, `components/approvals-panel.tsx`,
  `pages/{approvals,approval-templates}.page.tsx` and `pages/approvals.page.test.tsx`,
  `pages/request-detail.page.tsx`, `routes/index.tsx`, `components/app-shell.tsx`
- **Notes:** The sixth slice of the docs/05 §5 build order: a request that needs a gate
  now has one, and the gate is a recorded decision rather than a status change.
  - **Instantiation (`26` §4).** A request entering `APPROVAL_PENDING` instantiates the
    item's active template in the **same transaction** as the status change; the requester
    is excluded from the approver snapshot, so self-approval is impossible (`07` §5).
    Approvers are snapshotted, never resolved lazily at decision time (`26` A2).
  - **Entry guard.** Entering `APPROVAL_PENDING` now requires an active template with a
    non-empty eligible approver set — an unapprovable request is a configuration error
    (`26` §13), not a request stranded in a pending state.
  - **Decisions are insert-only (`26` A3).** A database trigger rejects `UPDATE`/`DELETE`
    on `approval_decisions`; a reversal is a new decision, never an edit.
  - **Decision rules (`26` §5).** Only a designated approver for the **active** step may
    decide; the check is idempotency-first, so replaying a decision after the step has
    advanced returns the original outcome (`recorded:false`) rather than a misleading
    `409`. Concurrent decisions on an `ANY` step advance it exactly once.
  - **SLA integration (`25` §3).** The clock pauses on `APPROVAL_PENDING` (per policy) as
    already implemented, and now resumes on the workflow's terminal outcome — approval or
    rejection — by shifting the frozen target, never recomputing it.

### 2026-10-06 — Phase 2 increment 8: SLA breach sweep and clock pause/resume (F-08 completion)
- **Type:** Feature
- **Refs:** `05` §5 (build order 3), `09` §3 (Q49), `25` §3/§5/§6, `31`; `ADR-0003`
- **Affects:** backend — `models/sla.model.ts` (pause/resume and sweep queries);
  `services/sla-clock.service.ts` (`pauseClockIfPolicy`, `resumeClock`); new
  `services/sla-sweep.service.ts` (`runSlaSweep`) and `services/sla-sweep-scheduler.ts`;
  `services/request.service.ts` (pause on `APPROVAL_PENDING`, resume on leaving it);
  `services/audit-events.ts`; `config/env.ts` (`SLA_SWEEP_INTERVAL_MS`); `server.ts`
  (scheduler start/stop)
- **Notes:** Completes the `F-08` feature: the clock now reflects real elapsed service
  time and breaches are detected, not inferred.
  - **Pause/resume (`25` §3).** A transition into a policy-declared pause state pauses the
    clock; leaving it resumes and pushes the target and warn instants out by the paused
    duration. Both operations are idempotent, so re-entering a pause state cannot restart
    the interval and leaving twice cannot double-count. A policy with no pause states
    keeps the clock running during approval — a deliberate choice surfaced to the user.
  - **The target is shifted, never recomputed** on resume, preserving the frozen-target
    rule (`25` §4 example 5).
  - **Sweep (`25` §6).** `runSlaSweep` breaches clocks past their target and marks
    near-target clocks `AT_RISK`. It is idempotent by restricting the candidate query to
    clocks still in the pre-breach/pre-risk states, so a repeated run in the same interval
    emits no duplicate breach. `breachedAt` is recorded at detection.
  - **Single leader.** The scheduler takes a short-lived Redis lock per tick
    (`ADR-0003`), so every instance may start it while exactly one sweeps; when Redis is
    absent (local, single instance) it sweeps locally. A sweep failure is logged, never
    thrown onto the request path.

### 2026-10-06 — Phase 2 increment 7: Tasks (F-07)
- **Type:** Feature
- **Refs:** `05` §5 (build order 4), `08` §4.3, `09` §2/§3, `11` §9, `12`, `24`, `31`
- **Affects:** backend — `prisma/schema.prisma` (`Task`; `TaskStatus`, `TaskParentType`)
  and migrations `20261006062745_tasks` and `20261006063100_task_blocked_reason_check`;
  `models/task.model.ts`; `validators/task.validators.ts`; `services/task.service.ts`;
  `controllers/task.controller.ts`; `routes/{task,request,incident}.routes.ts`;
  `helpers/permission-catalogue.ts` (new `task:create`, `task:update.team`,
  `task:cancel`, `task:override`); `services/{request,incident}.service.ts` (roll-up);
  `services/audit-events.ts`; frontend — `api/tasks.api.ts`,
  `components/tasks-panel.tsx`, `pages/my-tasks.page.tsx`, `pages/{request,incident}-
  detail.page.tsx`, `routes/index.tsx`, `components/app-shell.tsx`
- **Notes:** The fifth slice of the docs/05 §5 build order: work inside a parent becomes
  visible, assigned pieces.
  - **The state machine (`24` §3)** is `TODO → IN_PROGRESS ⇄ BLOCKED`, `→ DONE`, and any
    non-terminal `→ CANCELLED`; `DONE`/`CANCELLED` are terminal. Entering `BLOCKED`
    requires a reason (rule T6 for terminal, §3 for blocks) — enforced by the
    `tasks_blocked_reason_required` CHECK constraint at the database, because a block
    with no reason conveys nothing actionable.
  - **Roll-up (`24` §4)** is enforced by the **parent** services: a request cannot be
    fulfilled, and an incident cannot be resolved, while open child tasks exist, unless
    the caller holds `task:override` and supplies a reason. The override is audited and
    alerted on, not merely permitted. The parent reads the task table through the data
    layer (`countOpenTasksForParent`), preserving the docs/03 §4 dependency direction
    (tasks → parents, never the reverse).
  - **Visibility (`24` rule T2)** is inherited, not re-implemented: every task read
    resolves its parent through that parent's own object-level check, so a task can never
    be a back door to a record the caller may not see.
  - **Overdue is derived** from `dueAt` and terminal state (§6) and is never stored, so a
    timezone or clock change cannot leave a stale `OVERDUE` status behind.

### 2026-10-06 — Phase 2 increment 6: Incidents (F-06)
- **Type:** Feature
- **Refs:** `05` §5 (build order 4), `08` §4.2, `09` §2/§3, `11` §9, `12`, `23`,
  `25` §3/§7, `31` §8; `ADR-0002`, `ADR-0008`
- **Affects:** backend — `prisma/schema.prisma` (`Incident`; `IncidentImpact`,
  `IncidentUrgency`, `IncidentStatus`) and migrations `20261006061750_incidents` and
  `20261006062500_incident_resolution_summary_check`; `models/{incident,audit}.model.ts`;
  `validators/incident.validators.ts`; `services/incident.service.ts`;
  `controllers/incident.controller.ts`; `routes/incident.routes.ts`;
  `helpers/{permission-catalogue,authorization}.ts` (new `incident:priority:override`
  permission and `INCIDENT_READ_PERMISSIONS`); `services/sla-clock.service.ts` (optional
  clock `cycle`); `config/env.ts` (`INCIDENT_REOPEN_WINDOW_HOURS`, default 72);
  `services/audit-events.ts`; frontend — `api/incidents.api.ts`,
  `pages/{incidents,incident-detail}.page.tsx`, `utils/request-tones.ts`,
  `routes/index.tsx`, `components/app-shell.tsx`
- **Notes:** The fourth slice of the docs/05 §5 build order. An incident is *something
  broken*, distinct from a request, and the divergence is owned by `incident.service.ts`.
  - **Priority is derived (`23` §3)**, never chosen: the impact × urgency matrix is
    authoritative and the create envelope has no `priority`. A client may not set it,
    and a change to `impact`/`urgency` **re-derives** it (`23` §12). An override is a
    separate, permissioned action requiring `incident:priority:override`, a mandatory
    reason and an audit record, and it raises a notification signal so a pattern of
    overrides is visible.
  - **The state machine (`23` §4)** is `NEW → IN_PROGRESS → RESOLVED → CLOSED` with
    reopen; there is no approval path (I5) and no deletion (I8). Assignment folds the
    `NEW → IN_PROGRESS` edge so rule I2 (no `IN_PROGRESS` without an assignee) cannot be
    broken — an incident reaches `IN_PROGRESS` only in the same transaction that sets its
    assignee. Resolution requires a summary, and the requirement is enforced **at the
    database** by the `incidents_resolution_summary_required` CHECK constraint, not only
    in the API.
  - **Reopen (`23` §4 I4)** is permitted within a configured window; outside it, only an
    agent/lead may reopen and a reason is required. The window is anchored to the
    incident's terminal moment (its closure for a closed incident, its resolution
    otherwise). A reopen increments `reopenCount` and starts a **new SLA clock cycle**,
    so reopened work is measured on its own (`25` §3).
  - **Major flag (`23` §5)** is toggled by agents/leads and audited in both directions;
    a closed incident cannot be newly marked major. The list surfaces majors first.

### 2026-10-06 — Phase 2 increment 5: Service requests (F-05) and the SLA clock
- **Type:** Feature
- **Refs:** `05` §5 (build order 2), `08` §4.1/§4.6, `09` §2, `11` §4/§9, `12`, `22`,
  `25` §3/§4/§5, `31`; `ADR-0002`, `ADR-0008`
- **Affects:** `11` §4 (new `CONFLICT` code), `11` §9; backend — `prisma/schema.prisma`
  (`ServiceRequest`, `RequestFieldValue`, `Comment`, `ReferenceSequence`; `RequestStatus`,
  `CommentVisibility`) and migration `20261006051611_service_requests`;
  `helpers/calendar.ts`; `models/{request,comment,reference}.model.ts`;
  `validators/request.validators.ts`; `services/{request,sla-clock}.service.ts`;
  `controllers/request.controller.ts`; `routes/request.routes.ts`; frontend —
  `api/requests.api.ts`, `pages/{requests,request-detail}.page.tsx`,
  `utils/request-tones.ts`, `routes/index.tsx`, `components/{app-shell,require-auth}`
- **Notes:** The second half of the docs/05 §5 build-order-2 slice: a request can now be
  raised, routed, worked and closed with an SLA clock.
  - **State machine (`22` §3)** is owned by `services/request.service.ts` as a transition
    table: every unordered pair not listed returns `409 ILLEGAL_TRANSITION`, terminal
    states have no outgoing edges (R7), and entry to `IN_PROGRESS` requires an assignee,
    while `FULFILLED` requires a fulfilment note and stops the clock.
  - **Reference allocation (`22` §4)** is a single atomic `INSERT … ON CONFLICT DO UPDATE
    … RETURNING` — the first attempt (create, catch the unique violation, update) was wrong
    because a failed statement aborts the surrounding transaction in PostgreSQL, so the
    request was lost; the upsert allocates `REQ-YYYY-NNNNNN` without raising.
  - **Field snapshot (`C3`/R9):** answers are validated against the item's definitions and
    stored with their labels and types, so a later catalog edit cannot rewrite history.
  - **SLA clock (`25` §3–§4):** `helpers/calendar.ts` implements working-hours arithmetic
    in the calendar's zone, excluding holidays, and handling DST by wall clock rather than
    fixed offsets. Target instants are computed at start and **frozen** (§4 example 5).
  - **Read scope (`22` §10):** `own`/`team`/`any` resolved from the read grants and applied
    inside the query; out-of-scope reads return `404`. A new `requireAnyPermission` guard
    and `hasAnyPermission` helper express a capability that is several scoped grants
    (a single-key guard would wrongly exclude agents, who hold `.team` but not `.own`).
  - **Internal notes (`22` §5 R5):** filtered in the SQL query, never post-filtered; a
    requester can neither author nor receive one.
  - **`CONFLICT` (409)** added to the problem-code registry for "exists but not in a
    usable state" (a retired catalog item).
  - **Verified:** backend — format, lint, typecheck, **103 tests** (5 calendar unit tests
    covering the `25` §4 worked examples incl. DST, and 11 request integration tests:
    snapshot + clock start, required-field rejection, distinct references, scope,
    assignment, assignee-before-work, fulfilment note, terminal-state refusal, internal-note
    invisibility, requester internal-note refusal, cancel-own), build; frontend — format,
    lint, typecheck, **18 tests**, build.

### 2026-10-06 — Phase 2 increment 4: Service catalog (F-04) and SLA configuration (F-08 config)
- **Type:** Feature
- **Refs:** `05` §5 (build order 2), `08` §4.4/§4.5, `09` §2, `11` §6/§9, `12`, `21`,
  `25` §2/§4/§11, `31`; `ADR-0002`, `ADR-0008`, `ADR-0012`
- **Affects:** `11` §9; backend — `prisma/schema.prisma` (Category, CatalogItem,
  CatalogItemField, BusinessCalendar, SlaPolicy, SlaTarget, SlaClock; `Priority`,
  `CatalogItemStatus`, `CatalogFieldType`, `SlaCalendarModel`, `SlaClockState`) and
  migration `20261006044821_catalog_and_sla`; `models/{catalog,sla,team}.model.ts`;
  `validators/{catalog,sla}.validators.ts`; `services/{catalog,sla,teams}.service.ts`;
  `controllers/{catalog,sla,teams}.controller.ts`; `routes/{catalog,sla,teams}.routes.ts`;
  `services/platform.service.ts` (seeds tenant SLA defaults); tests; frontend —
  `api/{catalog,sla,teams}.api.ts`, `pages/catalog.page.tsx`, `routes/index.tsx`,
  `components/app-shell.tsx`
- **Notes:** The next vertical slice after the platform spine (docs/05 §5 build order 2:
  the thinnest complete slice that lets work be raised and tracked). Delivered as the
  catalog half of that step; requests follow in the next increment.
  - **Catalog (`21`)** is the intake contract: categories (max three levels, C7), items
    with a lifecycle (`DRAFT → ACTIVE → RETIRED`), and typed field definitions. Rule **C1**
    is enforced in the service: an item cannot be activated without an SLA policy and a
    fulfilment team, so it cannot produce unmeasurable, unowned work. Retirement is a
    status change, never a delete (**C5**), and a non-manager never sees a draft or a
    retired item — it is indistinguishable from absence (404).
  - **SLA configuration (`25` §11)** owns policies, per-priority targets and business
    calendars (working hours or 24×7, per **ADR-0008**). Target instants are stored on the
    clock at start and never recomputed, so a policy edit cannot rewrite history (§4
    example 5); clock mechanics (pause/resume/breach sweep) land with the records that
    carry clocks.
  - **Tenant provisioning** now seeds a default business-hours calendar and policy
    (`seedTenantSlaDefaults`), so a freshly provisioned tenant can satisfy C1 and activate
    catalog items without hand-configuration first.
  - A read-only `GET /teams` was added because the catalog needs a fulfilment-team
    picker; team membership management remains with its own future work.
  - **Verified:** backend — format, lint, typecheck, **87 tests** (8 new integration
    tests: provisioning seeds the default policy, catalog-management permission boundary,
    three-level category bound, draft invisibility, C1 activation guard, activation then
    requester visibility, retirement preserves history, duplicate category), build;
    frontend — format, lint, typecheck, **18 tests** (2 new catalog-page tests), build.

### 2026-10-03 — Tenant user administration: list/invite/deactivate endpoints and screen
- **Type:** Feature
- **Refs:** `06` §11, `07` §3/§5/§6, `11` §6/§9, `12`; `ADR-0002`, `ADR-0012`
- **Affects:** `11` §9; backend (`models/{user,role}.model.ts`, `services/users.service.ts`,
  `services/index.ts`, `controllers/{users,roles}.controller.ts`,
  `routes/{users,roles}.routes.ts`, `routes/index.ts`, tests); frontend
  (`api/users.api.ts`, `pages/users.page.tsx`, `routes/index.tsx`,
  `components/app-shell.tsx`)
- **Notes:** The tenant administrator's user surface, completing the invite/deactivate
  endpoints added in the previous increment.
  - **New read endpoints** required by the screen and already named in the `11` §9
    catalogue: `GET /users` (cursor-paginated, tenant-scoped, roles eager-loaded to avoid
    an N+1) and `GET /roles` (the tenant's assignable roles only — platform roles are
    excluded by the query predicate, `07` §5).
  - **Screen:** lists users with their status and granted roles, invites by email, name
    and role, and deactivates. Deactivating yourself, or an already-inactive user, is
    disabled in the UI and refused by the service.
  - Tenant scope is applied **inside the query** (`ADR-0002`); a platform operator
    receives `403` from all three endpoints (`07` §5).
  - **Verified:** backend — format, lint, typecheck, **79 tests** (3 new integration tests:
    tenant-scoped user list excludes the operator, assignable roles exclude `SUPER_ADMIN`,
    operator refused), build; frontend — format, lint, typecheck, **16 tests**, build.

### 2026-10-03 — Synced charter §27/§28 with `D-9`/`ADR-0012` and recorded the concrete indexes
- **Type:** Docs / Process
- **Refs:** charter §4, §27, §28.2, §29; `09` §2/§3; `00` §7; `42` §3/§6, AD2
- **Affects:** `ServiceHub Enterprise.md`, `docs/09-DATA-INTEGRITY-AND-INDEXING.md`,
  `README.md`, `SECURITY.md`
- **Notes:** `ADR-0012` was accepted on 2026-10-02, but the charter's decision register
  and gate table were never updated, so the master document contradicted `00`/`42`. Fixed:
  - **§27** gains the **`D-9`** row (platform tenancy root, superadmin bootstrap and user
    onboarding → `ADR-0012`); it now records that **all `D-1`–`D-9` are closed**, and the
    proposed-ADR note adds `ADR-0011` alongside `ADR-0009`/`ADR-0010`.
  - **§28.2** Phase 2 entry gate now states `D-6`–`D-9` closed.
  - **§29** acceptance item 3 updated from `D-1`–`D-8` to `D-1`–`D-9`.
  - The charter's status paragraph and technology baseline no longer describe the
    authentication mechanism as the open decision `D-1`; `39` is no longer listed as
    `Draft` (it was approved with Phase 1).
  - Root `README.md` and `SECURITY.md` stale "`D-1` open / eight decisions open" text
    corrected for the same reason.
  - **`09` §2** now lists the concrete identity/platform constraints the migration
    `20261002053425` actually created — `Organization.nameKey`/`slug`, `User.email`,
    `Credential.userId`, `Session`/`PasswordResetToken`/`Invitation.tokenHash`,
    `Role(organizationId,key)`, `Permission.key`, `RolePermission`, `UserRole`, `Team`,
    `TeamMember`, `Outbox`/`JobRecord.idempotencyKey` — with the
    case-insensitive-uniqueness reconciliation (normalised column + plain unique index)
    and the audit append-only **trigger**. `09` §3 adds the matching access patterns
    Q25–Q30.
  - No design contract changed; these are status and traceability corrections (`42` AD2).

### 2026-10-03 — Phase 2 increment 3: shared Redis store for sessions and rate limits
- **Type:** Feature
- **Refs:** `06` §2/§7, `11` §8, `33` §5/§6, `34` §6, `35` §2, `43`;
  `ADR-0001`, `ADR-0003`
- **Affects:** backend (`integrations/redis.ts`, `integrations/rate-limit-store.ts`,
  `services/session-cache.ts`, `services/{auth,users,health}.service.ts`,
  `models/session.model.ts`, `middlewares/rate-limit.ts`, `routes/auth.routes.ts`,
  `config/env.ts`, `server.ts`, `.env.example`, tests); `backend/README.md`
- **Notes:** Completes the shared-store wiring that `ADR-0001`/`ADR-0003` require and the
  prior increment flagged as outstanding.
  - **Session lookups** (`ADR-0001`, `docs/33` §5): a shared Redis read-through cache with
    the `sessions` row as the **durable source of truth**, so any instance resolves a
    session without a database round trip while revocation remains durable (a cache
    flush cannot resurrect a revoked session). Explicit invalidation on logout, password
    reset and deactivation (`docs/33` C3); bounded TTL (`C2`); keyed by the token digest,
    never the token (`C6`); version-tagged entries.
  - **Rate limits** (`ADR-0003`, `docs/33` §6): counters move to shared Redis, so limits
    hold across instances instead of multiplying. Window increment is one atomic Lua
    script (`INCR` + `PEXPIRE`), preventing a counter with no expiry. The credential
    surface **fails closed** (503) and the general surface **fails open with logging**
    during a store outage — the asymmetry `docs/33` §6 mandates.
  - **Degradation** (`docs/33` C4): all Redis access goes through a non-throwing helper
    with a small circuit breaker, so a Redis outage degrades to the database rather than
    failing requests or spiking latency/log volume. Redis is reported by the readiness
    endpoint but, by design, never gates readiness (`docs/34` §6).
  - **Config:** `REDIS_URL` is now **required in production** (it stays optional locally,
    where an in-memory store is used); `SESSION_CACHE_TTL_SECONDS` bounds the cache TTL.
  - **Verified:** format, lint, typecheck, **76 tests** (11 new Redis/shared-store tests:
    cross-instance counter sharing, TTL, store-unreachable degradation, session
    write/read/invalidate, and the fail-open/fail-closed middleware policies), build.
    The identity integration suite was also run with `REDIS_URL` set to confirm the
    cache path end to end. The Redis-backed tests skip cleanly when no server is
    reachable.
  - **Known limitation:** the general application limiter is still keyed per-IP because
    it runs before authentication in the pipeline; per-identity keying for authenticated
    surfaces is a follow-up. The job worker/broker and other cache regions remain
    unwired.

### 2026-10-03 — Phase 2 increment 2: auth/session endpoints, tenant provisioning and the superadmin UI
- **Type:** Feature
- **Refs:** `04` §13, `06` §2–§7/§11, `07` §1–§6, `11` §4/§8/§9, `12`, `29` §3, `31` §3;
  `ADR-0001`, `ADR-0002`, `ADR-0012`
- **Affects:** `11` §9 (platform endpoints added); backend (`config/env.ts`,
  `routes/{auth,platform,users}.routes.ts`, `routes/index.ts`,
  `controllers/{auth,platform,users}.controller.ts`, `middlewares/{authenticate,authorize,csrf}.ts`,
  `helpers/{crypto,cookies,password,session,session-cookies,authorization}.ts`,
  `models/*`, `services/{auth,invitation,platform,users}.ts`,
  `validators/{auth,platform}.validators.ts`, tests); frontend (`api/{client,auth.api,platform.api}.ts`,
  `components/{auth-provider,require-auth,app-shell}.tsx`, `hooks/auth-context.ts`,
  `pages/{login,accept-invitation,superadmin}.page.tsx`, `routes/index.tsx`, `app.tsx`, tests)
- **Notes:** Second Phase 2 increment — the identity/authorization slice built on the
  platform-spine data model, satisfying the “superadmin first” requirement.
  - **Server-side sessions** (`ADR-0001`): opaque token in an `HttpOnly` cookie, only its
    digest stored; idle + absolute windows; immediate revocation on logout, password
    reset and deactivation. CSRF is double-submit (`X-CSRF-Token` compared to the digest
    on the session); state-changing routes fail closed.
  - **Authentication:** uniform failure and timing equalisation so unknown-email and
    wrong-password are indistinguishable (`06` §3); lockout returns `423 ACCOUNT_LOCKED`;
    Argon2id at the `06` §4 floor; entitlements resolved per request (`06` §7).
  - **Provisioning (`ADR-0012`, `04` §13.2):** `POST /platform/organizations` creates the
    tenant, seeds its roles, creates the first administrator INACTIVE, grants the role and
    issues an invitation — all in one transaction. Suspend/activate and the operator
    roster are guarded by `platform:*` permissions.
  - **Onboarding (`06` §11):** invitation issuance and acceptance are separate from
    password reset; the token is single-use and a new invite supersedes outstanding ones.
  - **Tenant users:** `POST /users` (invite) and `POST /users/{id}/deactivate`, guarded by
    `user:manage` **and** tenant scope, enforcing the `07` §5 separation of duties (a
    platform operator has no organization and is refused).
  - **SPA:** the API client attaches `X-CSRF-Token` from the readable cookie to
    state-changing requests; an auth provider reads identity from `GET /auth/me`; a route
    guard; sign-in, invitation-acceptance and **superadmin** (provision / suspend /
    operator roster) pages.
  - **Verified:** backend — format, lint, typecheck, **65 tests** (20 new integration tests
    against real PostgreSQL: uniform failure, lockout, invitation single-use, provisioning
    transaction, separation of duties), build; frontend — format, lint, typecheck, **16
    tests** (new CSRF and route-guard tests), production build.
  - **Known limitation:** the rate limiter and session store remain process-local /
    database-backed; `ADR-0001`/`ADR-0003` call for the shared Redis store, which is not
    yet wired. Templates for the invite/reset emails are queued via the outbox but have no
    delivery worker until `ADR-0006` adapters land.

### 2026-10-02 — Phase 2 build begins: platform-spine data model, seed and superadmin bootstrap
- **Type:** Feature
- **Refs:** `05` (F-01–F-03), `06`, `07`, `08`, `09`, `10` §8, `29` §3, `31` §3.3;
  `ADR-0001`, `ADR-0002`, `ADR-0012`
- **Affects:** `backend/prisma/schema.prisma`, two migrations, `backend/prisma/seed.ts`,
  `backend/prisma/bootstrap-platform-operator.ts`,
  `backend/src/helpers/permission-catalogue.ts`, backend tests
- **Notes:** First Phase 2 implementation increment — the **platform spine slice**,
  built in the `05` order (identity → users/teams → authorization) and satisfying the
  "superadmin first" requirement.
  - **Data model (15 models):** `Organization` (tenant root), `User`, `Credential`,
    `Session`, `PasswordResetToken`, `Invitation`, `Role`, `Permission`,
    `RolePermission`, `UserRole`, `Team`, `TeamMember`, `AuditLog`, `Outbox`,
    `JobRecord` — tenant-scoped, with `organizationId` FK per `ADR-0002`/`ADR-0012`.
  - **Migrations:** `20261002053425_init_identity_authorization_platform`, and
    `20261002054500_audit_append_only_trigger` enforcing audit immutability at the
    database (`31` §3.3) — verified to reject `UPDATE` and `DELETE`.
  - **Seed:** the 39-permission catalogue and the `SUPER_ADMIN` platform role, idempotent
    (`10` §8); tenant roles are seeded per organization at provisioning (`04` §13.2).
  - **Bootstrap:** guarded one-time first platform operator — refuses without an
    environment credential, is a guarded no-op on re-run, and is audited
    (`platform.bootstrap`) — all three behaviours verified.
  - **Tests:** 27 backend tests green (added pagination, authorization and
    permission-catalogue tests).
  - **Follow-up:** the remaining Phase 2 data-model entities (catalog, requests,
    incidents, tasks, SLA, approvals, notifications) and the auth/session endpoints are
    the next increment.

### 2026-10-02 — Accepted `D-9`/`ADR-0012`, unblocking the Phase 2 tenant-scoped data model
- **Type:** Process
- **Refs:** `00` §7–§8, `42` §3/§6, `ADR-0012`
- **Affects:** `00`, `04`, `06`, `07`, `08`, `09`, `10`, `42`
- **Notes:** On owner instruction, **`ADR-0012` was accepted** as recommended option (a)
  (tenant-root `Organization` entity + platform `Super Admin` + in-app provisioning and
  invitation onboarding). Options (b) opaque `organizationId` and (c) external IdP/SCIM
  are rejected/deferred. Every *Proposed* marker placed minutes earlier in the same day's
  draft (`04` §13, `06` §11, `07`, `08`, `10` §8) is now *Accepted*, and the `D-9` register
  rows in `00` §7 and `42` §6 are updated. This **supersedes** the interim "opaque column
  only" position taken during the code audit. The Phase 2 tenant-scoped schema may now be
  implemented. Follow-ups unchanged: sync the master charter §27/§28 and add the concrete
  unique indexes to `09` §2.

### 2026-10-02 — Proposed `D-9`/`ADR-0012` and drafted the missing bootstrap, provisioning and onboarding flows
- **Type:** Docs / Process
- **Refs:** `00` §7–§8, `04` §13, `06` §11, `07` §1–§5/§9, `08` §1–§5, `09` §2, `10` §8,
  `42` §3/§6
- **Affects:** `00`, `04`, `06`, `07`, `08`, `10`, `42`, `43`
- **Notes:** The Phase 2 data model could not be implemented faithfully because **no
  document defined a tenant root, a platform-level operator, or an onboarding flow** —
  `08` §1 requires `organizationId`, `07` §2 defined only tenant-scoped roles, and `10`
  §8 referred to a "first administrator" without naming the creator of its tenant. This
  change **records a proposed decision** and drafts the flows for review; it does **not**
  decide them (`00` R4, `39` A15).
  - **New decision `D-9`** registered in `00` §7 and recorded as **`ADR-0012
    (proposal)`** in `42` §3: recommended option (a) — add an `Organization` tenant-root
    entity and a platform-scoped `Super Admin` role, with in-app tenant provisioning and
    invitation-based onboarding. Options (b) opaque `organizationId` + out-of-band
    provisioning and (c) external IdP/SCIM are recorded and rejected/deferred.
  - `ADR-0012` **supersedes** the interim "opaque column only" position recorded during
    the code audit: `organizationId` becomes a FK to `Organization`.
  - **Drafted, marked PROPOSED:** `04` §13 (end-to-end bootstrap → provision → onboard
    flow), `06` §11 (invitation/onboarding, distinct from password reset), `07` (Super
    Admin role, `platform:*` permissions, scope and separation-of-duties rules), `08`
    (`Organization` and `Invitation` entities; nullable `User.organizationId` for
    operators), `10` §8 (guarded first-**operator** bootstrap + transactional tenant
    provisioning).
  - **Not edited here (follow-up when accepted):** the master charter's decision
    register (§27) and gate lists (§28) mirror `00` §7/`40` and must be synced; `09` §2
    needs the concrete unique indexes for `Organization.slug`/`lower(name)` and
    `Invitation.tokenHash`.
  - **Gate impact:** none. `ADR-0012` is a `Proposal`, so R5 still forbids
    implementation against the affected sections.

### 2026-10-02 — Phase 2 code audit: scaffold aligned to the approved contracts
- **Type:** Fix
- **Refs:** `11` §1/§4/§6/§8, `06` §4/§7, `09` §6, `12` §9, `ADR-0001`, `ADR-0003`,
  `ADR-0006`; `38` §4.1 (a change that contradicts an `Approved` document is a defect)
- **Affects:** `backend/` (`helpers/problem.ts`, `utils/errors.ts`, `utils/pagination.ts`,
  `helpers/authorization.ts`, `middlewares/error-handler.ts`, `middlewares/validate.ts`,
  `middlewares/rate-limit.ts`, `config/env.ts`, `config/index.ts`, `models/index.ts`,
  `app.ts`, `Dockerfile`, tests); `frontend/` (`api/client.ts`, `validators/index.ts`,
  `assets/global.css`, `Dockerfile`, `.env.example`); `docker-compose.yml`
- **Notes:** every backend and frontend check was green before this entry, so the
  findings were latent contract drift rather than failures. Corrected to the approved
  contracts:
  - **Error envelope** now the RFC 7807 `application/problem+json` shape of `11` §4
    (`type`, `title`, `status`, `detail`, `instance`, `code`, `correlationId`,
    `errors[]`), replacing the ad-hoc `{ error: { code, message, details } }` shape.
    **Supersedes** the scaffold envelope.
  - **Error codes** aligned to the `11` §4 registry (`ILLEGAL_TRANSITION`, `DUPLICATE`,
    `VERSION_CONFLICT`, `ACCOUNT_LOCKED`, `INTERNAL`); malformed JSON is now `400
    MALFORMED_REQUEST` per `11` §3 / `12` §9, not `422`.
  - **API base path** is `/api/v1` per `11` §1.
  - **Rate-limit headers** are `RateLimit-Limit/-Remaining/-Reset` per `11` §8.
  - **Argon2id** defaults raised to the `06` §4 floor (memory ≥ 64 MiB, iterations ≥ 3).
  - **Frontend search** uses an opaque cursor, not offset `page`, per `11` §6 / `09` §6.
  - Stale "open decision D-x" comments replaced with the closing ADRs; a `|| true` that
    swallowed `prisma generate` failures removed from the backend Dockerfile; an invalid
    CSS `ring-offset-color` property corrected.
  - Added the model-independent platform-spine primitives `utils/pagination.ts` (cursor
    encode/decode + page builder) and `helpers/authorization.ts` (stage-1 permission
    check), each with tests.
- **Still open (not decided here):** `08`/`ADR-0002` require `organizationId` but no
  document defines an `Organization` tenant root or a platform `Super Admin`, and no
  invitation/onboarding flow exists (`06`, `07`, `10`). The tenant-scoped schema cannot
  be implemented until those are documented and approved.

### 2026-10-01 — Closed D-6–D-8, approved the Phase 2 core documents, met the Phase 2 entry gate
- **Type:** Process / Docs
- **Refs:** `40` §3–§4, §12; `42` §3, §6; `00` §7–§8
- **Affects:** `42` (`ADR-0006`–`ADR-0008`); `01`, `02`, `25`, `29`, `33`, `36`, `37`;
  the approved set `20`, `21`, `22`–`26`, `29`–`31`, `33`–`37`; `00`, `40`, `43`,
  `ServiceHub Enterprise.md`, `README.md`, `CONTRIBUTING.md`
- **Decisions closed:**
  - **D-6 → `ADR-0006`:** Knock for notification orchestration, delivering through
    SendGrid (email) and Twilio (SMS). The outbox in `29` remains the reliability
    boundary; preference storage stays authoritative in ServiceHub.
  - **D-7 → `ADR-0007`:** the SMB v1 baseline = the targets already drafted in `02` C.1
    (availability 99.9%; p95 ≤ 300 ms read; RPO ≤ 5 min, RTO ≤ 2 h; audit ≥ 24 months;
    500 concurrent users / 10,000 registered; 5 M tickets / 20 M audit rows).
  - **D-8 → `ADR-0008`:** per-policy SLA calendar; default business hours with pause
    states.
- **Documents approved (15):** `20`, `21`, `22`–`26`, `29`, `30`, `31`, `33`–`37`. `02`
  moved from `Approved (qualitative)` to full `Approved` now that `D-7` is closed. The set
  is the **Phase 2 core** — it includes `21` Catalog and excludes the Phase 3 documents
  `27`, `28`, `32`.
- **Phase 2 entry gate met** — recorded in `40` §12. **Gate 2 is NOT passed:** its exit
  criteria (the four E2E journeys `37` §7, the security tests `20`, the SLA worked
  examples `25` §4) require a built system and cannot be demonstrated yet.
- **Not approved:** the Phase 3 documents `27`, `28`, `32`, which stay `Draft`.
- **`39` added to and approved with Phase 1:** `docs/00` §3 listed `39` (AI agent
  workflow) as a Phase 1 document, but every gate list wrote “`03`–`19`, `38`” and
  omitted it, so Gate 1 would have passed with a Phase 1 document unchecked. `39` is now
  `Approved` and the Phase 1 gate set is `03`–`19`, `38`, `39` in `40` §2–§3 and charter
  §28.2.
- **Note on `D-7`:** the profile shown for selection was approximate; the authoritative
  numbers are those drafted in `02` Part C, which are stricter on recovery (RPO ≤ 5 min /
  RTO ≤ 2 h, not 15 min / 4 h). `ADR-0007` records the `02` values.
- **Drift fixed in the same change:** decision status in `01` §7, `02` header and Part D,
  `33` §17, the `36`/`37` headers, the `00` §7 register, and the status statements in
  `00` §8, charter §4.4/§29, `README.md` and `CONTRIBUTING.md`.

### 2026-10-01 — Closed D-1–D-5, approved the full Phase 1 design set, passed Gate 1
- **Type:** Process / Docs
- **Refs:** `40` §3–§4, §12; `42` §3, §6; `00` §7–§8; charter §27, §28.2
- **Affects:** `42` (`ADR-0001`–`ADR-0005`); `03`, `06`, `07`, `08`, `09`, `14`, `17`,
  `19`; plus the residual-reference fixes below in `01`, `02`, `11`, `29`, `33`, `34`,
  `35`, `36`, `37`; `00`, `40`, `43`, `ServiceHub Enterprise.md`, `README.md`,
  `CONTRIBUTING.md`
- **Decisions closed** (owners' choices, written as `Accepted` ADRs in `42` §3):
  - **D-1 → `ADR-0001`:** server-side sessions in the shared Redis store, `httpOnly`
    cookie, CSRF token on state-changing requests.
  - **D-2 → `ADR-0002`:** multi-tenant, shared schema; tenant is a mandatory query and
    index dimension.
  - **D-3 → `ADR-0003`:** Redis as cache **and** broker, with PgBouncer as the
    connection pooler.
  - **D-4 → `ADR-0004`:** S3-compatible object storage (cloud).
  - **D-5 → `ADR-0005`:** Kubernetes.
- **Documents approved:** `03`, `06`, `07`, `08`, `09`, `14`, `17`, `19` moved to
  `Approved` (2026-10-01). Each was first updated from “decision open” to the resolved
  choice, per `42` AD2 and AC3, so no approved document describes a decision as open.
- **Gate 1 passed:** recorded in the gate log (`40` §12) — every document in `03`–`19`,
  `38` is `Approved`, `D-1`–`D-5` are closed by ADR, and no implementation exists to
  drift from the contracts.
- **Still open:** `D-6` (blocks `29`), `D-7` (blocks `02`'s quantified targets, `36`,
  `37`), `D-8` (blocks `25`). Passing Gate 1 does not approve any Phase 2 document; the
  Phase 2 entry gate still requires `20`–`37` to be `Approved`.
- **Drift fixed in the same change:** status statements in `00` §8, charter §4.4 and
  §29, `README.md` and `CONTRIBUTING.md` now state the full Phase 1 approval and the
  passed gate rather than a mixed state.
- **Residual open-decision references cleaned up:** closing a decision leaves every
  other mention of it stale, so the whole set was swept. The most serious finds were in
  `01` §7 — its decision table recorded **D-2 as “single-tenant per deployment”** and
  **D-5 as “Docker Compose for dev; TBD for prod”**, both directly contrary to the
  chosen answers — and in `18`, where the CSRF mitigation, assumption A5 and accepted
  risk R2 all assumed single-tenant. Both are corrected. Tables and pointers were also
  updated in `02` Part D, `11` §8, `29`, `33`, `34`, `35`, `36`, `37` and `03`. No
  design contract changed; these are status/pointer corrections required by `42` AD2.
- **`01` and `02` were touched although Phase 0 is approved:** the corrections are
  decision-status pointers, not contract changes; they remain `Approved`.
- **Supersedes:** the “Approved the ten unblocked Phase 1 design documents” entry below;
  the remaining eight are now approved and Gate 1 is passed.

### 2026-10-01 — Approved the ten unblocked Phase 1 design documents
- **Type:** Process / Docs
- **Refs:** `40` §2–§3 (Gate 1), `00` §7–§8; D-1–D-5
- **Affects:** `04`, `05`, `10`, `11`, `12`, `13`, `15`, `16`, `18`, `38`; `00`, `43`,
  `ServiceHub Enterprise.md`, `README.md`, `CONTRIBUTING.md`
- **Notes:** With the review complete, the ten Phase 1 documents that **no** open
  decision blocks were moved to `Approved` (approval date in each header): `04`, `05`,
  `10`, `11`, `12`, `13`, `15`, `16`, `18`, `38`.
- **The eight blocked documents were deliberately not approved.** `03`, `06`, `07`,
  `08`, `09`, `14`, `17`, `19` stay `Draft` because their blocking decisions remain open
  (`D-1`→`06`/`14`/`17`, `D-2`→`07`/`08`/`09`, `D-3`+`D-5`→`03`, `D-4`→`19`). Gate 1
  (`40` §3) requires `D-1`–`D-5` closed before they can be approved; approving them now
  would contradict the register in §7.
- **Gate status:** **Gate 1 is not passed.** The full Phase 1 set is approved only once
  the remaining eight reach `Approved` after `D-1`–`D-5` close.
- **Drift fixed in the same change:** the status statements in `00` §8, charter §4.4 and
  §29, `README.md` and `CONTRIBUTING.md` now describe the mixed Phase 1 state rather
  than claiming the whole set is `Draft`.
- **Supersedes:** the “Not yet approved” note in the 2026-10-01 review entry below,
  which stated the whole Phase 1 set stays `Draft`; ten of those documents are now
  `Approved`.

### 2026-10-01 — Reconciled the Phase 1 design set against the charter
- **Type:** Docs / Process
- **Refs:** `00` §3, §7; `03`–`19`, `38`; `40` §2–§3; `42` §3; charter §27, §28.2
- **Affects:** `00`, `01`, `02`, `03`, `05`, `09`, `16`, `17`, `18`, `35`, `36`, `38`,
  `40`, `42`, `ServiceHub Enterprise.md`
- **Notes:** A pre-approval review of the Gate 1 design documents (`03`–`19`, `38`)
  against the charter found and fixed the following inconsistencies:
  1. **Decision-block drift.** `09` and `17` did not declare the decisions that block
     them (`09`→`D-2`, `17`→`D-1`) although the register does; and `03` claimed `D-2`
     blocked it although the register does not. The two missing declarations were
     added and the extra one removed, so every document that a decision blocks now
     matches the register in charter §27 and `00` §7. The same sweep caught `35`
     (missing its `D-3` declaration) and `36` (missing `D-4`/`D-5`/`D-7`); both are
     now aligned. Every document in the set declares exactly the decisions the
     register assigns to it, and no others.
  2. **`00` §7 vs the charter.** The `D-3`, `D-4`, `D-5` and `D-7` block lists in `00`
     §7 were out of sync with charter §27 (missing `35`/`36`). They now match exactly,
     and `42` ADR-0003 no longer lists `37` (which the register assigns to `D-7`).
  3. **Phase assignment for KB and assets.** `00` §3 and `05` §1 put Knowledge Base
     (`27`) and Asset Management (`28`) in Phase 2, but charter §28.2 and `40` §3 place
     them in Phase 3. Both documents are corrected to Phase 3.
  4. **`40` §2 table.** The Phase 3 exit milestone listed notifications, reporting and
     observability, which §3 assigns to Phase 2. It now reads “KB, assets, integrations,
     advanced reporting live”, matching §3 and the charter.
  5. **Repositories vs the mandated structure.** `03` and `38` described a
     `repositories` layer, but the charter's fixed `backend/src/` has no such directory.
     Both now state explicitly that the repository (persistence) layer is the mandated
     `models/` directory — the same resolution the scaffold records in `backend/README`.
  6. **Dangling ADR.** `01`, `02` and `18` cited a non-existent `ADR-001` for the CMDB
     out-of-scope decision. The decision is now recorded as `ADR-0011` in `42` §3 and
     all three references point to it.
  7. **Broken cross-reference.** The charter §23.2 queue/broker row cited `15` (the
     design system); it now cites `03` §6 (the asynchronous tier).
  8. **Typo.** `16` §11 “Clock structure” → “Structure”.
- **Not changed:** no design contract was altered; only cross-references, decision
  declarations and phase assignments were reconciled. `03`–`19` and `38` remain
  `Draft` pending `D-1`–`D-5` closure and owner sign-off at Gate 1.

### 2026-10-01 — Approved the Phase 0 document set
- **Type:** Process / Docs
- **Refs:** `40` §2–§4, `00` §6–§8; D-7 (`00` §7)
- **Affects:** `01`, `02`, `40`, `41`, `42`, `43`
- **Notes:** Phase 0's entry gate set (`00`, `01`, `02`, `40`, `41`, `42`, `43`) was
  moved to `Approved` by its owners and reviewers, with the approval date recorded in
  each header. `00` was already `Approved for execution`. Phase 0's exit criteria
  (`01`, `02`, `41` approved; D-list owned) are now met.
- **`02` is approved qualitatively, not wholly:** Parts A and B and the qualitative
  statements of Part C carry `Approved (qualitative)`. The **quantified** NFR targets
  in Part C remain open under **D-7** and are not pass/fail until D-7 is closed by an
  ADR in `42`. This is the split allowed by `40` §2, not a silent deferral.
- **Not yet approved:** the Phase 1 design set (`03`–`19`, `38`) stays `Draft`;
  Gate 1 also requires **D-1**–**D-5** closed by ADR before those documents can be
  approved (`40` §3). Feature build remains blocked.

### 2026-09-27 — Scaffolded `frontend/` and `backend/` from the charter
- **Type:** Process / Docs
- **Refs:** `ServiceHub Enterprise.md` §3, §22–§23; `03`, `13`, `14`, `35`, `38`
- **Affects:** the repository root, `frontend/`, `backend/`
- **Notes:** Created the runnable project skeleton from the mandated structure and the
  technology baseline: root `README`/`SECURITY`/`CONTRIBUTING`/`CHANGELOG`/`LICENSE`,
  `.gitignore`, `docker-compose.yml` (Postgres, Redis, mail catcher, both apps) and a CI
  pipeline implementing the `docs/35` §4 stages. Both `src/` trees match the charter
  exactly; no mandated path was added, renamed or removed.
- **Two structure conflicts were resolved in code, not silently:**
  1. `docs/03` names a repositories layer but the mandated `backend/src/` has no
     `repositories/` directory. Data access therefore lives in the mandated `models/`
     folder, and the ESLint boundary rules prevent controllers from importing it. The
     mapping is stated in `backend/README.md`.
  2. The frontend test location is applied as decided in charter §3.1 (co-located unit
     tests, E2E in `frontend/tests/`).
- **Scaffold limitations are stated rather than hidden** (`backend/README.md`): the rate
  limiter counts in process memory and is therefore incorrect across instances until
  **D-3** supplies a shared store; there is no cache client and no worker process until
  **D-3**; there is no authentication middleware until **D-1**; provider adapters report
  "not configured" until **D-6**; and the Prisma schema carries the datasource and
  generator only, because `docs/08` is not yet `Approved`.
- **Gate note:** the scaffold is tooling, configuration and a health-check skeleton. It
  implements **no domain feature**, so it does not pass ahead of the phase gates in
  `docs/40`. Feature code begins in phase 2.
- **Verified:** backend — format, lint, typecheck, 9 tests, build; frontend — format,
  lint, typecheck, 7 tests, production build.

### 2026-09-27 — Updated the ServiceHub charter to version 2.0
- **Type:** Docs / Process
- **Refs:** `CR-0001`, `ServiceHub Enterprise.md`, `00-DOCUMENTATION-PLAN.md`
- **Affects:** `ServiceHub Enterprise.md` (charter), `00`
- **Notes:** The master charter was updated in place. §4 now presents the 44-document
  set instead of the superseded 106, with the consolidation rationale and the `00`–`105`
  coverage pointer. Four defects were fixed: (1) five components the production
  architecture silently depended on — cache, queue, connection pooler, object storage
  and orchestrator — are now named in the technology baseline (§23.2) as open decisions
  **D-3**/**D-4**/**D-5**; (2) "session/token-based authentication" is now marked as the
  open decision **D-1** rather than stated as a decision; (3) the frontend test-location
  contradiction is resolved in §3.1 without changing the mandated `src/` structure; (4)
  the charter's eight features and their actors are now stated (§1.1, §1.2) where
  version 1.0 defined no domain scope at all. Two sections were added: the **Open
  Decisions Register** (§27) and **Governance, Gates and Change Control** (§28), which
  makes the `APPROVE → IMPLEMENT` gate mechanical and reconciles it with the iterative
  agent workflow. Section numbering for §3 (structure) and §4 (documentation) is
  preserved so existing cross-references remain valid.
- **Supersedes:** version 1.0 of the charter. `00` no longer claims to supersede the
  charter's §4; the charter now agrees with the plan.

### 2026-09-27 — Reorganised the documentation set from 106 documents to 44 with named ownership
- **Type:** Docs / Process
- **Refs:** `CR-0001`, `00-DOCUMENTATION-PLAN.md`
- **Affects:** the whole `docs/` set
- **Notes:** The original 106-document plan defined every topic by *viewpoint* —
  a `REQUIREMENTS`, an `ARCHITECTURE`, a `FLOW`, often a `SECURITY` doc — so the same
  fact lived in three to five files and could silently drift. The set was reorganised by
  **ownership boundary and lifecycle** so each artifact has exactly one home (rule R1).
  The complete coverage map in `00` §5 accounts for every original number `00`–`105`;
  the two duplicate security-testing documents (`52`, `80`) collapse into `20`. Six
  view-split documents were divided with a stated split rule (`00` §4) so no content is
  duplicated. Two contradictions in the charter were resolved: (a) `APPROVE →
  IMPLEMENT` gating combined with iterative agent execution is reconciled as **gated
  phases with per-phase iteration** (`40` §1); (b) the frontend test-location ambiguity
  is resolved in `38` §3 without altering the mandated folder structure. Nine
  previously-unstated dependencies (cache, queue, object storage, orchestrator,
  providers, tenancy, auth mechanism, quantified targets, SLA calendar) are now
  explicit open decisions `D-1`…`D-8` with owners (`00` §7), instantiated as ADRs
  `ADR-0001`…`ADR-0010` in `42` §3.
- **Supersedes:** the 106-document Documentation Architecture in the ServiceHub charter §4.

### 2026-09-27 — Authored documents 01–26 against the new plan
- **Type:** Docs
- **Refs:** `00-DOCUMENTATION-PLAN.md` §3
- **Affects:** `01`–`26`
- **Notes:** Foundation, requirements, architecture spine, workflows, feature map,
  identity/authz, data model and integrity, migrations, API contract, validation,
  backend/frontend architecture, design system, UI/UX, security architecture and threat
  model, data protection, security testing, and the domain features (catalog, requests,
  incidents, tasks, SLA, approvals). SLA semantics (`25`) records the DST, pause and
  freeze rules that make attainment reproducible; the `SLA` document is the product's
  stated hardest correctness problem.

### 2026-09-27 — Completed the documentation set (27–43)
- **Type:** Docs
- **Refs:** `00-DOCUMENTATION-PLAN.md` §3
- **Affects:** `27`–`43`
- **Notes:** Knowledge base, assets, notifications, search/reporting, audit, integrations,
  scalability/DB protection, observability, deployment/CI-CD, operations/recovery,
  testing, code quality, the AI-agent workflow, the implementation plan and phase gates,
  the Definition of Done, and the ADR/CR register. With these, all 44 documents in the
  plan exist and every `00`–`105` original has a home.

## 4. Product Changelog

Once implementation begins (Phase 2, `40` §3), product releases are recorded here under
version headings. Until then, this section is populated only with what actually exists —
never with speculative entries.

```
## [Unreleased]
- Repository scaffold: mandated structure, tooling, configuration, health-check
  skeleton, CI pipeline and local compose stack.
- Identity slice (`ADR-0001`, `ADR-0012`): server-side sessions, login/logout, password
  reset, invitation acceptance, tenant provisioning, tenant user administration, and the
  SPA sign-in / invitation-acceptance / superadmin screens.
- Shared Redis store (`ADR-0001`, `ADR-0003`): session lookup cache and cross-instance
  rate-limit counters, with graceful degradation and a fail-closed credential surface.
  Backend tests: 76.
- (feature lines appear as they land; each links to its CR/ADR and its tests)
```

## 5. How Entries Are Produced

| Change | Changelog required |
|---|---|
| ADR accepted | Yes — under Documentation, linking the ADR |
| CR approved and implemented | Yes — linking the CR |
| A document reaching `Approved` | Yes — a one-line entry |
| A document superseded | Yes — with a **Supersedes** line pointing to the successor |
| Feature/fix/security/perf change in code | Yes — product entry |
| Refactor with no behaviour change | Optional, only if externally relevant |

## 6. Acceptance Criteria

1. Every ADR and CR has a corresponding changelog entry.
2. Entries are appended in real time; none is reconstructed retrospectively.
3. Superseded statements are marked, never deleted.
4. The documentation changelog reflects the actual `docs/` set — an entry without a
   matching document is a defect.
5. Product entries begin only when implementation begins; the section is not
   pre-populated with speculation.

## 7. Related

- `00-DOCUMENTATION-PLAN.md` — the plan this changelog records the execution of
- `42-ADRS-AND-CHANGE-REQUESTS.md` — the register entries link here
- `40-IMPLEMENTATION-PLAN-AND-PHASES.md` — when product changes begin
- `41-DEFINITION-OF-DONE.md` — the gate a changelogged change has passed
