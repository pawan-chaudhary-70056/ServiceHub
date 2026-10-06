# ServiceHub Frontend

React + TypeScript + Vite + Tailwind SPA.

Authoritative documents: `../ServiceHub Enterprise.md` (charter) and `../docs/`
(notably `14` frontend architecture, `15` design system, `16` UI/UX and accessibility,
`12` validation, `07` authorization).

---

## Quick start

```bash
cp .env.example .env
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:4000`, so start the backend too
(or run the root `docker compose up`).

---

## Scripts

| Script              | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | Vite dev server with HMR                    |
| `npm run build`     | Typecheck, then production build to `dist/` |
| `npm run preview`   | Serve the built output locally              |
| `npm run typecheck` | `tsc --noEmit`                              |
| `npm run lint`      | ESLint                                      |
| `npm test`          | Vitest + React Testing Library              |
| `npm run test:e2e`  | Playwright against a running app            |

---

## Structure

The `src/` structure is fixed by the charter §3 and **must not be changed**.

| Folder        | Holds                                                            |
| ------------- | ---------------------------------------------------------------- |
| `api/`        | The API client, React Query client, and per-resource API modules |
| `assets/`     | Static assets and the global stylesheet (design tokens)          |
| `components/` | Design-system components — reusable UI elements only             |
| `hooks/`      | Reusable client-state and server-state hooks                     |
| `pages/`      | Route-level screens                                              |
| `routes/`     | The route table and guards                                       |
| `templates/`  | Page-level layout compositions (see its README)                  |
| `themes/`     | Token maps for JavaScript consumers                              |
| `utils/`      | Pure helpers with no React and no API knowledge                  |
| `validators/` | Zod schemas mirroring the server's rules                         |
| `@types/`     | Ambient declarations (env, globals)                              |

**Tests:** unit and component tests are **co-located** (`*.test.tsx`) per the structure
resolution in charter §3.1; end-to-end specs live in `tests/e2e/` and are run by
Playwright.

---

## Rules that are not stylistic

These come from the architecture and are enforced in review:

1. **The SPA holds no business rules.** Rendering, input collection and UX validation
   only. Permissions, state transitions and SLA arithmetic are decided by the server
   (`docs/03` §3).
2. **Client validation is UX, never a control.** It is trivially bypassed; the server
   validates the same input independently (`docs/12` §1).
3. **A hidden control is not an authorization.** Route guards and conditional rendering
   are convenience; the endpoint must enforce access itself (`docs/07`, `docs/17`).
4. **Never put a secret in a `VITE_` variable.** It is compiled into the client bundle
   and is public (`docs/35` §2).
5. **Never persist a credential by hand.** Sessions are server-side (**ADR-0001**);
   cookies are `HttpOnly` and JS must not touch them (`docs/06`).
6. **Use design tokens and design-system components.** Arbitrary colour values are how a
   design system stops being a system (`docs/15`).
7. **Accessibility is part of done.** Keyboard reachable, labelled controls, visible
   focus, and status conveyed by more than colour (`docs/16`).
8. **Handle four states on every screen:** loading, empty, error, and permission-denied.
   A blank screen for any of them is a defect (`docs/16`).

---

## Current scaffold state

The shell, design tokens, API client, health probe, routing, validation schemas and
test harness are in place. Feature screens are added in phase-2 order (`docs/40`), each
with its route, permission and tests, once its owning document reaches `Approved`.

All open decisions **D-1**–**D-8** are closed (`docs/42`); the decisions relevant to
UI work are **ADR-0001** (server-side sessions — auth handling) and **ADR-0003**
(Redis cache/queue — optimistic UI and live updates).
