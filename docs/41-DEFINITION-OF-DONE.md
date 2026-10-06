# 41 — Definition of Done

**Status:** Approved · **Owner:** Tech Lead · **Reviewer:** QA Lead · **Approved:** 2026-10-01
**Consolidates:** old 102

> **Scope:** the checklist that decides whether a unit of work is finished. **The
> quality standard behind it** is `38`; **the security rules it enforces** are `17`/`18`;
> **the phase gates** are `40`.

---

## 1. What "Done" Is For

A Definition of Done exists to stop the most expensive habit in software: declaring work
complete because the visible part works. Work is done when it satisfies the criteria
below — the same criteria for every change, applied by the author first and the reviewer
second.

The definition has one non-negotiable property: **it is verifiable.** "Looks good" is
not a done criterion; "the acceptance criteria pass as tests" is.

## 2. The Definition of Done

A change is Done when **all** of the following hold. Any item that genuinely does not
apply is marked **N/A with a reason**, not skipped silently.

### 2.1 Functional

| # | Criterion |
|---|---|
| F1 | All Acceptance Criteria of the owning document(s) are satisfied and demonstrated |
| F2 | The behaviour matches the `Approved` document; any divergence has a doc update or ADR (`39` A14) |
| F3 | Edge cases from the owning document's "Edge Cases" section are handled |
| F4 | No behaviour was added beyond the task's scope |

### 2.2 Correctness and Data

| # | Criterion |
|---|---|
| D1 | State transitions are enforced and invalid transitions are rejected |
| D2 | Concurrency is safe: no lost updates, one defined outcome for simultaneous writers |
| D3 | Invariants are enforced at the database where expressible (`08` §5) |
| D4 | Migrations (if any) apply forward, are backward compatible across a rolling deploy, and never rewrite a deployed migration (`10`, `35` §5) |
| D5 | No hard-delete of a record that history references; retirement is used instead (`08` §5) |

### 2.3 Security

| # | Criterion |
|---|---|
| S1 | Authorization is enforced in the service, including object-level access (`07`, `17`) |
| S2 | Negative tests prove denial; the 404-vs-403 distinction is asserted (`37` §5) |
| S3 | All input is validated at the boundary with Zod (`12`) |
| S4 | No secret, token or PII in logs, errors, or audit snapshots (`34` L1, `31` §4) |
| S5 | File handling (if any) validates content and scans per `19` |
| S6 | No new dependency without a provenance/license review; no secret in a `VITE_` variable (`35` §2) |

### 2.4 Audit and Events

| # | Criterion |
|---|---|
| A1 | Every mutation writes its audit row in the same transaction (`31`) |
| A2 | Events are written to the outbox in the same transaction; nothing is sent inline (`29`) |
| A3 | Notifications respect visibility and preference rules (`29` N5, N10) |

### 2.5 Performance and Data Access

| # | Criterion |
|---|---|
| P1 | Every list is paginated; no unbounded query (`11`, `33`) |
| P2 | Every filter/sort column is indexed; `EXPLAIN` reviewed for large tables (`09`) |
| P3 | No N+1 patterns; no external I/O inside a transaction (`33`) |
| P4 | Queries have timeouts; expensive work is async (`33`, `30`) |

### 2.6 Testing

| # | Criterion |
|---|---|
| T1 | Tests exist at the level required by `37` §7 and would fail if the behaviour were removed |
| T2 | Tests are deterministic: no wall-clock time, no execution-order dependence, no shared mutable state (`37` §3) |
| T3 | The suite passes on CI, not only locally |
| T4 | Security-relevant changes have a negative test (`20`) |

### 2.7 Quality and Documentation

| # | Criterion |
|---|---|
| Q1 | Lint, typecheck and format pass; import boundaries hold (`38`) |
| Q2 | The review's ten questions (`38` §4.1) are answered and approved |
| Q3 | Public contracts are documented; the OpenAPI document is current (`11`) |
| Q4 | The owning document is updated if behaviour documented in it changed |
| Q5 | No unreferenced TODOs; non-obvious decisions link to a doc or ADR |

### 2.8 Operations

| # | Criterion |
|---|---|
| O1 | Configuration is typed, validated at boot, and documented in `.env.example` (`35` §2) |
| O2 | New signals (metrics/logs/health) exist where `34` requires them |
| O3 | Runbook or alert updated if the change introduces a new failure mode (`36` §7) |
| O4 | The change is deployable with zero downtime via the rolling strategy (`35` §6) |

### 2.9 Frontend-Specific (where applicable)

| # | Criterion |
|---|---|
| U1 | Uses design-system tokens and components; no ad-hoc values (`15`) |
| U2 | Accessible: keyboard reachable, labelled, contrast-checked (`16`) |
| U3 | Loading, empty, error and permission-denied states handled (`16`) |
| U4 | Client validation mirrors the server schema without replacing it (`12`, `16`) |

## 3. Severity of Violations

| Class | Examples | Effect |
|---|---|---|
| Blocking | F2, S1, S3, A1, A2, D4, T1 | Must be fixed before merge |
| Should-fix | P2, U3, O2 | Fixed before merge or tracked with an owner and deadline |
| Follow-up | P1 on a low-traffic path, Q3 | Tracked; not merge-blocking |

The classification is a judgment the reviewer makes explicitly; it is never implied by
silence.

## 4. Verification Evidence

A "done" claim carries evidence proportional to the change:

| Claim | Evidence |
|---|---|
| Behaviour correct | Named passing tests |
| Authorization enforced | Named negative tests |
| Performant | Before/after measurement or `EXPLAIN` output |
| Safe to deploy | CI green including migration check |
| Accessible | Accessibility check result |

"Tested manually" is acceptable only for genuinely unfakeable visual checks, and is
stated as such.

## 5. Definition of Done versus Phase Gate

| | Definition of Done (`41`) | Phase Gate (`40` §4) |
|---|---|---|
| Scope | One change | One phase |
| Owner | Author + reviewer | Tech Lead + Product Lead |
| Includes | Code, tests, docs for that change | All docs approved, decisions closed, exit criteria demonstrated, drift audit |

Passing DoD for every change does not pass a phase gate; a phase additionally requires
its document set `Approved` and its decisions closed.

## 6. Acceptance Criteria for This Document

1. Every merged change can cite the DoD items it satisfies, with evidence.
2. No change merges with a Blocking-class violation.
3. N/A items are justified, never omitted silently.
4. Reviewers apply the same definition to every change; the checklist is embedded in
   the PR template.
5. A phase gate is never treated as equivalent to per-change DoD.

## 7. Related

- `38-CODE-QUALITY-AND-GUIDELINES.md` — the standard behind the checklist
- `37-TESTING.md` — the test levels T1 refers to
- `40-IMPLEMENTATION-PLAN-AND-PHASES.md` — the phase gates above this
- `31-AUDIT-LOGGING.md` · `29-NOTIFICATIONS-AND-MESSAGING.md` — the transactional rules
- `17-SECURITY-ARCHITECTURE.md` · `18-THREAT-MODEL.md` — the security criteria
