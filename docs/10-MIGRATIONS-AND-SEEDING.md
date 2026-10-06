# 10 — Migrations and Seeding

**Status:** Approved · **Owner:** DBA · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 16 (database migration and seeding)

> **Scope:** how the schema changes over time and how environments get their initial
> and reference data. Schema shape is `08`; indexes are `09`; deploy flow is `35`.

---

## 1. Why This Document Is Load-Bearing

Schema change is the one operation that can take the whole platform down and cannot
be rolled back by redeploying. With N backend instances running old and new code
simultaneously during a rollout, a migration that is correct in isolation can still
break production. Every rule below exists because of that overlap window.

## 2. Migration Model

- **Tool:** Prisma Migrate. `backend/prisma/schema.prisma` is the single source of
  truth; migrations are generated and committed.
- **Never** hand-edit an applied migration. **Never** use `prisma db push` outside
  local development — it silently skips migration history and is forbidden in any
  environment that has data worth keeping.
- Every migration is **reviewed** as production code, with the checklist in §6.
- Migrations are **additive-first** (§4). Destructive steps are a separate, later
  migration after the code that used the object is gone.

## 3. Naming and Structure

```
prisma/migrations/
  20260115103000_init_identity/
  20260118141500_add_catalog/
  20260202112000_add_sla_clock_state_index/
```

Name pattern: `<timestamp>_<verb>_<subject>` — the verb says what happens, the
subject says to what. A migration whose name does not tell a reviewer what it does
gets renamed.

## 4. Zero-Downtime Change Pattern

The mandatory sequence for any change that old and new code cannot both tolerate.
The three phases are **separate deployments**, not separate steps in one migration.

### Expanding a required field

```
PHASE 1 (deploy N)   add nullable column
                     write to BOTH old and new fields in application code
PHASE 2 (backfill)   run a batched backfill job, throttled
PHASE 3 (deploy N+1) stop writing the old field · set NOT NULL · drop old field
```

### Renaming a column

Never `ALTER ... RENAME`. That is a Phase-1 addition plus a Phase-3 removal.

### Adding an index

`CREATE INDEX CONCURRENTLY` — outside a transaction, since it cannot run inside one.
Backfill is not required for indexes, but build time on large tables is.

### Changing a column type

Add the new column, backfill, dual-write, switch reads, drop the old one. An in-place
`ALTER TYPE` takes an `ACCESS EXCLUSIVE` lock and rewrites the table.

### Removing a column or table

Only after no deployed code references it, verified by search, not by memory.

**Lock safety:** any DDL that takes an `ACCESS EXCLUSIVE` lock must state in its
migration comment how long it is expected to hold it. On large tables, that lock
blocks *all* reads and writes, which is an outage, not a slowdown.

## 5. Backfills

| Rule | Reason |
|---|---|
| Batched, not one statement | A single `UPDATE` over 5 M rows holds locks and floods WAL |
| Throttled with a sleep between batches | Leaves capacity for live traffic |
| Idempotent and resumable | It will be interrupted; resume from a checkpoint |
| Run as a job, not part of the migration | Migration time must be bounded and predictable |
| Progress observable | Emits metrics; operator can watch it drain |
| Safe to re-run | Operators will re-run it |

## 6. Migration Review Checklist

Every migration PR is checked against this list before merge:

1. Does it take an exclusive lock, and on what table size?
2. Can the current deployed code still run against the new schema? (Backward compatible?)
3. Can the *next* code run against the *old* schema during rollout? (Forward compatible?)
4. Is the backfill batched and resumable?
5. Is the migration reversible, and if not, is that stated explicitly?
6. Are new columns nullable or defaulted? (A `NOT NULL` without a default fails on existing rows.)
7. Do indexes use `CONCURRENTLY` where the table is large?
8. Is a `DEFAULT` volatile? (Volatile defaults rewrite the table on older PostgreSQL.)
9. Does it drop anything still referenced by code?
10. Is there a rollback plan, and has it been stated in the PR description?

## 7. Rollback Policy

| Change | Rollback |
|---|---|
| Additive (new table/column/index) | Leave in place; code rollback is sufficient |
| Data backfill | Not automatically reversed; write a compensating migration |
| Destructive (drop) | **Not reversible** — hence the expand/contract separation |
| Data correction | Reversed by an explicit compensating migration, never a manual edit |

**Rule:** rollback is achieved by rolling back the *application*, not the database.
This is why additive-first is mandatory: it makes every deployment reversible by
redeploying the previous image.

## 8. Seeding

Three distinct categories, never mixed:

| Category | Content | Environments | Idempotent | In migrations? |
|---|---|---|---|---|
| Reference data | Permission catalogue, default roles, enums surfaced as rows | All | Yes | Yes (small, stable) |
| Baseline configuration | Default SLA policy skeleton, workflow templates | All | Yes | Yes |
| Demo/fixture data | Sample users, teams, tickets, assets | Local + staging only | Yes | **No** — separate script |
| Administrative bootstrap | First **platform operator**, then tenant provisioning | All | Yes, guarded | **No** — provisioned at deploy |

**Never** seed demo data into production. **Never** seed production users into a
fixture script.

Reference data is seeded **idempotently** (`upsert` keyed on a stable natural key), so
re-running is safe and adding a permission does not duplicate existing ones.

### Bootstrap rules

> **`ADR-0012` (Accepted, 2026-10-02).** These rules replace the earlier "first
> administrator" wording, which never said who created that administrator's tenant.

- The **first platform operator (Super Admin)** is created by a one-time command or an
  environment-provided bootstrap secret — never a hard-coded default password in a seed
  file. It is a member of **no** organization (`ADR-0012`, *proposed*).
- Bootstrap is **guarded**: if a platform operator already exists, it refuses and exits
  0, so it is safe to re-run.
- The bootstrap event is **audited**: actor type `SYSTEM`, action `platform.bootstrap`.
- **Tenant provisioning** is the next step and is owned by `04` §13.2: a platform
  operator creates an `Organization` and, in the **same transaction**, seeds that
  tenant's reference data (default roles + role→permission mapping per `07` §3; baseline
  business calendar and SLA policy skeleton per `25` / `ADR-0008`). A tenant therefore
  never exists half-configured.
- The first tenant Administrator is never seeded with a default password; the credential
  is delivered through the **invitation** flow (`06` §11), not a fixture.

## 9. Environment Rules

| Environment | Migration execution | Seed |
|---|---|---|
| Local | On start (`migrate dev`) | Full fixture set |
| CI | Ephemeral database, migrations applied from scratch | Reference + minimal fixture |
| Staging | Pipeline step before app rollout | Reference + baseline |
| Production | Pipeline step, with backup verification first | Reference + baseline only |

Migrations run **once**, as a distinct pipeline step, before the application rollout —
never concurrently from every starting instance. N instances racing the same migration
is a known way to corrupt a migration history table.

## 10. Drift and Verification

| Check | Mechanism |
|---|---|
| Schema drift | CI compares `schema.prisma` against the migration history |
| Migration history integrity | CI applies all migrations to an empty database |
| Forward/backward compatibility | CI runs the previous release's tests against the new schema |
| Seed idempotency | CI runs the seed twice and asserts no duplicates |
| Unapplied migrations | Deploy refuses to proceed if the database is behind |

## 11. Related

- `08-DATA-MODEL.md` — what the schema contains
- `09-DATA-INTEGRITY-AND-INDEXING.md` — index definitions and concurrent creation
- `35-DEPLOYMENT-AND-CI-CD.md` — where migrations run in the pipeline
- `36-OPERATIONS-AND-RECOVERY.md` — backup before migration, restore procedures
