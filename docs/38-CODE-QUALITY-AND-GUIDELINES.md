# 38 — Code Quality, Review and Development Guidelines

**Status:** Approved · **Owner:** Tech Lead · **Reviewers:** All leads · **Approved:** 2026-10-01
**Consolidates:** old 82, 91, 92, 93, 94, 95, 96 (quality standards, folder structure,
development guidelines, git workflow, review standards, API/database guidelines, secure coding)

> **Scope:** how code is written, structured, reviewed and merged. **Secure-coding
> *rules* with their threat rationale** are `17`; this document owns the **review
> checklist that enforces them**. **Where files live** is fixed by the charter and
> restated here only as a rule.

---

## 1. The Standard in One Sentence

Code is acceptable when it is **correct, understandable by the next reader, safe by
default, and tested for the behaviour it claims** — and when every deviation from this
document is either impossible or reviewed and recorded.

Everything below elaborates one of those four.

## 2. Language and Tooling Conventions

| Concern | Rule |
|---|---|
| Language | TypeScript everywhere; `strict` on; no implicit `any`; `unknown` at boundaries |
| Formatting | Prettier, enforced by CI; no formatting debates in review |
| Linting | ESLint with the project config, including the **import-boundary rule** (`03` §4) |
| Types | Domain types explicit; no `any` without a comment and reviewer sign-off |
| Errors | Typed error classes mapped to API problem responses (`11`); never throw bare strings |
| Async | Fail fast on unhandled rejections; no floating promises |
| Dates | UTC at rest; time-zone-aware arithmetic only via the SLA calendar (`25`) |
| Money | Integer minor units; never float (`08` §1) |
| Naming | `camelCase` code, `snake_case` DB via `@map`; booleans as assertions (`isActive`) |

## 3. Structure and Boundary Rules

The folder structure is fixed by the charter (`frontend/src`, `backend/src`) and must
not be reorganised. Inside it:

| Rule | Enforcement |
|---|---|
| Dependency direction is downward: routes → controllers → services → repositories (the mandated `models/`, `03` §4) | Import-boundary lint |
| Modules never read another module's tables; they call its service (`03` §4) | Import-boundary lint + review |
| Controllers never touch Prisma; services never touch `req`/`res` | Review |
| Adapters isolate vendors (`32` §3) | Dependency lint |
| No circular imports | Lint |

**Frontend tests:** the charter's `frontend/src` structure has no `tests/` directory,
yet Vitest/RTL are mandated. Resolution recorded here: frontend tests live **co-located
adjacent to the code they test** (`*.test.tsx`) and/or under `frontend/tests/` for
end-to-end specs. This closes the contradiction flagged in the documentation plan
without altering the mandated structure.

## 4. Review Standards

### 4.1 What a reviewer is accountable for

A review approves **behaviour and risk**, not style (style is automated). A reviewer
must be able to answer all of the following before approving:

| # | Question |
|---|---|
| 1 | Does this do what the task claims, according to the owning document's criteria? |
| 2 | Is authorization enforced at the **service** layer, including object-level access? |
| 3 | Is every input validated at the boundary (Zod)? |
| 4 | Are all mutations audited in the same transaction (`31`)? |
| 5 | Is any query unbounded, unindexed, or N+1? (`33` §7) |
| 6 | Is external I/O outside transactions and (where slow) off the request path? |
| 7 | Are secrets, tokens, or PII absent from logs, errors and audit snapshots? |
| 8 | Are the tests present and would they fail if the behaviour were removed? |
| 9 | Is a migration required, and is it backward compatible (`35` §5)? |
| 10 | Does this change any `Approved` document? If so, is the doc updated in the same change? |

### 4.2 Review etiquette and mechanics

- Small PRs; a review that cannot be done in one sitting is a PR that should be split.
- The author states what to look for and what was deliberately not done.
- Comments distinguish **blocking** concerns from suggestions.
- Approval means "I checked the ten questions", not "it compiles".
- **A change that contradicts an `Approved` document requires an ADR or a document
  update in the same PR** (`00` R5, `42`). Silence is not an option.

## 5. Git and Merge Workflow

| Rule | Detail |
|---|---|
| Branch naming | `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` + short description |
| Commit messages | Imperative, scoped; explain **why**; reference the issue |
| One logical change per PR | Unrelated cleanups go in their own PR |
| Rebase vs merge | Follow the repository's configured strategy; do not rewrite shared history |
| Main branch | Always releasable; protected; no direct pushes |
| Merge requirements | Green CI (lint, typecheck, unit, integration, security), review approval |
| Generated code / lockfiles | Committed; reviewed when the dependency changes |

