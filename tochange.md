# ServiceHub — Everything Till Now: Status, Gaps & Change List

> Analysis date: **2026-10-08** · Read-only assessment — **nothing in the code was changed**
> to produce this document. Sources: charter (`ServiceHub Enterprise.md`), all 44 docs,
> changelog (`docs/43`, 22 increments), both source trees, and checks actually executed.

---

## 1. Verification evidence (run, not assumed)

| Check | Result |
|---|---|
| `backend: npm run typecheck` | ✅ passes |
| `backend: npm run lint` | ✅ passes |
| `backend: npm test -- --run` | ✅ **276 tests / 30 files pass** |
| `frontend: npm run typecheck` | ✅ passes |
| `frontend: npm run lint` | ✅ passes |
| `frontend: npm test -- --run` | ✅ **65 tests / 21 files pass** |
| Playwright E2E | ⚠️ not run (needs live stack; file is a placeholder anyway) |
| Docker | ❌ unavailable in analysis env (local Postgres used by backend suite) |

**Codebase size:** 24.7k LOC backend src · 10.9k LOC backend tests · 14k LOC frontend src ·
1,633-line Prisma schema (61 models) · 24 migrations · 44 approved docs (11k lines).

---

## 2. Overall completion

| Dimension | Completion |
|---|---|
| Documentation & governance (44 docs, ADRs, CRs, gates) | **100%** |
| Backend domain build | **~85%** |
| Frontend (25 routes/pages) | **~85%** |
| Test evidence (341 automated tests passing) | **~85%** (browser E2E placeholder) |
| Integrations (M4 gate) | **~70%** |
| Observability (`34`) | **~30%** (logs + health probes only) |
| Phase 4 hardening / production readiness | **~0–10%** |
| **Whole project to "releasable"** | **≈ 72–78%** |

### Gate / milestone status

| Gate / Milestone | Status |
|---|---|
| Gate 0 — Foundation | ✅ Passed 2026-10-01 |
| Gate 1 — Design (D-1…D-9 closed by ADR-0001…0012) | ✅ Passed 2026-10-01 |
| Phase 2 entry | ✅ Passed 2026-10-01 |
| Gate 2 — Core build exit | 🟡 Automated evidence done; **exit NOT claimed** — SAST/DAST/pentest outstanding |
| Phase 3 entry (27, 28, 32 Approved) | ✅ Passed 2026-10-08 |
| M4 — Extended complete | 🟡 **Partial** — integrations only partially live |
| M5 / Phase 4 — Hardening | ⬜ Not started |

---

## 3. Feature status (docs/05 F-01…F-17)

| Feature | Doc | Status | Note |
|---|---|---|---|
| F-01 Identity | 06 | ✅ Done | Sessions, reset, invites, provisioning |
| F-02 Users & Teams | 07 | 🟡 Partial | Teams **read-only** (`GET /teams` only) |
| F-03 Authorization | 07 | ✅ Done | Permission catalogue + object-level checks |
| F-04 Catalog | 21 | ✅ Done | C1/C5/C7 enforced |
| F-05 Requests | 22 | ✅ Done | Transition table, snapshots, references |
| F-06 Incidents | 23 | ✅ Done | Derived priority, reopen window, DB CHECKs |
| F-07 Tasks | 24 | ✅ Done | Closed state machine, parent roll-up |
| F-08 SLA | 25 | ✅ Done | Frozen targets, pause/resume, sweep, DST |
| F-09 Approvals | 26 | ✅ Done | Insert-only decisions (DB trigger) |
| F-10 Knowledge Base | 27 | ✅ Done | Immutable ArticleVersion |
| F-11 Assets | 28 | ✅ Done | Partial unique index (AM1), assignment history |
| F-12 Notifications | 29 | 🟡 Partial | Only 2 templates; no N8 webhooks; some events email-only |
| F-13 Search | 30 | ✅ Done | Real PostgreSQL FTS |
| F-14 Reporting | 30 | 🟡 Partial | Only 4 metrics; no cached aggregates; export CSV inline |
| F-15 Audit | 31 | ✅ Done | All 4 surfaces, redaction, audited export |
| **F-16 File Attachments** | 19 | ❌ **Not started** | Zero code — no upload route, no `File` model |
| F-17 Integrations | 32 | 🟡 ~70% | Webhooks/UI/health/roster done; breaker tuning + config admin remain |

