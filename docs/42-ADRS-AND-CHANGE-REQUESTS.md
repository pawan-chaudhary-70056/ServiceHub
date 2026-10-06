# 42 — ADRs and Change Requests

**Status:** Approved · **Owner:** Tech Lead · **Reviewers:** All leads · **Approved:** 2026-10-01
**Consolidates:** old 103, 104 (architecture decision records, change requests)

> **Scope:** how decisions are recorded and how changes to approved scope are requested
> and tracked. **The open decisions currently blocking approval** are listed in `00` §7
> and instantiated as ADRs here. **What "done" means** is `41`.

---

## 1. Why This Document Exists

Two failure modes make a project's history unreadable:

- **Decisions made in conversation.** Three months later nobody knows why the system
  uses sessions instead of tokens, and the "obvious fix" reintroduces the problem the
  decision avoided.
- **Scope changed by implication.** A requirement quietly drifts because a change was
  made in code and the document was never updated. Both the document and the code now
  lie.

ADRs fix the first; Change Requests fix the second. Together they are what makes the
rule "code that contradicts an `Approved` document is a defect" (`00` R5) enforceable.

## 2. Architecture Decision Records (ADRs)

### 2.1 When an ADR is required

- Any `D-1`…`D-8` decision is closed.
- A choice between materially different technical approaches with lasting cost.
- A deviation from an `Approved` document.
- A performance change justified by measurement (`33` §1).
- Adding or removing a significant dependency, datastore, or external service.
- Any decision a future contributor would otherwise have to re-derive.

### 2.2 ADR shape

```
ADR-NNNN — <short title>
Status:    Proposed | Accepted | Superseded by ADR-MMMM | Rejected
Date:
Owner:
Deciders:

Context      — the forces at play; what makes this a decision at all
Decision     — what was chosen, stated affirmatively
Consequences — what becomes easy, what becomes hard, what is now forbidden
Alternatives — the options considered and why each was not chosen
Affects      — documents and modules this changes
```

**The "Alternatives" section is mandatory.** An ADR without alternatives records an
assertion, not a decision, and gives a future reader nothing to argue against.

### 2.3 Rules

| # | Rule |
|---|---|
| AD1 | ADRs are immutable once `Accepted`; a reversal is a superseding ADR, never an edit |
| AD2 | An ADR that changes an `Approved` document updates that document in the same change |
| AD3 | ADRs are numbered sequentially and never renumbered |
| AD4 | A decision made without an ADR that meets §2.1 is retroactively an ADR or a defect |
| AD5 | Each ADR names the documents it affects so dependencies are traceable |

## 3. The Open Decisions as ADRs

These are the decisions the documentation plan (`00` §7) marks as blocking document
approval. Per `00` R4 and `39` A15, none is silently resolved on the agent's behalf —
each requires its owner to decide. **`D-1`–`D-8` are all closed** (`Accepted`,
2026-10-01): `D-1`–`D-5` by Gate 1, `D-6`–`D-8` before the Phase 2 entry gate. A new
decision, **`D-9`** (platform tenancy root, superadmin bootstrap and user onboarding),
is recorded below as **`ADR-0012`** and was **`Accepted`** on 2026-10-02, so the
documents it governs may now be implemented (`00` R5).

### ADR-0001 (accepted) — Authentication mechanism · **D-1**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** Security Lead · **Deciders:** Security Lead, Tech Lead
- **Context:** The charter said "session/token-based", which is two mechanisms. The
  choice changes CSRF exposure, revocation, horizontal-scaling storage, and documents
  `06`, `08`, `11`, `14`, `17`.
- **Options:** (a) Server-side sessions in a shared store (revocable, CSRF-aware);
  (b) stateless signed tokens (no shared store, hard revocation, needs a refresh
  strategy); (c) hybrid (short-lived access token + server-side refresh).
- **Decision:** **(a) Server-side sessions**, stored in the shared Redis instance
  (`ADR-0003`), delivered in an `httpOnly`, `Secure`, `SameSite=Lax` cookie, with a CSRF
  token required on state-changing requests. Chosen for **immediate revocation**: `FR-USER-001`
  requires that deactivation and password change kill live sessions, which stateless
  tokens provide only via a denylist.