No `git push --force` to shared branches. No committing secrets — the secret scan
(`35`) is a backstop, not the control.

## 6. API Development Guidelines

| Rule | Reference |
|---|---|
| Contract-first: the endpoint is documented before it is implemented | `11` |
| Every endpoint declares its permission annotation | `07`, `11` |
| Validation is Zod schemas shared in shape between client and server | `12` |
| Errors use the single problem-response shape with stable codes | `11` |
| Collections are cursor-paginated; `limit` is bounded | `11` §6 |
| Mutating endpoints support idempotency keys where repeats are possible | `11` |
| No breaking change without a version or a deprecation window | `11` |
| The OpenAPI document is generated and current; a drift check runs in CI | `11` |

## 7. Database Development Guidelines

| Rule | Reference |
|---|---|
| Schema changes are migrations; never manual edits | `10` |
| Migrations are backward compatible across a rolling deploy | `35` §5 |
| New queries over large tables get an `EXPLAIN` review | `09`, `33` |
| Every filter/sort column is indexed | `09` |
| No `SELECT *` shaping; select what is used | `33` §7 |
| Constraints express invariants at the database, not only in code | `08` §5 |
| Transactions are short; no external I/O inside | `33` §11 |
| Seed data is idempotent and synthetic | `10` |

## 8. Secure-Coding Enforcement

The rules themselves and their threat rationale are `17` and `18`. The reviewer checks
enforcement of the ones most often missed:

- Parameterized queries only; no string-built SQL.
- Output encoding / escaping for user content in HTML and email templates.
- Object-level authorization on **every** read and write of a scoped entity.
- No secret or PII in logs, errors, or audit snapshots (`34` L1, `31` §4).
- File uploads validated by content, not extension, and scanned (`19`).
- Dependency additions reviewed for provenance and license.
- `VITE_` variables treated as public — no secret may appear in the frontend bundle
  (`35` §2).

## 9. Documentation in Code

- A comment explains **why**, never what the code plainly does.
- Non-obvious decisions link to the owning document (`21`–`33`) or an ADR (`42`).
- Public functions have a docstring stating contract and failure modes.
- A change that alters documented behaviour updates the document in the same PR.
- TODOs carry an issue reference; an unreferenced TODO is a defect.

## 10. Definition of Done (reference)

The authoritative gate is `41-DEFINITION-OF-DONE.md`. This document defines the quality
standard that DoD enforces; a change meeting §4.1's ten questions and §10's rules is
ready for the DoD checklist.

## 11. Anti-Patterns (rejected in review)

| Anti-pattern | Why rejected |
|---|---|
| Authorization only in the route, not the service | Every non-HTTP caller bypasses it |
| Validation only in the client | Trivially bypassed (`12` §1) |
| Business logic in controllers | Untestable and unreusable |
| Vendor types in services | Couples the domain to a provider (`32`) |
| `SELECT *` + shape in the app | Wastes I/O and hides index gaps |
| Catch-and-log-and-continue on a mutation failure | Produces silent partial state |
| Cache without TTL or invalidation | Correctness bug waiting for load (`33` C2/C3) |
| A test asserting the mock returned what it was told | Proves nothing (`37` §9) |

## 12. Acceptance Criteria

1. CI enforces format, lint (including import boundaries), typecheck, and tests.
2. Every PR review answers the ten questions in §4.1; a template embeds them.
3. No PR merges that contradicts an `Approved` document without a doc update or ADR.
4. Every mutating endpoint has a service-layer authorization test.
5. No secret or PII appears in logs, errors, or audit snapshots — verified by scan.
6. Migrations in a PR are backward compatible across a rolling deploy.
7. The OpenAPI document is current; a CI drift check passes.
8. The frontend test location is unambiguous and does not alter the mandated structure.

## 13. Related

- `00-DOCUMENTATION-PLAN.md` — rules R1–R7 this document enforces in review
- `17-SECURITY-ARCHITECTURE.md` · `18-THREAT-MODEL.md` — the rules §8 enforces
- `13-BACKEND-ARCHITECTURE.md` · `14-FRONTEND-ARCHITECTURE.md` — layer boundaries
- `41-DEFINITION-OF-DONE.md` · `42-ADRS-AND-CHANGE-REQUESTS.md` — the gates
