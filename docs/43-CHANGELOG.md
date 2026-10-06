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
