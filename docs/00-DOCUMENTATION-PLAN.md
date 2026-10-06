# 00 — Documentation Plan

**Status:** Approved for execution · **Owner:** Tech Lead · **Reviewers:** Product Lead, Security Lead
**Supersedes:** the 106-document architecture in version 1.0 of the ServiceHub charter (§4).
The charter was updated to version 2.0, whose §4 now matches this plan.

---

## 1. Why This Plan Was Rewritten

The original plan defined 106 documents by **viewpoint**: for each topic there was a
`REQUIREMENTS` doc, an `ARCHITECTURE` doc, a `FLOW` doc, and often a `SECURITY` doc.
The same subject was therefore specified in three to five places.

That structure fails in one predictable way: **the copies drift.** A decision lands
in the flow diagram but not in the requirements table, and no reader knows which is
authoritative. It also produces ~60 documents whose content is one or two paragraphs
each, spread across files nobody opens.

This plan reorganises the same material by **ownership boundary and lifecycle** — one
artifact, one home, one owner. Nothing from the original plan is dropped (§5 is the
complete coverage map).

**Result: 106 → 44 documents.** Every original document number maps to exactly one
new home, except six view-split documents that map to two homes each (recorded
explicitly in §5, with the split rule stated).

---

## 2. Rules of This Plan

**R1 — One artifact, one home.** Every fact is stated exactly once, in the document
that owns the artifact. Other documents link to it. If a fact must be repeated for
the reader's convenience, it is marked `(see NN §x)` and is explicitly a pointer, not
a second source of truth.

**R2 — Ownership is by artifact, not by topic.** A document has one accountable
owner. "Everyone" owns nothing.

**R3 — Group by lifecycle, not by viewpoint.** Requirements, design, and flow for the
same artifact live together as sections of one document. Diagram-only documents do
not exist; a flow diagram belongs in the document that owns the flow.

**R4 — Document only what is decided or explicitly open.** A `TBD` paragraph is
allowed; a fabricated decision is not. Open items are listed in §7 with the owner
who must close them.

**R5 — Every document declares a status.** `Draft → In Review → Approved → Superseded`.
Only `Approved` documents may be implemented against. Implemented code that
contradicts an `Approved` document is a defect in one of the two — and that gets an
ADR, not a quiet edit.

**R6 — A document is done when** it has an owner, a status, a stated audience, its
open questions listed, its links resolving, and no claim that contradicts another
`Approved` document.

**R7 — No document may exist solely to restate another.** Merging is the default
remedy for overlap; splitting requires an owner change or a lifecycle change as
justification.

---

## 3. Target Document Set and Ownership

Owners are roles, not names. Each role has one accountable person.