- **Consequences:** the session store must be shared and highly available, and a cache
  outage must degrade sessions gracefully rather than invalidate them; every
  state-changing request needs CSRF protection; `08` gains a `Session` table; `14`
  sends credentials and the CSRF token; `17` retains its cookie-based CSRF/CORS controls.
  Stateless tokens are rejected because they trade away prompt revocation for a store
  the platform already runs.
- **Affects:** `06`, `08`, `11`, `14`, `17`.

### ADR-0002 (accepted) — Tenancy model · **D-2**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** Tech Lead · **Deciders:** Tech Lead, Security Lead
- **Context:** `organizationId` appears on scoped tables (`08` §1) but single- vs
  multi-tenant was undecided. Affects authorization (`07`), the data model (`08`),
  indexes (`09`), cache keys (`33` C5), and every query's scoping predicate.
- **Options:** (a) Single-tenant (simpler; the column is futureproofing); (b)
  multi-tenant shared schema (every query scoped; row-level security possible); (c)
  schema-per-tenant (isolation; heavier operations).
- **Decision:** **(b) Multi-tenant, shared schema.** `organizationId` is a mandatory
  dimension of every tenant-scoped table, every scope predicate, and every index prefix;
  stage 2 of the `07` §1 authorization model is the tenant check.
- **Consequences:** every query must carry a tenant predicate, applied inside the query
  in `models/` and lint-/review-checked; a missing predicate is a cross-tenant leak and
  is a mandatory negative test (`20`, `37`); cache keys include the tenant (`33` C5);
  row-level security is available as defence in depth. Chosen over schema-per-tenant to
  avoid per-tenant migration and operational overhead, and over single-tenant because
  the product is sold to multiple organisations.
- **Affects:** `07`, `08`, `09`, `33`.

### ADR-0003 (accepted) — Cache, queue broker and pooler · **D-3**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** Tech Lead · **Deciders:** Tech Lead, DevOps
- **Context:** The architecture depends on a cache and a queue (`03` §6) that the
  technology baseline never named, and on a connection pooler (`33` §4). The async tier
  cannot be built without them.
- **Options:** (a) Redis as both cache and broker, PgBouncer pooler; (b) Redis cache +
  a dedicated broker; (c) managed cache/broker; (d) database-backed queue for low volume.
- **Decision:** **(a) Redis** (cache + job broker) with **PgBouncer** as the connection
  pooler in front of PostgreSQL. Kept to the fewest components that satisfy both the
  cache regions (`33` §5) and the async tier (`03` §6), and that the platform already
  runs for sessions (`ADR-0001`).
- **Consequences:** the async tier depends on Redis availability and must provide
  at-least-once delivery with idempotent consumers and a dead-letter path (`03` §6);
  the pool budget is arithmetic — `instances × pool size + workers ≤ Postgres budget −
  reserve`; sessions and cache share Redis, so key namespaces must not collide.
- **Affects:** `03`, `33`, `35`.

### ADR-0004 (accepted) — File storage backend · **D-4**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** DevOps · **Deciders:** DevOps, Security Lead
- **Context:** Backends must be stateless (`03` §7), so files cannot live on local disk.
- **Options:** (a) S3-compatible object storage (cloud); (b) self-hosted S3-compatible
  (MinIO) on-premise; (c) database large objects (discouraged).
- **Decision:** **(a) S3-compatible object storage** (cloud). Backends keep no file
  bytes; uploads are server-keyed and served via short-lived signed URLs (`19` §7.3).
- **Consequences:** object storage becomes a runtime dependency and a security boundary
  — signed-URL policy and bucket access control are the controls (`18` A6); backups and
  DR must cover the bucket (`36`); self-hosted storage is deferred until an on-premise
  requirement appears, and database large objects are rejected for bloating backups.
- **Affects:** `19`, `36`.

### ADR-0005 (accepted) — Production orchestrator · **D-5**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** DevOps · **Deciders:** DevOps, Tech Lead
- **Context:** The deployment topology is orchestrator-independent but health probes,
  secret injection and rolling deploys are not.
- **Options:** (a) Kubernetes; (b) a container platform (e.g. ECS/Cloud Run-style);
  (c) Docker Compose on a VM (small scale).
