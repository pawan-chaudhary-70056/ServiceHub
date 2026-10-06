# Contributing to ServiceHub

Thank you for contributing. ServiceHub is documentation-led: the `Approved` documents
define correct behaviour, and code that contradicts them is a defect in one of the two.

---

## Before you write code

1. **Read the owning document.** Find which document owns the concern you are changing
   (`docs/39-AI-AGENT-INSTRUCTIONS-AND-WORKFLOW.md` §2 is the routing table).
2. **Check the document's status.** Only `Approved` documents may be implemented against.
   The Phase 0 set (`00`, `01`, `02`, `40`, `41`, `42`, `43`), the Phase 1 design set
   (`03`–`19`, `38`, `39`) and the Phase 2 core documents (`20`, `21`, `22`–`26`,
   `29`–`31`, `33`–`37`) are `Approved`; the Phase 3 documents (`27`, `28`, `32`) are
   `Draft` and need the Tech Lead's confirmation before implementation.
3. **Check the open decisions** (`ServiceHub Enterprise.md` §27). If your work depends on
   an unresolved `D-*`, stop and raise it — do not silently pick an option.

---

## Workflow

```
branch → implement → self-review → tests → PR → review → merge
```

| Step | Rule |
|---|---|
| Branch naming | `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` + short description |
| Commits | Imperative and scoped; explain **why**; one logical change |
| Before pushing | `npm run lint && npm run typecheck && npm test` in the app you changed |
| Merge | Green CI (lint, typecheck, tests, security scans) + at least one approval |
| Breaking an `Approved` doc | Requires a doc update or an ADR **in the same change** |

Do not push directly to `main`. Do not force-push shared branches. Never commit secrets.

---

## The review standard

A reviewer approves **behaviour and risk**, not style. Every PR is checked against the
ten questions in `docs/38` §4.1. The ones most often failed:

- Is authorization enforced in the **service**, including object-level access?
- Is every input validated at the boundary?
- Is the audit record written in the same transaction as the mutation?
- Is any query unbounded, unindexed, or N+1?
- Are secrets, tokens or PII absent from logs, errors and audit snapshots?
- Would the tests fail if the behaviour were removed?
- If a migration is added, is it backward compatible across a rolling deploy?

---

## Definition of Done

A change is done when `docs/41-DEFINITION-OF-DONE.md` is satisfied — functional,
correctness, security, audit, performance, testing, quality and operations criteria. Any
item that does not apply is marked **N/A with a reason**, never skipped silently.

---

## Where things are written

| Need | Location |
|---|---|
| Domain feature rules and acceptance criteria | `docs/21`–`docs/28` |
| API contract, error shapes, pagination | `docs/11` |
| Validation schemas | `docs/12` |
| Database model, constraints, indexes | `docs/08`, `docs/09`, `docs/10` |
| Design tokens and components | `docs/15`, `docs/16` |
| Test levels and fixtures | `docs/37` |
| Code conventions and anti-patterns | `docs/38` |

**Rule:** every fact has exactly one home. Link to it; do not restate it in a second
place, because the copy is the one that drifts.

---

## Reporting problems

- **Defects / features:** open an issue with the affected document, the observed
  behaviour, and the expected behaviour per that document.
- **Security:** follow `SECURITY.md` — never a public issue.
