# 35 — Deployment and CI/CD

**Status:** Approved · **Owner:** DevOps · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 83, 84, 85, 86 (deployment, environment config, Docker, CI/CD)
**Decided by:** `ADR-0003` (D-3 — Redis/PgBouncer), `ADR-0005` (D-5 — Kubernetes)

> **Scope:** how code becomes a running system — environments, configuration,
> containers, the pipeline, and rolling deploys. **Secret *handling policy*** is `17`;
> this document states **where secrets are injected**. **Recovery** is `36`.

---

## 1. Environments

| Environment | Purpose | Data | Who deploys |
|---|---|---|---|
| Local | Development | Seeded synthetic | Developer |
| CI | Automated tests | Ephemeral, per-run | Pipeline |
| Staging | Pre-production validation | Anonymised/synthetic, production-shaped | Pipeline on merge |
| Production | Live | Real | Pipeline on release, with approval |

**Staging must be production-shaped** — same container, same migration path, same
configuration shape. Staging that is "almost production" validates almost nothing.

Production data never enters staging except as anonymised data through a documented
process (`19`); copying a production database to staging to reproduce a bug is how a
compliance incident starts.

## 2. Configuration

- All configuration is **typed environment variables**, loaded and validated at boot
  (`03` §9). Missing or malformed required configuration **fails fast** — a service
  that boots with a missing database URL and fails later is worse than one that refuses
  to start.
- Configuration is documented in `.env.example` (backend) and the frontend `.env`, one
  entry per variable, with meaning and whether it is secret.
- The same image runs in every environment; **only configuration differs**. A
  per-environment build means staging does not test the production artifact.

| Class | Examples | Handling |
|---|---|---|
| Connection | `DATABASE_URL`, cache/queue URLs | Secret if it embeds credentials |
| Auth | signing keys, session secrets | Secret (`17`) |
| Providers | email/SMS/integration creds (**D-6**) | Secret |
| Behaviour | log level, feature flags, rate limits | Non-secret config |
| Frontend | API base URL, public flags | **Public by definition** — nothing secret may reach the frontend bundle |

**Frontend rule:** anything in a `VITE_` variable is compiled into the client and is
public. An API key in a `VITE_` variable is a leaked API key; the review checklist
(`38`) treats it as a defect.

## 3. Containers

- Multi-stage builds: build stage with dev dependencies, runtime stage with production
  dependencies only.
- Non-root user at runtime.
- No secrets, no `.env`, no source maps for production code baked into the image.
- Explicit `HEALTHCHECK` / probe configuration matching `34` §6.
- `.dockerignore` excludes `node_modules`, tests, and local artefacts.
- Pinned base-image versions; images scanned for known vulnerabilities in CI.
- Small runtime image reduces attack surface (`18`).

### Compose (local and simple deployments)

`docker-compose.yml` provides: frontend (Vite), backend, PostgreSQL, a cache/queue
service (Redis, `ADR-0003`), and a local mail catcher. Local parity is the point — a developer
who cannot reproduce an issue locally with the same service set debugs blind.

## 4. CI Pipeline

```
push / PR
   ↓
lint  →  typecheck  →  unit tests  →  build
   ↓
integration tests (against ephemeral Postgres)
   ↓
security checks (dependency audit, secret scan, SAST)
   ↓
container build + scan
   ↓
migration check (schema validates; migrations apply cleanly on a scratch DB)
   ↓
deploy to staging (on merge)
   ↓
smoke + E2E against staging
   ↓
release approval → production
```

| Gate | Purpose | Must fail the build? |
|---|---|---|
| Lint + format | Consistency (`38`) | Yes |
| Typecheck | Type errors never reach review | Yes |
| Unit tests | Logic (`37`) | Yes |
| Integration/API tests | Real database behaviour | Yes |
| Migration check | Every migration applies and reverses | Yes |
| Secret scan | Prevents committing credentials | Yes |
| Dependency audit | Known-vulnerable packages | Yes for high/critical |
| Container scan | Image vulnerabilities | Yes for high/critical |
| Coverage | Not a hard gate at a fixed number, but must not regress on changed code | Warn |