- **Decision:** **(a) Kubernetes.** It provides readiness/liveness probes, rolling
  deploys and runtime secret injection, which `35` and `36` depend on.
- **Consequences:** pods must implement the liveness-vs-readiness rule (`34` §6 —
  liveness must not check the database, or a blip restarts every pod); secrets are
  injected from a managed store, never baked into the image; the deployment topology in
  `03` §7 is orchestrator-neutral and remains valid. Chosen over managed platforms for
  control of probes and secrets; Docker Compose is rejected for production as it lacks
  rolling deploys and self-healing.
- **Affects:** `03`, `35`, `36`.

### ADR-0006 (accepted) — Email/SMS provider · **D-6**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** Backend Lead · **Deciders:** Backend Lead, Tech Lead
- **Context:** Notifications (`29`) need transactional email and SMS. The platform
  already owns the reliability boundary (transactional outbox + delivery records) and
  the preference model (`29` §3), so the decision is whether to add an orchestration
  layer and which delivery providers to connect.
- **Options:** (a) a direct transactional provider (e.g. MailerSend, email + SMS);
  (b) **Knock** as an orchestration layer delivering through SendGrid (email) and
  Twilio (SMS); (c) separate best-in-class providers per channel.
- **Decision:** **(b) Knock** for notification orchestration, delivering through
  **SendGrid** (email) and **Twilio** (SMS).
- **Consequences:** Knock owns templates, channel fan-out and channel-level delivery;
  ServiceHub's **outbox remains the reliability boundary** (`29` §3) — a domain event
  is enqueued and the outbox drain calls Knock, so a provider outage still cannot roll
  back a business change. The overlap with `29`'s own preference model is resolved by
  keeping preference storage **authoritative in ServiceHub** and sending Knock the
  resolved decision, not the raw preference. Knock, SendGrid and Twilio become runtime
  dependencies with delivery webhooks for bounce/complaint handling.
- **Affects:** `29`.

### ADR-0007 (accepted) — Quantified non-functional targets · **D-7**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** Product Lead · **Deciders:** Product Lead, Tech Lead
- **Context:** `02` and `37` cannot pass/fail performance, and `36` cannot size backup
  and DR, without numbers.
- **Options:** (a) **SMB v1 baseline**; (b) stricter production targets.
- **Decision:** **(a) the SMB v1 baseline drafted in `02` Part C** — availability
  **99.9% per month** (business hours); API read **p95 ≤ 300 ms**, write **p95 ≤ 500 ms**;
  **RPO ≤ 5 min**, **RTO ≤ 2 h**; audit retention **≥ 24 months**; design concurrency
  **500 concurrent users / 10,000 registered users**; data-volume horizon **5 M tickets /
  500 K assets / 20 M audit rows**.
- **Consequences:** these are the exact targets in `02` C.1, now retitled from “proposed”
  to approved; they become pass/fail in `37`'s performance suite and drive the backup
  cadence in `36`. They are a baseline to be revisited by a superseding ADR once
  production measurements exist, per `33` §1 (scale by measurement).
- **Affects:** `02` (Part C), `36`, `37`.

### ADR-0008 (accepted) — SLA calendar and pause semantics · **D-8**
- **Status:** Accepted · **Date:** 2026-10-01 · **Owner:** Product Lead · **Deciders:** Product Lead, Tech Lead
- **Context:** Working-hours vs 24×7 and the pause model change every reported figure
  (`25` §4).
- **Options:** (a) Working hours only; (b) 24×7 only; (c) **per-policy choice**.
- **Decision:** **(c) per-policy choice.** Each `SlaPolicy` selects a business calendar
  (working hours, holidays, time zone) **or** 24×7; the **default is business hours with
  pause states** (`25` §4). Paused intervals are excluded from elapsed time exactly once.
- **Consequences:** the calendar is a per-policy attribute resolved at clock start;
  reporting must state which calendar was used or figures are not comparable; the pause
  states are defined per policy and must be unambiguous, because an ambiguous pause
  state silently distorts attainment.
- **Affects:** `25`.