| # | Document | Owner | Reviewers | Phase |
|---|---|---|---|---|
| 00 | Documentation Plan (this file) | Tech Lead | — | 0 |
| 01 | Project Foundation | Product Lead | Tech Lead | 0 |
| 02 | Requirements (functional + non-functional) | Product Lead | Tech Lead, QA Lead | 0 |
| 03 | Architecture (system, application, production) | Tech Lead | Backend, DevOps | 1 |
| 04 | Workflows and Flows | Tech Lead | Product Lead | 1 |
| 05 | Feature Map and Dependencies | Product Lead | Tech Lead | 1 |
| 06 | Identity and Authentication | Security Lead | Backend Lead | 1 |
| 07 | Roles and Authorization | Security Lead | Product Lead | 1 |
| 08 | Data Model | Backend Lead | DBA | 1 |
| 09 | Data Integrity and Indexing | Backend Lead | DBA | 1 |
| 10 | Migrations and Seeding | DBA | Backend Lead | 1 |
| 11 | API Contract (incl. errors, OpenAPI) | Backend Lead | Frontend Lead | 1 |
| 12 | Validation Rules | Backend Lead | Frontend Lead | 1 |
| 13 | Backend Architecture | Backend Lead | Tech Lead | 1 |
| 14 | Frontend Architecture | Frontend Lead | Tech Lead | 1 |
| 15 | Design System | Design Lead | Frontend Lead | 1 |
| 16 | UI, UX and Accessibility | Design Lead | Frontend Lead | 1 |
| 17 | Security Architecture (incl. secure coding, secrets) | Security Lead | Tech Lead | 1 |
| 18 | Threat Model | Security Lead | Tech Lead | 1 |
| 19 | Data Protection and File Handling | Security Lead | DBA | 1 |
| 20 | Security Testing | Security Lead | QA Lead | 2 |
| 21 | Service Catalog | Product Lead | Backend Lead | 2 |
| 22 | Service Requests | Product Lead | Backend Lead | 2 |
| 23 | Incident Management | Product Lead | Backend Lead | 2 |
| 24 | Task Management | Product Lead | Backend Lead | 2 |
| 25 | SLA Management | Product Lead | Backend Lead | 2 |
| 26 | Approval Management | Product Lead | Backend Lead | 2 |
| 27 | Knowledge Base | Product Lead | Backend Lead | 3 |
| 28 | Asset Management | Product Lead | Backend Lead | 3 |
| 29 | Notifications and Messaging (email/SMS) | Backend Lead | Product Lead | 2 |
| 30 | Search and Reporting | Backend Lead | Product Lead | 2 |
| 31 | Audit Logging | Security Lead | Backend Lead | 2 |
| 32 | Integrations | Backend Lead | Security Lead | 3 |
| 33 | Scalability and Database Protection | Tech Lead | DBA, DevOps | 2 |
| 34 | Observability (logging, metrics, health) | DevOps | Tech Lead | 2 |
| 35 | Deployment and CI/CD (incl. env, Docker, secrets) | DevOps | Tech Lead | 2 |
| 36 | Operations and Recovery (backup, DR, runbooks) | DevOps | DBA | 2 |
| 37 | Testing (strategy, cases, all levels, performance) | QA Lead | Tech Lead | 2 |
| 38 | Code Quality, Review and Development Guidelines | Tech Lead | All leads | 1 |
| 39 | AI Agent Instructions and Workflow | Tech Lead | — | 1 |
| 40 | Implementation Plan and Phases | Tech Lead | Product Lead | 0 |
| 41 | Definition of Done | Tech Lead | QA Lead | 0 |
| 42 | ADRs and Change Requests | Tech Lead | All leads | 0 |
| 43 | Changelog | Tech Lead | — | 0 |

**Phase** is the implementation phase in which the document must be `Approved`
(see `40-IMPLEMENTATION-PLAN-AND-PHASES.md`).

---

## 4. What Changed Structurally

| Merge | Old documents | New home | Rationale |
|---|---|---|---|
| Requirements consolidation | 01, 02, 03, 73, 75 | 02 | Process, functional, non-functional and test cases were four files describing one contract |
| Architecture consolidation | 04, 05, 89 | 03 | System, application and production views of one architecture |
| Flow consolidation | 06, 07, 23, 29, 33 | 04 | Five flow diagrams, one lifecycle |
| Feature meta | 08, 09, 10 | 05 | Architecture/flow/dependency split of one feature map |
| Roles + permissions + authz security | 11, 49 | 07 | Roles were defined three times |
| AuthN + authN security | 24, 48 | 06 | Same subject, two files |
| Data model consolidation | 12, 13, 14, 17 | 08 | Design, models, relationships and flow of one schema |
| Indexing + integrity | 15 | 09 | Promoted; indexes are a design artifact with an owner |
| API consolidation | 20, 21, 22, 26, 30 | 11 | Spec, endpoints, shapes, errors and OpenAPI describe one contract |
| Backend consolidation | 27, 28 | 13 | Requirements and architecture of one layer |
| Frontend consolidation | 31, 32, 39, 40 | 14 | Requirements, architecture, routing and state of one app |
| Design system + components | 34, 36 | 15 | Components *are* the design system |
| UI + pages + forms + a11y | 35, 37, 38, 41, 42 | 16 | Five view-points of the same surface inventory |
| Security consolidation | 43, 44, 45, 46, 53, 97 | 17 | Requirements/architecture/flow/controls/secrets/secure-coding of one posture |
| Data protection + files | 50, 51, 67 | 19 | File handling is a data-protection concern with one owner |
| Security testing dedupe | 52, 80 | 20 | These were duplicates of each other |
| Notifications + email/SMS | 62, 69 | 29 | One delivery pipeline |
| Search + reporting | 63, 64 | 30 | Both are read-model query concerns |
| Audit log + audit flow | 65, 66 | 31 | One artifact |
| Scalability + DB protection | 18, 19, 90 | 33 | Three restatements of one scaling strategy |
| Observability | 70, 71, 72 | 34 | Logging/metrics/health of one runtime |
| Deployment | 83, 84, 85, 86 | 35 | Environments, config, containers, pipeline of one delivery path |
| Backup + DR | 87, 88 | 36 | One recovery capability |
| Testing consolidation | 74, 76, 77, 78, 79, 81 | 37 | Strategy and levels of one test suite |
| Quality + guidelines | 82, 91, 92, 93, 94, 95, 96 | 38 | Standards documents with one owner |
| Agent docs | 98, 99 | 39 | One workflow |
| Plan + phases | 100, 101 | 40 | One schedule |