**No pipeline step is optional for main-branch merges.** A flaky test is quarantined
and fixed, never skipped silently — a skipped test is a false claim of safety.

## 5. Migrations in Deployment

Migration strategy is owned by `10`; the deployment rules are:

1. Migrations run **before** the new application version starts serving traffic.
2. Migrations must be **backward compatible** with the currently running version
   (expand → migrate → contract), because during a rolling deploy both versions run at
   once against one schema.
3. Destructive migrations (dropping a column/table) happen in a **later** release, only
   after the previous version is fully retired.
4. A migration failure aborts the deploy; the previous version keeps running.
5. Migrations are idempotent where possible and timed; a migration that locks a large
   table is reviewed for `CONCURRENTLY` (`10`).

**The rolling-deploy constraint is the whole reason for expand/contract.** A migration
that drops a column still in use by the old version takes down the site mid-deploy.

## 6. Release and Rolling Deployment

| Concern | Rule |
|---|---|
| Artifact | Immutable image per release, tagged by commit |
| Deploy strategy | Rolling: new instances become ready, then old ones drain (graceful shutdown, `03` §8) |
| Health gating | New instances must pass readiness before old ones are removed |
| Rollback | The previous image is redeployable; schema changes are backward compatible so rollback is a code change, not a data restore |
| Zero downtime | Availability during deploy is a stated requirement; a maintenance window is a fallback, not the design |
| Feature flags | Risky changes ship dark, then enable; flags are removed once stable (no permanent flags) |
| Version visibility | The running version is exposed on a health endpoint and in logs at boot |

## 7. Secrets Injection

| Environment | Mechanism |
|---|---|
| Local | `.env`, git-ignored |
| CI | Pipeline secrets |
| Staging/Production | Platform secret store / orchestrator secrets (**D-5** — Kubernetes, `ADR-0005`) |

Rules: secrets are injected at runtime, never baked into an image; the application
reads them through typed config, never from a committed file; rotation is possible
without a rebuild; and access to the secret store is itself audited where the platform
supports it. The *policy* (classification, rotation cadence, handling) is `17`.

## 8. Environments and Data Seeding

- Local/CI databases are created by migrations plus a deterministic seed (`10`).
- Seed data is synthetic; no real personal data in any non-production environment.
- Seeds are idempotent so a freshly created database and an existing one converge.

## 9. Failure Behaviour

| Failure | Behaviour |
|---|---|
| Migration fails | Deploy aborts; old version keeps running |
| New instances fail readiness | Deploy halts; old version keeps serving; alert |
| Smoke test fails post-deploy | Automatic rollback to the previous image |
| Secret missing at boot | Application refuses to start with a clear error, and the orchestrator does not roll forward |
| Container scan finds critical CVE | Build fails; an explicit, time-boxed exception is required to proceed |

## 10. Open Decisions

| ID | Decision | Effect |
|---|---|---|
| D-3 | Cache/queue provider | **Closed** (`ADR-0003`) — Compose services and production dependencies |
| D-5 | Orchestrator | **Closed** (`ADR-0005`, Kubernetes) — deploy mechanics, probes, secret injection |
| D-6 | Email/SMS provider | Required provider configuration |

## 11. Acceptance Criteria

1. The same image runs in staging and production; only configuration differs.
2. Every migration applies forward on a scratch database in CI, and the deploy path is
   proven backward compatible with the previous version.
3. A failed readiness check halts the deploy; the previous version keeps serving.
4. Rollback to the previous image works without a data restore for any release in the
   last N releases.
5. No secret value appears in the repository, the image, or CI logs.
6. No secret is referenced from a frontend `VITE_` variable.
7. Lint, typecheck, tests, security scan and migration check all gate main-branch merges.
8. Graceful shutdown drains in-flight requests; a rolling deploy causes no failed
   requests in a smoke test.

## 12. Related

- `10-MIGRATIONS-AND-SEEDING.md` — the migration strategy this deploys
- `17-SECURITY-ARCHITECTURE.md` — secret policy and supply-chain security
- `34-OBSERVABILITY.md` — probes and log collection
- `36-OPERATIONS-AND-RECOVERY.md` — rollback, backup, disaster recovery
- `37-TESTING.md` — the test layers the pipeline runs