### ADR-0009 (proposal) — Search technology for v1
- **Context:** `30` §2.2 recommends PostgreSQL full-text search over an external index.
- **Options:** (a) PostgreSQL FTS; (b) external index (Elasticsearch/OpenSearch).
- **Decision:** `30` recommends (a) for v1 with a stated threshold for revisiting
  (`30` §2.6). Recorded here as **Proposed** because the choice has lasting cost.

### ADR-0010 (proposal) — Frontend test location
- **Context:** The charter's `frontend/` structure has no test directory, yet Vitest/RTL
  are mandated (flagged in `00` and `38` §3).
- **Options:** (a) Co-located `*.test.tsx`; (b) a `frontend/tests/` directory; (c) both.
- **Decision:** `38` §3 records (a)/(c) without changing the mandated structure.
  **Proposed** for formal acceptance.

### ADR-0011 (proposal) — CMDB relationship modelling out of scope for v1
- **Context:** The asset register (`28`) tracks assets and assignments, but the full
  CMDB relationship graph and impact analysis are excluded from v1 (`01` §4, `02`
  B.14). The exclusion is cited as `ADR-0011` across `01`, `02` and `18`; the earlier
  three-digit citation `ADR-001` was a dangling reference and is corrected.
- **Options:** (a) Exclude CMDB relationships from v1 (recommended — reduces attack
  surface and modelling cost); (b) include the full relationship graph; (c) include
  relationships without impact analysis.
- **Decision:** *Open — but `02` records (a) as `Won't`.* **Owner:** Product Lead.
  **Affects:** `01`, `02`, `18`, `28`.

### ADR-0012 (accepted) — Platform tenancy root, superadmin bootstrap and user onboarding · **D-9**
- **Status:** Accepted · **Date:** 2026-10-02 · **Owner:** Tech Lead · **Deciders:** Tech Lead, Security Lead, Product Lead
- **Context:** `ADR-0002` chose a multi-tenant shared schema and `08` §1 requires
  `organizationId` on every tenant-scoped table — but **no document defines an
  `Organization` (tenant root) entity**, and `07` §2 defines only tenant-scoped roles,
  so nothing can create a tenant. `10` §8 refers to a "first administrator" without
  saying who created the tenant that administrator belongs to. There is also **no
  registration or invitation flow**: `FR-AUTH-001` assumes a *registered* active user,
  and the only documented credential-setting path is password **reset** (`06` §5). The
  platform therefore has no defined beginning — empty database → first privileged
  identity → tenant → first tenant administrator → first users is unspecified. This is
  the gap that blocks the Phase 2 data model.
- **Options:**
  - (a) **Tenant-root entity + platform operator role + in-app provisioning and
    invitation.** `Organization` becomes a real table, a platform-scoped `Super Admin`
    creates tenants, provisioning seeds each tenant's reference data, and users are
    onboarded by invitation.
  - (b) **Opaque `organizationId`, out-of-band provisioning.** No tenant table; DevOps
    creates `organizationId` values and first administrators directly; no in-app tenant
    creation.
  - (c) **External identity provider / SCIM.** Tenants and users are provisioned by an
    external IdP; ServiceHub only consumes them — deferred, because `FR-INTEG-003` is
    *Could* and v1 does no auto-provisioning.
- **Decision:** **(a) is recommended.** The product is explicitly multi-tenant
  (`ADR-0002`) and sold to multiple organisations; provisioning and onboarding are
  product capabilities, not deployment accidents, and option (b) leaves tenant creation
  as an unaudited, non-reproducible manual step that cannot seed reference data
  reliably. This **supersedes** the interim "opaque column only" position recorded
  during the code audit: `organizationId` becomes a foreign key to `Organization`. The
  decision was **accepted 2026-10-02** on owner instruction, after review of the drafted
  flows (`00` R4, `39` A15): it introduces schema and a new role class, and the owner has
  decided it rather than leaving it open.
