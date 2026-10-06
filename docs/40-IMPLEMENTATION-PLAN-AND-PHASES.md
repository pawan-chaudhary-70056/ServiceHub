# 40 — Implementation Plan and Phases

**Status:** Approved · **Owner:** Tech Lead · **Reviewer:** Product Lead · **Approved:** 2026-10-01
**Consolidates:** old 100, 101 (implementation plan, phases and milestones)

> **Scope:** the order in which ServiceHub is built, the gate that must be passed before
> each phase, and the milestone that ends it. **What "done" means per change** is `41`.
> **How decisions are recorded** is `42`.

---

## 1. Why Phases, Not a Waterfall

The charter imposes `APPROVE → IMPLEMENT` gates; the agent workflow (`39`) assumes
iteration within a phase. These are reconciled here as **gated phases with per-phase
iteration**:

- A phase has an **entry gate**: its documents are `Approved` (`00` R5).
- Inside a phase, work iterates freely — tasks, PRs, reviews, refinement.
- A phase has an **exit milestone**: its acceptance criteria are met and validated.
- "Approve" is **mechanical**, not ceremonial (§4): a named document set reaching
  `Approved`, the blocking decisions closed, and the exit criteria demonstrated. An
  approval that is not mechanical is a meeting, and meetings do not gate code.

This is the single reconciliation the documentation plan flagged as a contradiction; it
is resolved in favour of gated phases with iteration inside them.

## 2. Phase Overview

| Phase | Name | Entry gate (docs `Approved`) | Exit milestone |
|---|---|---|---|
| 0 | Foundation | `00`, `01`, `02`*, `40`, `41`, `42`, `43` | Scope, trade-offs, D-list agreed |
| 1 | Design | `03`–`19`, `38`, `39` | Contracts frozen; nothing to decide before building |
| 2 | Core build | `20`–`37` | A usable platform: auth, catalog, requests, incidents, tasks, SLA, approvals |
| 3 | Extended | remaining `21`–`37` docs for extended features | KB, assets, integrations, advanced reporting live |
| 4 | Hardening | — (all docs Approved) | Security review, load validation, DR rehearsal, acceptance |

\* `02` is `Approved` subject to **D-7** closing its quantified targets; the qualitative
requirements may be approved first and the targets closed as an amendment.

**A phase does not start on a date; it starts when its entry gate passes.** Dates are
planning aids; gates are the contract.

## 3. Phase Detail

### Phase 0 — Foundation
**Deliverable:** agreed scope, quality bar and decision register.
- Confirm `01` (what ServiceHub is) and `02` (functional + non-functional requirements).
- Close or explicitly defer `D-1`…`D-8`, each with an owner.
- Agree `41` (Definition of Done) and `42` (ADR/CR process).
- **Exit:** the D-list has owners and deadlines; `01`, `02`, `41` are `Approved`.

### Phase 1 — Design
**Deliverable:** a frozen, mutually consistent set of contracts.
- Architecture (`03`, `04`), identity/authz (`06`, `07`), data model (`08`–`10`),
  API (`11`), validation (`12`), backend/frontend (`13`, `14`), design (`15`, `16`),
  security (`17`–`19`), code guidelines (`38`) and the agent workflow (`39`).
- **Exit:** every Phase-1 document `Approved`; the blocking decisions `D-1`–`D-5`
  closed; a reviewer can trace any requirement to a contract.

`D-1` (session vs token), `D-2` (tenancy), `D-3` (cache/queue), `D-4` (file storage),
`D-5` (orchestrator) must be closed here — each shapes multiple documents, and
deferring them past the design gate means those documents cannot be approved.

### Phase 2 — Core Build
**Deliverable:** the platform's core value — a request can be raised, routed, approved,
worked, SLA-tracked and closed.
- Order within the phase: platform spine (auth, authz, audit, outbox, validation,
  errors, health) → catalog → requests → tasks → approvals → SLA → incidents →
  notifications → search/reporting → observability → testing/security harness.
- **Exit:** `20`–`37` documents for these features `Approved`; the four E2E journeys
  (`37` §7) pass on staging; security tests (`20`) pass; SLA worked examples (`25` §4)
  pass.

### Phase 3 — Extended
**Deliverable:** KB, assets, integrations, advanced reporting, deployment hardening.
- **Exit:** extended feature docs `Approved`; integration and webhook tests pass;
  reporting is reproducible from stored timestamps.

### Phase 4 — Hardening and Acceptance
**Deliverable:** production readiness.
- Security review (`18`, `20`), load validation against `02` targets, DR rehearsal
  (`36`), accessibility audit (`16`), doc drift audit (`00` §6).
- **Exit:** all `Approved`; acceptance criteria in `02` demonstrated; the system is
  releasable.

## 4. What a Gate Actually Requires

A phase gate passes when **all** hold:

1. Every document listed for the phase is `Approved` by its owner and reviewers (`00` §3).
2. Every decision blocking those documents is **closed and recorded** as an ADR (`42`).
3. The phase's exit criteria are **demonstrated**, not asserted — tests, measurements,
   or recorded rehearsals.
4. A drift audit found no implemented behaviour contradicting an `Approved` document
   (`00` §6). Divergence is resolved by a doc fix or an ADR before the gate.

