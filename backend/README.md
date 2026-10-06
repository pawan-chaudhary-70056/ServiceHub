# ServiceHub Backend

Node.js + Express + TypeScript REST API over PostgreSQL (Prisma).

Authoritative documents: `../ServiceHub Enterprise.md` (charter) and `../docs/`
(notably `03` architecture, `07` authorization, `08` data model, `11` API contract,
`12` validation, `13` backend architecture, `17` security, `31` audit, `33` scalability).

---

## Quick start

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run dev          # http://localhost:4000
```

Needs PostgreSQL (and optionally Redis) — easiest via the root compose file:

```bash
docker compose up -d postgres redis mailpit
```

---

## Scripts

| Script                          | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `npm run dev`                   | Watch-mode server (`tsx watch`)                    |
| `npm run build`                 | Emit to `dist/` (`tsconfig.build.json`)            |
| `npm start`                     | Run the compiled server                            |
| `npm run typecheck`             | `tsc --noEmit` over `src` and `tests`              |
| `npm run lint`                  | ESLint, including the module import-boundary rules |
| `npm test`                      | Vitest (unit + API + integration)                  |
| `npm run prisma:migrate`        | Create and apply a migration in development        |
| `npm run prisma:migrate:deploy` | Apply pending migrations (CI / production)         |

---

## Structure and layer mapping

The `src/` structure is fixed by the charter (`ServiceHub Enterprise.md` §3) and **must
not be changed**. One mapping needs stating because the architecture names a layer the
structure does not contain:

| Layer (`docs/03` §3)       | Folder                      |
| -------------------------- | --------------------------- |
| routes                     | `src/routes/`               |
| controllers                | `src/controllers/`          |
| services                   | `src/services/`             |
| repositories (data access) | **`src/models/`**           |
| validation                 | `src/validators/`           |
| middleware                 | `src/middlewares/`          |
| helpers                    | `src/helpers/`              |
| adapters                   | `src/integrations/`         |
| async jobs                 | `src/jobs/`                 |
| infrastructure             | `src/config/`, `src/utils/` |
| type augmentation          | `src/@types/`               |

`docs/03` names a repositories layer, but the mandated structure has no
`repositories/` directory. The mandated `models/` folder is therefore the data-access
home: entity query modules live there, only `services/` may import them, and the ESLint
config enforces it. Controllers are forbidden from importing `@prisma/client` or
`models/` directly.

**Dependency direction (enforced by lint, not by review):**

```
routes → controllers → services → models → prisma
                          │
                          ├→ integrations (via domain interfaces)
                          ├→ jobs (enqueue only)
                          └→ cache (via an interface only)
```

---

## Non-negotiable implementation rules

These are enforced in review and, where expressible, by lint (`docs/38` §4.1):

1. **Authorization in the service layer**, including object-level access. A caller who
   may not _see_ a record gets `404`, not `403`, so the API does not disclose existence.
2. **Validate at the boundary** with Zod (`src/middlewares/validate.ts`). Client-side
   validation is UX only and never a control.
3. **Audit in the mutation's transaction.** A mutation that commits without an audit row
   is a defect (`docs/31` §3.1).
4. **Outbox in the mutation's transaction.** Never send email or call an external system
   inline (`docs/29` §3).
5. **No external I/O inside a transaction.**
6. **Every list is paginated**; cursors for records. No unbounded query.
7. **Every filter/sort column is indexed**; review `EXPLAIN` for new queries over large
   tables (`docs/09`, `docs/33` §7).
8. **No secret or PII in logs, errors or audit snapshots** — the Pino `redact` list in
   `src/utils/logger.ts` is the mechanism, not the whole rule.
9. **Never edit a deployed migration**; migrations are backward compatible across a
   rolling deploy (`docs/10`, `docs/35` §5).

---

## Known scaffold limitations (stated, not hidden)

| Area | Limitation | Owner |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- || Rate limiting | Counters use the shared Redis store when `REDIS_URL` is set (**ADR-0003**), so limits hold across instances. Without it (local/test) an in-memory store is used — a stated, non-production fallback. The credential surface fails **closed** and the general surface fails **open** during a store outage (`docs/33` §6). | `docs/33` §6 |
| Cache / queue | The Redis client, key namespaces and a degradation circuit breaker are wired for **session lookups** and **rate limits**. Other cache regions (catalog, KB) and the **job worker/broker** are not implemented yet (`docs/29`). | `docs/33`, `docs/29` |
| Authentication | Server-side sessions, login/logout, password reset, invitation acceptance, CSRF and tenant provisioning are implemented (`ADR-0001`, `ADR-0012`). Session resolution uses a shared Redis lookup cache with the `sessions` row as the durable source of truth, so revocation survives a cache flush and a cache outage degrades to the database (`docs/33` C4). | `docs/06`, `docs/33` |
| Integrations | Provider adapters are not wired yet (**ADR-0006**: SendGrid/Twilio via Knock). | `docs/32` |
| Prisma schema | Platform spine slice added (tenancy, identity, authorization, teams, audit, outbox); domain entities follow per `docs/05`. | `docs/08`, `docs/10` |

---

## Migrations

See `prisma/migrations/README.md`. Summary: expand → migrate → contract; never rewrite a
deployed migration; a migration failure aborts the deploy and the previous version keeps
serving.