### Split documents (one old doc → two new homes)

Six originals genuinely spanned two artifacts. The split rule is stated so the
content is never duplicated, only divided:

| Old | Split into | Rule |
|---|---|---|
| 73 Performance Requirements | 02 §NFR, 33, 37 | **Targets** in 02; **optimization rules** in 33; **how it is load-tested** in 37 |
| 25 Validation Rules | 12, 16 | **Server-side schema** in 12; **form UX behaviour** in 16 |
| 41 Form Validation | 12, 16 | Same rule as above |
| 24 AuthN/AuthZ | 06, 07 | **Establishing identity** in 06; **deciding access** in 07 |
| 39 Routing/Navigation | 14, 16 | **Route table and guards** in 14; **navigation UX** in 16 |
| 53 Secrets/Configuration | 17, 35 | **Secret handling policy** in 17; **where secrets are injected** in 35 |

---

## 5. Complete Coverage Map (00–105 → new set)

Every original document number is accounted for. No content is orphaned.

| Old | New | Old | New | Old | New | Old | New |
|---|---|---|---|---|---|---|---|
| 00 | 01 | 27 | 13 | 54 | 21 | 81 | 37 |
| 01 | 02, 00 | 28 | 13 | 55 | 22 | 82 | 38 |
| 02 | 02 | 29 | 04 | 56 | 23 | 83 | 35 |
| 03 | 02 | 30 | 11 | 57 | 24 | 84 | 35 |
| 04 | 03 | 31 | 14 | 58 | 25 | 85 | 35 |
| 05 | 03 | 32 | 14 | 59 | 26 | 86 | 35 |
| 06 | 04 | 33 | 04, 14 | 60 | 27 | 87 | 36 |
| 07 | 04 | 34 | 15 | 61 | 28 | 88 | 36 |
| 08 | 05 | 35 | 16 | 62 | 29 | 89 | 03 |
| 09 | 05, 21–28 | 36 | 15 | 63 | 30 | 90 | 33 |
| 10 | 05 | 37 | 16 | 64 | 30 | 91 | 38 |
| 11 | 07 | 38 | 16 | 65 | 31 | 92 | 38 |
| 12 | 08 | 39 | 14, 16 | 66 | 31 | 93 | 38 |
| 13 | 08 | 40 | 14 | 67 | 19 | 94 | 38 |
| 14 | 08 | 41 | 12, 16 | 68 | 32 | 95 | 38 |
| 15 | 09 | 42 | 16 | 69 | 29 | 96 | 38 |
| 16 | 10 | 43 | 17 | 70 | 34 | 97 | 17 |
| 17 | 08 | 44 | 17 | 71 | 34 | 98 | 39 |
| 18 | 33 | 45 | 17 | 72 | 34 | 99 | 39 |
| 19 | 33 | 46 | 17 | 73 | 02, 33, 37 | 100 | 40 |
| 20 | 11 | 47 | 18 | 74 | 37 | 101 | 40 |
| 21 | 11 | 48 | 06 | 75 | 02, 37 | 102 | 41 |
| 22 | 11 | 49 | 07 | 76 | 37 | 103 | 42 |
| 23 | 04 | 50 | 19 | 77 | 37 | 104 | 42 |
| 24 | 06, 07 | 51 | 19 | 78 | 37 | 105 | 43 |
| 25 | 12, 16 | 52 | 20 | 79 | 37 | | |
| 26 | 11, 13 | 53 | 17, 35 | 80 | 20 | | |