- **Consequences (if accepted):**
  - `08` gains `Organization` and `Invitation` entities; `User.organizationId` becomes a
    **nullable** FK, where null means a platform operator with no tenant membership.
  - `07` gains a platform-scoped `Super Admin` role with least-privilege platform
    permissions. The platform operator cannot approve or administer tenant records by
    default; the tenant `Administrator` cannot provision tenants.
  - `06` gains an invitation/onboarding flow that is **distinct from reset**: an
    invitation *establishes* the first credential; a reset *replaces* one.
  - `10` §8's bootstrap becomes "first **platform operator**" (guarded, audited),
    followed by tenant provisioning, which seeds the tenant's default roles and baseline
    configuration in one transaction.
  - `04` gains the end-to-end bootstrap → provision → onboard flow.
  - Every tenant-scoped query still carries the mandatory tenant predicate; the operator
    role does not weaken it and has no blanket cross-tenant data access.
- **Affects:** `00` (§7), `04`, `06`, `07`, `08`, `09`, `10`, `42`.
- **Decision recorded:** accepted as recommended **(a)** on 2026-10-02 (owner). Options
  (b) and (c) are rejected/deferred as described above. A reversal is a superseding ADR,
  never an edit (`42` AD1).

## 4. Change Requests (CRs)

### 4.1 When a CR is required

A CR is raised when a change alters **what** the system does or **what was approved**:

- A requirement in `02` is added, removed, or changed.
- An `Approved` document's contract changes materially.
- Scope moves between phases (`40`).
- A public API shape changes incompatibly (`11`).
- A security control is weakened, even temporarily.

A change that only affects how something is implemented, within an `Approved` contract,
does not need a CR — it needs a PR.

### 4.2 CR shape

```
CR-NNNN — <short title>
Status:    Draft | In Review | Approved | Rejected | Implemented | Withdrawn
Raised by:            Date:
Type:      Requirement | Contract | Scope | API-break | Security

What changes       — the specific change, stated precisely
Why                — the driver (user need, defect, regulation, measurement)
Impact             — documents affected, code modules, effort, risk, data migration
Alternatives       — including "do nothing"
Decision & approvers
Implementation     — the PRs / ADRs that realise it
```

### 4.3 Rules

| # | Rule |
|---|---|
| CR1 | A CR updates every `Approved` document it affects, in the same change |
| CR2 | An approved CR supersedes the prior statement; the prior statement is marked `Superseded`, not deleted |
| CR3 | A CR weakening a security control requires the Security Lead's approval and an ADR |
| CR4 | A CR affecting a public API requires a deprecation plan, not an immediate break |
| CR5 | The CR log is append-only and lives in `43` |
| CR6 | A CR that changes scope re-evaluates the phase gate it affects (`40`) |

### 4.4 CR-0002 — Interim search implementation (v1)

- **Status:** Withdrawn, 2026-10-06 — the deviating change was **not** taken; PostgreSQL FTS
  (`30` §2.2) was implemented directly in the same increment, so no interim approach exists
  and `30` is not contradicted. The record is retained per CR5 (append-only log).
- **Raised by:** Implementation, 2026-10-06 · **Type:** Contract / deviation from an
  `Approved` document (`42` §4.1, AD4)

**What changes.** `30` §2.2 mandates PostgreSQL full-text search (`tsvector` + `tsquery` +
GIN) as the v1 search technology. The v1 implementation of `GET /search` (`F-13`) instead
filters each source with a **scoped, case-insensitive pattern match applied in SQL** and
ranks the bounded candidate set in the service. It satisfies the security core of `30`
§2.3 — **S1** visibility is a SQL predicate applied before ranking and before pagination,
and **S2** the order is filter → rank → paginate — but it is **not** the FTS the document
names, and no FTS index exists yet (`30` §2.5 requires every filter to map to an indexed
column or be rejected).

**Why.** Deliver build-order 7 of `05` §5 (search/reporting) to a working,
permission-scoped state without blocking on the FTS index migration. The risk the document
is most concerned with (the authorization leak, §2.3) is guarded; the FTS index is a
performance/fidelity improvement that is safer to land with its own migration and a
measurement.

**Impact.** `30` §2.2 and §2.5 are not yet realised in code; `09` §3 gains no FTS index.
No API-shape change (endpoint and parameters follow `30` §5), no data migration. Search
cost is bounded by a candidate cap and is unmeasured at volume.