**Features fully done: 11/17 · Partial: 5/17 · Not started: 1/17 ≈ 80%.**

---

## 4. Remaining work, sized

| # | Remaining item | Size |
|---|---|---|
| 1 | **F-16 File attachments** (docs/19): upload path, storage, parent-scoped authz, audited downloads, UI | 1.5–2 sprints |
| 2 | **Integrations finish (M4 blocker)**: circuit-breaker/bulkhead tuning + `admin:config` credential surface | 1–1.5 sprints |
| 3 | **Object-storage adapter** for report exports (replaces CR-0003 inline CSV, ADR-0004) | 0.5–1 sprint |
| 4 | **Notifications depth**: templates for all events, in-app enrichment, N8 provider webhooks | 1–1.5 sprints |
| 5 | **Reporting depth**: full `30` §3.3 metric catalogue + cached aggregates | 1 sprint |
| 6 | **Teams membership write surface** + per-identity rate limiting + separate worker process | 1 sprint |
| 7 | **Observability (`34`)**: metrics endpoint, tracing, dashboards, alerting | 1 sprint |
| 8 | **Browser E2E** for the four journeys (`37` §7) | 0.5–1 sprint |
| 9 | **Security hardening (Gate 2 exit)**: SAST/IaC scans, DAST, pentest + remediation | 1.5–2 sprints |
| 10 | **Load validation** vs quantified D-7 targets | 1 sprint |
| 11 | **DR rehearsal (`36`)** + runbooks | 0.5–1 sprint |
| 12 | **A11y audit (`16`)** + doc-drift audit + Gate 2/M4/M5 evidence | 1 sprint |
| | **Total remaining** | **≈ 11–14 sprints** |

---

## 5. Timeline: 15 sprints (2 weeks each = 30 weeks ≈ 7 months)

**Verdict: 15 sprints is enough, with ~10–25% contingency.**

- **Sprints 1–7 — features:** attachments → integrations/object storage → notifications →
  reporting → teams/worker → observability → E2E. *M4 passes ~end of sprint 4–5.*
- **Sprints 8–12 — Phase 4 hardening:** security scans + pentest, load validation, DR
  rehearsal, a11y audit, doc-drift audit.
- **Sprints 13–14 — evidence & release:** demonstrate `02` acceptance criteria, record
  Gate 2 exit + M5 in `40` §12, cut the release.
- **Sprint 15 — buffer** (pentest vendor and load-environment lead times).

**Caveats:** build velocity so far was very fast (22 increments in ~6 working days) — at
that pace the build is ~8–10 sprints and hardening is the true critical path; hardening
cannot start earlier per `40` §6 ("hardening last, without exceptions").

---

## 6. Priority-high assessment (per file)