---

## 6. Document Status and Review Cadence

| Status | Meaning | May be implemented against? |
|---|---|---|
| Draft | Being written; may be incomplete | No |
| In Review | Complete, awaiting reviewer sign-off | No |
| Approved | Signed by owner and reviewers | Yes |
| Superseded | Replaced; see successor | No |

**Cadence**

- Phase-gate review: every document for the phase must be `Approved` before its
  implementation starts (`40-IMPLEMENTATION-PLAN-AND-PHASES.md`).
- Change-driven review: any Change Request touching a document re-opens it and
  returns it to `In Review` in the same change as the code.
- Drift audit: at each phase gate, product and engineering reconcile implemented
  behaviour against `Approved` documents. Divergence produces either a doc fix or an
  ADR — never silence.

---

## 7. Decisions (`D-1` … `D-9`)

Each was closed by an ADR in `42-ADRS-AND-CHANGE-REQUESTS.md` before the documents it
gated were approved. `D-1`–`D-8` are `Accepted` (2026-10-01). **`D-9` was discovered
when the Phase 2 data model could not be implemented** — no document defined a tenant
root, a platform operator, or an onboarding flow — and is recorded as **`ADR-0012`**
(**`Accepted`**, 2026-10-02).

| ID | Decision | Owner | Blocked | ADR |
|---|---|---|---|---|
| D-1 | Session cookies vs stateless tokens | Security Lead | 06, 14, 17 | ADR-0001 |
| D-2 | Single-tenant vs multi-tenant | Tech Lead | 07, 08, 09, 33 | ADR-0002 |
| D-3 | Cache provider, queue broker, pooler | Tech Lead | 03, 33, 35 | ADR-0003 |
| D-4 | File storage backend | DevOps | 19, 36 | ADR-0004 |
| D-5 | Production orchestrator | DevOps | 03, 35, 36 | ADR-0005 |
| D-6 | Email/SMS provider | Backend Lead | 29 | ADR-0006 |
| D-7 | Quantified NFR targets | Product Lead | 02, 36, 37 | ADR-0007 |
| D-8 | SLA calendar and pause semantics | Product Lead | 25 | ADR-0008 |
| D-9 | Platform tenancy root, superadmin bootstrap and user onboarding | Tech Lead | 04, 06, 07, 08, 09, 10 | ADR-0012 |

---

## 8. Existing Files

**All 44 documents (`00`–`43`) are drafted** and present in this directory. The
**Phase 0 set** — `00`, `01`, `02`, `40`, `41`, `42`, `43` — is `Approved` (2026-10-01),
so Phase 0's gate passes; `02` is `Approved (qualitative)`, with its quantified NFR
targets left open under **D-7**.

The **whole Phase 1 design set** (`03`–`19`, `38`, `39`) is `Approved`, so **Gate 1 is
passed** (gate log, `40` §12). With `D-6`–`D-8` also closed, the **Phase 2 core
documents** (`20`, `21`, `22`–`26`, `29`, `30`, `31`, `33`–`37`) are `Approved` and the
**Phase 2 entry gate is met** — but **Gate 2 is not passed**, because its exit criteria
(the four E2E journeys, the security tests and the SLA worked examples) are demonstrated
behaviour from a built system that does not yet exist. The Phase 3 documents (`27`, `28`,
`32`) stay `Draft`. Every remaining document stays `Draft` until each owner and
reviewer signs off under the phase gates in `40-IMPLEMENTATION-PLAN-AND-PHASES.md`; none
may be implemented against until it is `Approved` (R5). `D-1`–`D-9` are all `Accepted` ADRs
`ADR-0001`–`ADR-0008` and `ADR-0012` in `42`.

The four pre-plan drafts (`00-PROJECT-FOUNDATION`, `01-REQUIREMENTS`,
`02-FUNCTIONAL-REQUIREMENTS`, `03-NON-FUNCTIONAL-REQUIREMENTS`) were consumed into
`01` and `02` and removed, so this directory never holds two versions of one fact.