**Alternatives.** (a) PostgreSQL FTS now — deferred on budget, with the visibility
predicates to be expressed in raw SQL in the same change; (b) an external index — rejected
by `30` §2.6, which requires measurements this work does not have; (c) omit search —
rejected: permission-scoped search is a Phase 2 deliverable.

**Decision & approvers.** Pending the Tech Lead's decision. Accepting updates `30` §2.2 to
record the interim approach; rejecting schedules the FTS work as the immediate follow-up.
**`ADR-0009` (search technology) remains `Proposed`** and should be resolved together with
this CR — per `00` R5, code may not silently contradict `30` §2.2.

**Implementation.** `backend/src/models/search.model.ts`, `services/search.service.ts`,
`controllers/search.controller.ts`, `routes/search.routes.ts`; tests
`backend/tests/search.integration.test.ts`.

**Resolution (2026-10-06).** Withdrawn: the FTS implementation of `30` §2.2 landed in the
same increment (migration `20261006082530_search_fts`; `ts_rank`/`ts_headline` in a single
`UNION ALL` statement), so the deviation was never accepted. `ADR-0009` remains `Proposed`
for the owner to mark `Accepted` now that the code matches the document.

### 4.5 CR-0003 — Report export content stored inline (v1)

- **Status:** Raised, 2026-10-06 — **pending the Tech Lead's decision** (`42` §4.1, AD4).
  Code is in place; per `00` R5 the deviation must be accepted or the code changed before
  the gate, so this CR is the owner's to resolve.
- **Raised by:** Implementation, 2026-10-06 · **Type:** Contract / deviation from an
  `Approved` ADR (`ADR-0004`)

**What changes.** `docs/19` and `ADR-0004` put stored files — including generated
artefacts — in object storage (S3), with the database holding only a key and metadata. The
v1 implementation of async report exports (`30` §3.4, `F-14`) instead stores the rendered
CSV **inline** in a `report_exports.content` text column and streams it back from the API.

**Why.** Deliver the export flow to a working, audited, time-limited state without an S3
adapter, which does not exist yet. The security properties `30` §5 cares about — the export
is scoped to its requester, audited with its filters (`R5`), and **time-limited** — are
enforced regardless of where the bytes live.

**Impact.** `ADR-0004` is not yet realised for this artefact; `19` gains no storage-key
path for exports. No API-shape change. Rows are bounded by `REPORT_EXPORT_TTL_MINUTES`
content and are pruned with the row, but a large export holds bytes in the database, which
is why the model already carries the fields a storage key would replace.

**Alternatives.** (a) Build the S3 adapter first — deferred on scope; it is Phase 3
(`05` §5 build order 8). (b) Stream a download with no stored result — rejected: `30` §5
requires a **time-limited** link, so the result must persist until it expires.

**Decision & approvers.** Pending the Tech Lead's decision. Accepting records the inline
v1 and schedules the storage migration with the S3 adapter; rejecting requires the adapter
in the same change.

**Implementation.** `backend/prisma/schema.prisma` (`ReportExport`),
`models/report-export.model.ts`, `services/report-export.service.ts`,
`services/report-export-scheduler.ts`, `controllers/search.controller.ts`,
`routes/search.routes.ts`; tests `backend/tests/report-export.integration.test.ts`.

### 4.6 CR-0004 — SLA pause arithmetic across non-working time

- **Status:** Raised, 2026-10-06 — **pending the Tech Lead's decision** (`42` §4.1, AD4).
  The worked examples added in `backend/tests/sla-worked-examples.test.ts` surfaced this;
  per `00` R5 the affected document statement must be corrected or the engine fixed before
  the gate.
- **Raised by:** Implementation, 2026-10-06 · **Type:** Correctness / deviation from an
  `Approved` document (`25` §4, §14 AC2)

**What is wrong — two separate defects.**

1. **Document (`25` §4, example 2).** The row states *"Target 8 working hours. Created Mon
   10:00, enters `APPROVAL_PENDING` Mon 12:00, resumes Wed 09:00"* with the result *"target
   reached Thu 15:00"*. The stated inputs do not produce the stated result under Model A:
   2 working hours elapse before the pause, so **6** working hours remain when the clock
   resumes Wed 09:00, giving **Wed 15:00**. The document's own reasoning ("2 hours elapsed
   before pause; resumes Wed") agrees with Wed 15:00, so the literal date is a typo.
