# 39 — AI Agent Instructions and Workflow

**Status:** Approved · **Owner:** Tech Lead · **Reviewer:** — · **Approved:** 2026-10-01
**Consolidates:** old 98, 99 (AI agent instructions, AI implementation workflow)

> **Scope:** how an automated coding agent (and a human using one) works inside this
> repository. This document is the agent's operating contract. It does not restate the
> architecture — it says **which document to read for what** and **what the agent must
> never do**.

---

## 1. The Agent's Prime Directive

An agent working on ServiceHub must behave like a careful contributor who has read the
`Approved` documents — not like an autocomplete that produces plausible code. Three
rules follow:

1. **Read before writing.** The owning document for the task is the specification. Code
   that contradicts an `Approved` document is wrong even if it compiles and passes
   locally.
2. **Never invent a decision.** When a document marks something open (`D-1`…`D-8`) or a
   requirement is unspecified, the agent **stops and asks**, or proposes options with
   trade-offs. A fabricated decision silently becomes technical debt everyone trusts.
3. **State uncertainty.** An agent that reports "done" for partially verified work
   causes more harm than one that reports exactly what it verified and what it did not.

## 2. Where to Read for What (Route, Don't Restate)

| The task is about… | Read first |
|---|---|
| Whether a feature should exist / what it must do | `02`, `05`, then the owner doc `21`–`33` |
| Which document owns a concern | `00-DOCUMENTATION-PLAN.md` §3, §5 |
| System structure, layers, async tier | `03` |
| End-to-end flows | `04` |
| Identity and login | `06` |
| Who may do what | `07` |
| Tables, fields, relationships | `08` |
| Constraints and indexes | `09` |
| Migrations and seeds | `10` |
| Endpoints, shapes, errors, pagination | `11` |
| Input validation | `12` |
| Backend layering | `13` |
| Frontend structure, routing, state | `14` |
| Visual tokens and components | `15` |
| Pages, forms UX, accessibility | `16` |
| Security posture, secrets, secure coding | `17` |
| Threats and trust boundaries | `18` |
| Files, retention, classification | `19` |
| Security tests | `20` |
| A domain feature | its doc in `21`–`28` |
| Notifications, search, audit | `29`, `30`, `31` |
| Integrations, scaling, observability | `32`, `33`, `34` |
| Build, deploy, recovery | `35`, `36` |
| How to test | `37` |
| How to write and review code | `38` |
| What "done" means | `41` |
| Why something is the way it is | `42` |
| What changed | `43` |

**Rule:** before implementing, the agent names the owning document in its plan. If it
cannot name one, the task is under-specified — ask.

## 3. The Agent Workflow

```
1. UNDERSTAND
   - Read the task and the owning document(s).
   - Identify open decisions (D-1…D-8) that block the task → ask, do not guess.

2. PLAN
   - State the files to change, the owning doc, and the acceptance criteria to satisfy.
   - Surface any conflict between the task and an Approved document.

3. IMPLEMENT IN SMALL STEPS
   - Follow §4's hard rules below at every step.
   - Do not exceed the task's scope; unrelated fixes are separate changes.

4. VERIFY
   - Run typecheck, lint, and the relevant tests (37).
   - For non-trivial changes, run the owning doc's Acceptance Criteria as tests.

5. REVIEW AGAINST THE TEN QUESTIONS (38 §4.1)
   - Authorization, validation, audit, query shape, boundaries, secrets, tests.

6. REPORT
   - State what was done, what was verified, and what could not be verified.
   - If a document must change, update it in the same change (or raise an ADR).

7. STOP AT THE GATE
   - Do not advance past an approval gate (section 4) without sign-off.
```

## 4. Hard Rules (Never Violate)

