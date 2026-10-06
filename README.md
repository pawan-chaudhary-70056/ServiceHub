# ServiceHub

Enterprise Service Management Platform — service catalog, requests, incidents, tasks,
SLA, approvals, knowledge base and assets, with audit, notifications and reporting.

**The authoritative documents are `ServiceHub Enterprise.md` (the master charter) and
`docs/` (44 documents).** This README tells you how to run the code; the charter and
`docs/` tell you what the code must do.

---

## Status

The **Phase 0 set** (`docs/00`, `01`, `02`, `40`, `41`, `42`, `43`), the **Phase 1
design set** (`03`–`19`, `38`, `39`) and the **Phase 2 core documents** (`20`, `21`,
`22`–`26`, `29`–`31`, `33`–`37`) are **`Approved`** (2026-10-01): **Gate 1 is passed** and the
**Phase 2 entry gate is met**. All decisions `D-1`–`D-9` are closed (`D-1`–`D-8` by
`ADR-0001`–`ADR-0008`; `D-9` by `ADR-0012`, accepted 2026-10-02). **Gate 2 is not
passed** — its exit criteria require the built system. The Phase 3 documents (`27`,
`28`, `32`) remain `Draft`. Only `Approved` documents may be implemented against. The
repository contains the **scaffold** plus the Phase 2 identity slice; domain features are
built per the phase plan.

---

## Layout

| Path | Contents |
|---|---|
| `ServiceHub Enterprise.md` | Master charter: architecture, structure, baseline, governance |
| `docs/` | The 44-document set (`00`–`43`) |
| `frontend/` | React + TypeScript + Vite + Tailwind SPA |
| `backend/` | Node.js + Express + TypeScript REST API |
| `docker-compose.yml` | Local stack: Postgres, Redis, mail catcher, both apps |

The `frontend/src/` and `backend/src/` structures are fixed by the charter and
**must not be changed**.

---

## Requirements

- Node.js 22+ (developed on Node 24)
- npm 10+
- Docker + Docker Compose (for the local stack)

---

## Quick start

### 1. Local stack (recommended)

```bash
docker compose up -d postgres redis mailpit
```

### 2. Backend

```bash
cd backend
cp .env.example .env          # then edit if your ports differ
npm install
npm run prisma:generate
npm run dev                   # http://localhost:4000
```

Health: `GET /api/health/live` and `GET /api/health/ready`.

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:5173
```

### Everything with Docker

```bash
docker compose up --build
```

---

## Common commands

| Where | Command | Purpose |
|---|---|---|
| backend | `npm run dev` | Watch-mode API |
| backend | `npm run typecheck` | `tsc --noEmit` |
| backend | `npm test` | Vitest (unit + integration) |
| backend | `npm run lint` | ESLint |
| backend | `npm run prisma:migrate` | Create/apply a migration |
| frontend | `npm run dev` | Vite dev server |
| frontend | `npm run build` | Production build |
| frontend | `npm run typecheck` | `tsc --noEmit` |
| frontend | `npm test` | Vitest + React Testing Library |
| frontend | `npm run test:e2e` | Playwright against a running app |

---

## Conventions

- TypeScript `strict`; no implicit `any`; `unknown` at boundaries (`docs/38`).
- Validation with Zod **at every boundary**; the client is never a control (`docs/12`).
- Authorization is enforced in the **service layer**, including object-level access
  (`docs/07`, `docs/17`).
- Every mutation writes an audit record **in the same transaction** (`docs/31`).
- Non-immediate work (email, reports, notifications) is queued via the **outbox**, never
  awaited inline (`docs/29`).
- Never commit secrets; `.env` is git-ignored and `.env.example` documents the surface.

Frontend tests are co-located (`*.test.tsx`); E2E specs live in `frontend/tests/`
(charter §3.1).

---

## Contributing

See `CONTRIBUTING.md`. Security policy: `SECURITY.md`. Change history: `docs/43`.