2. **Engine (`sla-clock.service.ts`, `resumeClock`).** The target is shifted by the
   **wall-clock** duration of the pause (`resumeAt − pausedAt`). For a pause that spans
   non-working time — the document's own overnight/weekend case — this pushes the target
   out by time the calendar had *already* frozen, double-counting it. For example 2's
   inputs the engine yields **Thu 07:00** (verified), not the correct **Wed 15:00**. This
   violates §14 AC2: *"Paused intervals are excluded exactly once — never double-counted
   with non-working time"*.

**Why it matters.** A cross-day approval wait silently grants the desk hours of extra SLA
budget and misreports breach timing, which is the exact class of error §4 exists to
prevent. The intra-day case is correct (wall time equals working time), which is why the
bug went unnoticed.

**Proposed change (owner to approve).** Correct `25` §4 example 2 to **Wed 15:00**, and fix
`resumeClock` to advance the frozen target by the **working minutes inside the pause
interval** (recomputing the remaining budget from `resumeAt` under the clock's policy
calendar) rather than by wall time. That requires `resumeClock` to load the clock's policy
and calendar, which it currently does not.

**Impact.** `25` §4/§14 AC2 are not met for cross-day pauses until fixed. No API-shape
change; the effect is on stored `targetAt`/`warnAt` and therefore on attainment reporting.

**Evidence.** `backend/tests/sla-worked-examples.test.ts` asserts the rule (the remaining
budget is preserved) for a pause wholly inside a working day, and asserts the calendar
arithmetic of examples 1 and 3–5. It deliberately does **not** encode the disputed literal
for a cross-day pause, so the finding is visible rather than frozen into a green test.

**Decision & approvers.** Pending the Tech Lead's decision. Approving updates `25` §4 and
schedules the `resumeClock` fix as its own change with a regression test.

## 5. Traceability

Every decision and change is traceable in both directions:

```
Requirement (02)
   ↕
Contract (03–16)
   ↕
ADR / CR (42)          ← why it is the way it is
   ↕
Implementation (13/14 modules)
   ↕
Tests (37) · DoD evidence (41)
```

A future reader must be able to start from any line of code and reach the decision that
produced it.

## 6. Register

| ID | Type | Title | Status | Owner |
|---|---|---|---|---|
| ADR-0001…0008 | ADR | Per §3 | Accepted | per §3 |
| ADR-0009…0011 | ADR | Per §3 | Proposed | per §3 |
| ADR-0012 | ADR | Platform tenancy root, bootstrap and onboarding (D-9) | Accepted | Tech Lead |
| CR-0001 | CR | Consolidate 106 documents into 44 with named ownership | Implemented | Tech Lead |
| CR-0002 | CR | Interim search implementation (v1) — PostgreSQL FTS deferred | Withdrawn | Tech Lead |
| CR-0003 | CR | Report export content stored inline (v1) rather than in object storage | Raised | Tech Lead |
| CR-0004 | CR | SLA pause arithmetic across non-working time (doc example 2 + `resumeClock`) | Raised | Tech Lead |

`CR-0001` is the documentation restructuring performed before this register existed; it
is recorded retroactively per AD4-style discipline, and its effect is the current
document set (`00`).

## 7. Acceptance Criteria

1. Every closed `D-1`…`D-8` decision has an `Accepted` ADR with alternatives recorded.
2. No `Approved` document is contradicted by code without an ADR or CR in the same
   change (`00` R5).
3. Each ADR names the documents it affects; each affected document is updated.
4. Each CR updates the documents it affects and receives the required approver.
5. The ADR and CR registers are complete, append-only, and numbered without gaps.
6. Traceability from a module to its deciding ADR/CR is demonstrable.

## 8. Related

- `00-DOCUMENTATION-PLAN.md` — R4/R5, the status model, the D-list
- `39-AI-AGENT-INSTRUCTIONS-AND-WORKFLOW.md` — how an agent raises an ADR instead of guessing
- `40-IMPLEMENTATION-PLAN-AND-PHASES.md` — decisions gating phases
- `43-CHANGELOG.md` — the CR log