**Already legitimately High (6):** MFA (#1), CSP+HSTS (#2), CI security gates (#4),
`index.html` favicon/OG (#11), real E2E (#12), CD pipeline (#15).

**Force-High defensible (quick wins / launch-gated):** #3 helmet pinning, #5 rate-limit
keying (if credential-stuffing risk), #6 secret manager (only for real prod), #7 session
self-service (small — revocation exists), #8 alerting (once live), #13 README (~2h), #14
releases (when shipping v1.0), #16 OpenAPI (if external integrators), #17 report metrics
(if a sales requirement), #18 Security page (only with MFA), #19 teams write (if day-1
self-serve needed).

**Should stay Medium/Nice — do not inflate:** #9 `security.txt`, #10 `SECURITY.md` polish,
#20 audit→status feed. Marking tiny items High is what makes teams ignore the list.

---

## 7. 🔧 TO CHANGE — exists today, should be different

| # | File | What's wrong today | Change to | Priority |
|---|---|---|---|---|
| 1 | `backend/src/middlewares/rate-limit.ts` + `integrations/rate-limit-store.ts` | Per-IP, runs pre-auth — self-documented "known limitation" (`43` incr. 3) | Key authenticated surfaces by user/session id | 🟠 Medium |
| 2 | `backend/src/services/report-export.service.ts` | CSV stored inline in the row (CR-0003 interim) | Object storage per ADR-0004 | 🟠 Medium |
| 3 | `backend/src/services/notification-events.ts` | Events without recipient id are email-only — comment admits "for now" | Enrich payloads in owning services for in-app | 🟠 Medium |
| 4 | `frontend/nginx.conf` | **No `Content-Security-Policy`, no `Strict-Transport-Security`** (docs `17` requires both) | Add CSP (`default-src 'self'`, no `unsafe-inline` scripts) + HSTS `always` | 🔴 High |
| 5 | `backend/src/app.ts` (line 63 `helmet()`) | Helmet defaults, unpinned | Pin explicit CSP/HSTS/COOP/CORP | 🟠 Medium |
| 6 | `backend/src/server.ts` | Schedulers run in-process — "job worker/broker remains unwired" (`43`) | Separate worker process / queue consumer | 🟠 Medium |
| 7 | `backend/src/routes/teams.routes.ts` | Read-only — "membership management arrives with its own work" | Membership write surface + UI | 🟠 Medium |
| 8 | `.github/workflows/ci.yml` | Only build + dependency audit + secret scan | Add SAST (CodeQL/semgrep), IaC (checkov), DAST, coverage gate — Gate 2 blocker | 🔴 High |
| 9 | `backend/src/utils/logger.ts` + `services/integration-health.service.ts` | Security/health events logged but never alerted | Metrics + paging alerts (`34`) | 🟠 Medium |
| 10 | `docs/43-CHANGELOG.md` §4 | Product section stuck at `[Unreleased]` | Cut semver releases with generated notes | 🟠 Medium |
| 11 | `backend/src/config/env.ts` | Secrets come from `.env` | Production secret manager (Vault/KMS) + rotation runbook | 🟠 Med (prod only) |
| 12 | `backend/src/routes/auth.routes.ts` + `controllers/auth.controller.ts` | Server-side revocation exists; users can't see sessions | `GET /auth/sessions` + `DELETE /auth/sessions/{id}` | 🟡 Nice |
| 13 | `backend/src/routes/health.routes.ts` (or nginx) | No `security.txt` | Serve `/.well-known/security.txt` (RFC 9116) | 🟡 Nice |
| 14 | `SECURITY.md` | Disclosure policy exists | Link from security.txt + response SLAs | 🟡 Nice |
| 15 | `README.md` | Run instructions only | CI/coverage badges, screenshots/GIF | 🟠 Medium |
| 16 | `backend/src/validators/*.ts` (16 validators + barrel) | Contract lives only in hand-written `docs/11` | Generate OpenAPI from Zod schemas | 🟠 Medium |
| 17 | `backend/src/services/report.service.ts` (line 33 — 4 metrics) | 4 metrics vs `30` §3.3 catalogue | Full metric catalogue + cached aggregates | 🟠 Medium |
| 18 | `frontend/src/components/app-shell.tsx` | No central security/account page | Security page (MFA status, sessions, password) — pair with MFA | 🟡 Nice |
| 19 | `frontend/index.html` | `charset/viewport/description/referrer/title` only; **no favicon, no OG/Twitter, no `frontend/public/`** | Favicon + `og:`/`twitter:` tags + `theme-color` | 🔴 High |
| 20 | `frontend/tests/e2e/smoke.spec.ts` | 2 placeholder tests | The four real journeys `37` §7 | 🔴 High |
| 21 | `docs/42-ADRS-AND-CHANGE-REQUESTS.md` | ADR-0009/0010/0011 still `Proposed` | Owner accepts/rejects | 🟠 Medium |

---

## 8. ➕ TO ADD — doesn't exist at all

| # | Missing | Why | Priority |
|---|---|---|---|
| 1 | **F-16 File attachments** (docs `19`): upload route (content-validated, size-capped, separate from the 1mb JSON parser), storage behind ADR-0004, parent-scoped authz, audited downloads, UI | The only feature in `05` with **zero code** — no `File` model in the 61-model schema | 🔴 High |
| 2 | **MFA (TOTP + recovery codes)** — `auth.service.ts` / `auth.routes.ts` / `auth.validators.ts` / `schema.prisma` | `06` §8 defers it ("post-v1", `FR-AUTH-007` = Could) — biggest credential-theft control | 🔴 High |
| 3 | **Integrations leftovers**: circuit-breaker/bulkhead tuning + credential/config administration (`admin:config`) | Stated reason M4 is only "partially met" (`40` §7) | 🔴 High |
| 4 | **Notification templates** for all domain events (only invitation + password reset exist) + **N8 provider webhooks** (bounce/complaint/delivery) | Tracked "not yet built" (`43` incr. 10) | 🟠 Medium |
| 5 | **Report metric catalogue + materialised/cached aggregates** | Tracked "not yet built" (`43` incr. 11) | 🟠 Medium |
| 6 | **Observability stack**: `/metrics`, sampled tracing, dashboards, alert rules | `34` approved, ~30% implemented — required before honest load testing | 🔴 High |
| 7 | **Real Playwright E2E** for the four journeys | Current file is a 2-test placeholder; Gate 2 credibility signal | 🔴 High |
| 8 | **Session self-service UI + Security account page** | Revocation exists server-side; no user-facing surface | 🟡 Nice |
| 9 | **Phase 4 hardening**: DAST/pentest, load validation vs D-7 targets, DR rehearsal (`36`), a11y audit (`16`), doc-drift audit (`00` §6) | Gate 2 exit + M5 criteria — none started | 🔴 High |
| 10 | **CD pipeline / deploy target** | Only `ci.yml` exists — nothing can ship; blocks all production validation | 🔴 High |
| 11 | **Favicon + Open Graph tags + `frontend/public/`** | Links don't render when shared; no app icon | 🔴 High |
| 12 | **OpenAPI spec** generated from the Zod validators | Contract exists only as markdown | 🟠 Medium |
| 13 | **Teams management UI** + saved views (`16` §97) | Depth/polish | 🟡 Nice |
| 14 | **`security.txt`** + vulnerability-disclosure contact | Enterprise buyers ask; RFC 9116 | 🟡 Nice |
| 15 | **Status page / public health feed** | Health endpoints exist (`/api/health/*`); no public surface | 🟡 Nice |

---

## 9. Top-5 shortlist

If only five things are done, in order:

1. **CSP + HSTS** in `frontend/nginx.conf` (hours, biggest browser-side win)
2. **SAST/DAST/IaC in CI** (`.github/workflows/ci.yml`) — Gate 2's blocking criterion
3. **MFA** (`auth.service.ts` + schema + routes) — top credential-theft control
4. **Real Playwright E2E** (`smoke.spec.ts`) — regression safety + gate evidence
5. **CD pipeline** (`.github/workflows/`) — without deploy, no production hardening is testable

---

## 10. What was already strong (do not redo)

Server-side sessions with HttpOnly/Secure/SameSite=Lax cookies · CSRF double-submit ·
Argon2id · uniform login failure + lockout with `Retry-After` · Redis-shared rate limits ·
RBAC **with object-level authz** (404-not-403) · Zod at every boundary ·
audit-in-the-same-transaction · insert-only audit/approval records (DB triggers) ·
signed webhooks with one-time secrets · helmet · nginx security headers (partial) ·
CI dependency + secret scans · tenant isolation (ADR-0002) · roster sync with drift guard.

---

*Generated for the ServiceHub repository · analysis only — no code modified.*