| # | Rule | Owning doc |
|---|---|---|
| A1 | Enforce authorization in the **service**, including object-level access — never only in the route | `07`, `17` |
| A2 | Validate every input at the boundary with Zod; the client is not a control | `12` |
| A3 | Write the audit row in the same transaction as the mutation | `31` |
| A4 | Write the outbox row in the same transaction as the event; never send inline | `29` |
| A5 | No external I/O inside a transaction | `33` |
| A6 | Every list is paginated; no unbounded query | `11`, `33` |
| A7 | Every filter/sort column is indexed; review `EXPLAIN` for large tables | `09` |
| A8 | No secret, token, or PII in logs, errors, or audit snapshots | `34`, `31` |
| A9 | Never modify a migration that has been deployed; add a new one | `10` |
| A10 | Migrations are backward compatible across a rolling deploy | `35` |
| A11 | Never delete or rewrite an audit row; never add an update path to a decision | `31`, `26` |
| A12 | Never hard-delete a record that history references; retire it | `08` §5, `21`, `28` |
| A13 | Do not change the mandated folder structure | charter, `38` §3 |
| A14 | A change that contradicts an `Approved` document requires the doc update or an ADR in the same change | `00` R5, `42` |
| A15 | Do not fabricate a decision for an open item; ask or propose options | this doc §1 |

## 5. What the Agent Must Ask Rather Than Assume

- Any `D-1`…`D-8` decision that the task depends on.
- A required behaviour absent from the owning document.
- A conflict between the task and an `Approved` document.
- A choice with irreversible cost (dropping data, changing an identifier scheme,
  changing a public API shape).
- Whether a new dependency may be added (prefer none; verify first).

## 6. Scope Discipline

- Implement the task, no more. Drive-by refactors, formatting churn, and "while I'm
  here" changes make review impossible and hide regressions.
- Follow existing conventions before inventing new ones.
- Prefer editing an existing file over adding a new one when both fit.
- Do not add a dependency for something a few lines of code does correctly, and do not
  hand-roll something a standard, maintained library already does safely.

## 7. Verification Requirements by Change Type

| Change | Minimum verification |
|---|---|
| Pure function / validator | Unit test with accept and reject cases |
| Service rule | Integration test against real PostgreSQL |
| Endpoint | API test: success, validation, authorization (incl. 404-vs-403), pagination |
| Migration | Applies forward on a scratch DB; backward compatible with the running version |
| Frontend component | Component test + accessibility check (`16`, `37`) |
| Security-relevant | Negative test proving the control denies (`20`) |
| Performance-relevant | Before/after measurement (ADR, `42`) |

## 8. Definition of Done and Gates

The agent does not self-certify done; it satisfies `41-DEFINITION-OF-DONE.md` and stops
at the phase gate defined in `40-IMPLEMENTATION-PLAN-AND-PHASES.md`. "Tests pass
locally" is necessary, not sufficient.

## 9. Interaction with Open Decisions

When a task is blocked by an open decision:

1. State which decision and which document it blocks.
2. Present the options with trade-offs (the affected docs list them).
3. If the user chooses, record it as an ADR (`42`) and update the blocked documents.
4. Then implement.

The agent never closes a decision by silently implementing one option.

## 10. Acceptance Criteria

1. Every implementation plan names its owning document; a task with no owning document
   is escalated rather than guessed.
2. No change violates the §4 hard rules; each has a corresponding verification.
3. A change conflicting with an `Approved` document is accompanied by a doc update or
   an ADR.
4. Open decisions are surfaced, not assumed.
5. Verification is reported honestly, distinguishing verified from unverified.

## 11. Related

- `00-DOCUMENTATION-PLAN.md` — ownership and rules
- `38-CODE-QUALITY-AND-GUIDELINES.md` — the review standard the agent must meet
- `41-DEFINITION-OF-DONE.md` — the gate
- `40-IMPLEMENTATION-PLAN-AND-PHASES.md` — phase order and gates
- `42-ADRS-AND-CHANGE-REQUESTS.md` — how decisions are recorded