If a gate is not passed, the phase does not start. Building ahead of an unresolved
decision is how the whole project acquires work to redo.

## 5. Working Inside a Phase

- Tasks are derived from a document's sections and Acceptance Criteria.
- Each task names its owning document (`39` §2).
- A task meeting `41` is done; a phase is a set of done tasks plus a passed gate.
- Open decisions discovered mid-phase are added to the register rather than worked
  around.

## 6. Sequencing Rationale (why this order)

| Decision | Reason |
|---|---|
| Platform spine before features | Audit, outbox, authz and validation are cross-cutting; retrofitting them means touching every feature |
| Catalog before requests | A request is derived from a catalog item; building requests first invents a catalog later |
| Requests before SLA | Clocks attach to records that must exist |
| Approvals before SLA-breach alerting | Pauses (`25`) depend on the approval state |
| Notifications after the events exist | Notifications consume domain events |
| Observability inside Phase 2, not Phase 4 | A system built without its signals cannot be load-tested honestly |
| Hardening last, without exceptions | Security and load validation are gates, not features |

## 7. Milestones and Traceability

Each milestone is expressed as **demonstrable capabilities**, never as dates:

| Milestone | Demonstration |
|---|---|
| M0 Scope agreed | `02` approved; D-list owned |
| M1 Contracts frozen | Docs `03`–`19` approved; decisions closed |
| M2 Walk-through | A request flows raise → approve → resolve → notify with an audit trail |
| M3 Core complete | Four E2E journeys pass; SLA examples pass; security tests pass |
| M4 Extended complete | KB, assets, integrations, reporting live |
| M5 Production ready | Security review, load targets, DR rehearsal, a11y audit passed |

Traceability: each capability maps to a functional requirement (`02`), a contract
(`03`–`16`), an implementation module (`13`/`14`) and tests (`37`). A capability that
cannot be traced to a requirement is scope creep; a requirement that cannot be traced
to a capability is an omission.

## 8. Risks and Their Management

| Risk | Management |
|---|---|
| Open decisions deferred past their gate | Gate 1 blocks on `D-1`–`D-5`; deferral requires an ADR |
| Documents drifting from code | Drift audit at every gate (`00` §6) |
| Under-specified domain features | Each `21`–`28` must reach `Approved` before its build |
| Scale-out built before it is measured | `33` §1 ordering; scale by measurement, not by diagram |
| Security retrofitted | Platform spine includes authz/audit from Phase 2 start |
| Document sprawl re-emerging | `00` R7; new docs require an ownership or lifecycle justification |

## 9. Open Decisions

`D-1`–`D-8` (`00` §7) gate the phases above; `D-7` in particular gates `02`'s
quantified targets and `37`'s performance pass/fail. See `42` for their ADRs.

## 10. Acceptance Criteria

1. Each phase's entry gate names the exact document set that must be `Approved`.
2. No phase starts before its gate passes; a missed gate is recorded, not ignored.
3. Every blocking decision is closed by an ADR before its gate.
4. Each milestone is demonstrated by a capability, a test, or a measurement — never a
   date alone.
5. Every in-flight capability traces to a requirement and to a test.
6. A drift audit is performed and recorded at each gate.

## 11. Related

- `00-DOCUMENTATION-PLAN.md` — ownership, statuses, the D-list
- `02-REQUIREMENTS.md` — what the capabilities must satisfy
- `39-AI-AGENT-INSTRUCTIONS-AND-WORKFLOW.md` — working inside a phase
- `41-DEFINITION-OF-DONE.md` — per-change completion
- `42-ADRS-AND-CHANGE-REQUESTS.md` — closing decisions and changing scope

## 12. Gate Log

A gate is recorded here when it passes — never marked passed on assertion; the evidence
is named. A missed gate is recorded too, not ignored (§4).

| Gate | Passed | Decision evidence | Exit evidence | Drift audit |
|---|---|---|---|---|
| **0 Foundation** | 2026-10-01 | — (Phase 0 blocks no decision) | `01`, `02`, `41` approved; `D`-list owned (`00` §7) | none — no implementation exists |
| **1 Design** | 2026-10-01 | `D-1`–`D-5` closed by `ADR-0001`–`ADR-0005` (`42` §3) | every document in `03`–`19`, `38` is `Approved`; requirement→contract references resolve (`42` §5) | none — no implementation exists to contradict a contract |
| **2 Core build — entry** | 2026-10-01 | `D-6`–`D-8` closed by `ADR-0006`–`ADR-0008` (plus `D-1`–`D-5` from Gate 1) | core documents `20`, `21`, `22`–`26`, `29`–`31`, `33`–`37` are `Approved` | none — no implementation exists yet |

**Phase 2 (Core Build) entry gate is now met** (2026-10-01): the core documents are
`Approved` and all eight decisions are closed. Construction may begin.

**Gate 2 is *not* passed, and the log above records only the entry.** Gate 2 passes at the
phase's **exit milestone**, when the four E2E journeys (`37` §7), the security tests
(`20`) and the SLA worked examples (`25` §4) are demonstrated on the built system. No
implementation exists, so those criteria cannot be demonstrated and the gate is not
claimed.
