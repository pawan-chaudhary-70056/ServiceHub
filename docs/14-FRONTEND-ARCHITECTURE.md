# 14 — Frontend Architecture

**Status:** Approved · **Owner:** Frontend Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 31, 32, 39, 40 (frontend requirements, architecture, routing,
state management) and the routing half of old 33 (frontend flow)
**Decided by:** **ADR-0001** (D-1 — server-side session cookie)

> **Scope:** application structure, routing, state, data fetching. Visual language is
> `15`; pages and interaction detail are `16`.

---

## 1. Stack and Rationale

| Concern | Choice | Why this one |
|---|---|---|
| Framework | React + TypeScript | Specified; type safety across the API boundary |
| Build | Vite | Fast dev feedback; static production output |
| Styling | Tailwind CSS | Tokens live in config (`15`), no bespoke CSS drift |
| Routing | React Router | Fixed route table; nested layouts |
| Server state | TanStack Query | Caching, retries, invalidation, request de-duplication |
| Forms | React Hook Form | Uncontrolled inputs; minimal re-render; schema resolver |
| Validation | Zod | Same rules as the server (`12`) |
| HTTP | A single typed API client | One place for auth, errors, correlation ids |

**Explicitly not used:** a global client-state store for server data. Server data
lives in the query cache; a store that duplicates it produces two sources of truth
that disagree after every mutation.

## 2. Folder Structure

```
frontend/src/
├── @types/       global types and API DTO types
├── api/          client, endpoints, query keys
├── assets/       static files
├── components/   design-system components (see 15)
├── hooks/        reusable hooks (auth, permissions, pagination, forms)
├── pages/        route-level screens
├── routes/       route table, guards, loaders
├── templates/    page-level layouts (shell, auth layout, error layout)
├── themes/       theme tokens and providers
├── utils/        formatting, dates, errors — pure helpers
├── validators/   Zod schemas shared with form resolvers
├── app.tsx       providers + router assembly
└── main.tsx      entry point
```

The structure is fixed (charter §3). Note that `components/` holds the design system
only; page-specific composition belongs in `pages/`.

## 3. State Taxonomy

Getting this classification right eliminates most React state bugs.

| Kind | Example | Lives in |
|---|---|---|
| Server state | Requests list, current user, catalog items | TanStack Query cache |
| URL state | Filters, sort, page cursor, selected tab | The URL (search params) |
| Form state | Field values, dirty/touched, errors | React Hook Form |
| Local UI state | Open/closed menus, transient selection | `useState` in the nearest component |
| Session state | Identity and entitlements | Auth context (derived from `GET /auth/me`) |

**Rules**

- Filters, sort and pagination live in the URL so a view is shareable and survives
  refresh. Users of this product share filtered queue links constantly.
- Never copy server data into `useState` — the cache is invalidated; a copied value
  is not.
- Derived values are computed, not stored. Two stored values that must agree
  eventually will not.

## 4. Data Fetching

| Concern | Rule |
|---|---|
| Query keys | Structured and centralised (`['requests', 'list', filters]`) — ad-hoc string keys are the main cause of stale-cache bugs |
| Invalidation | Mutations invalidate the affected keys explicitly; no blanket "refetch everything" |
| Optimistic updates | Only for reversible, low-risk actions (status toggle, comment post); never for approval decisions or anything with money/SLA consequence |
| Retries | Reads retry with backoff; **mutations do not** unless an idempotency key is supplied |
| Stale time | Reference data (catalog, teams, roles) long; queue data short |
| Error handling | Every query declares its error state; a failed fetch renders an error, never an empty list |
| Suspense | Used for route-level loading where it simplifies the page; not a blanket policy |
| Prefetch | On hover for high-traffic navigation targets |

**A failed fetch must never look like "no results".** Rendering an empty table for a
`500` teaches users the data is gone. These are distinct states with distinct UI
(`16` §4).

## 5. API Client

```
api/
├── client.ts      fetch wrapper: base URL, credentials, CSRF, correlation id,
│                  problem+json parsing, typed errors, 401 handling
├── keys.ts        query key factory
├── requests.ts    endpoint functions per module
└── types.ts       DTO types
```

| Concern | Behaviour |
|---|---|
| Auth | Sends the session cookie with `credentials: 'include'`; no token is persisted client-side (`ADR-0001`) |
| CSRF | Attaches the `X-CSRF-Token` header on state-changing requests (`ADR-0001`) |
| Errors | Parses the problem envelope (`11` §4) into a typed `ApiError` carrying `code`, `status`, `errors[]` |
| `401` | Clears session state and redirects to login, preserving the intended destination |
| `403` | Renders a permission-denied state, not a crash |
| `429` | Surfaces `Retry-After` and disables the action until it elapses |
| `409 VERSION_CONFLICT` | Prompts a refresh rather than silently overwriting |
| Correlation id | Captured and shown in an error detail view so a user can quote it to support |

**Never** build a second fetch path. Ad-hoc `fetch` calls in components bypass error
handling, CSRF, and correlation ids.

## 6. Routing

```
/                      → redirect to /dashboard (or /login)
/login                 → public
/forgot-password       → public
/reset-password        → public
/dashboard             → authenticated
/catalog               → authenticated
/catalog/:itemId       → authenticated
/requests              → authenticated, permission: request:read
/requests/new          → permission: request:create
/requests/:id          → authenticated, object-checked server-side
/incidents, /incidents/:id
/tasks
/approvals             → permission: approval:decide (or read for leads)
/knowledge, /knowledge/:slug
/assets, /assets/:id
/reports               → permission: report:read
/audit                 → permission: audit:read
/admin/*               → permission: admin:config
/403, /404, /500       → status pages
```

**Route guard rules**

1. Guards are **UX only** (`07` §6). The server re-checks every access.
2. Guards check the entitlement set, not role names.
3. An unauthenticated visitor is redirected to login with the target preserved.
4. An authenticated visitor lacking entitlement gets `/403`, not a redirect loop.
5. Object-level access failures surface from the API as `404`/`403` and are rendered
   as status states on the page, not as blank screens.

## 7. Layout and Composition

| Template | Used by |
|---|---|
| `AppShell` | Primary authenticated pages: top bar, side navigation, content region, notification tray |
| `AuthLayout` | Login, forgot/reset password |
| `DetailLayout` | Record detail pages: header with key fields, tabbed body, activity sidebar |
| `ErrorLayout` | 403/404/500 status pages |

Layouts own chrome; pages own content. A page never re-implements navigation.

## 8. Performance

| Concern | Rule |
|---|---|
| Route-level code splitting | Every route is lazily loaded |
| Bundle budget | Enforced in CI; a regression fails the build (`37` §Performance) |
| List rendering | Virtualise lists beyond ~100 rows |
| Re-renders | Memoise expensive derivations; avoid passing new object literals to memoised children |
| Images | Sized, lazy-loaded, served from object storage/CDN |
| Accessibility cost | No animation that cannot be reduced (`prefers-reduced-motion`) |

## 9. Errors and Boundaries

- A top-level **error boundary** prevents a render crash from white-screening the app.
- Route-level boundaries isolate failures so one broken page does not take the shell.
- Boundaries report to logging (`34`) with the correlation id where available.
- A crashed page offers a reload and, where relevant, the correlation id for support.

## 10. Testing Seams

| Level | Tool | Scope |
|---|---|---|
| Component | React Testing Library | Behaviour through the accessible surface, not implementation detail |
| Hook | RTL `renderHook` | Auth, permissions, pagination |
| Page | RTL with a mocked API client | Loading, empty, error, permission-denied states per page |
| Contract | Generated types from OpenAPI | A backend rename becomes a compile error |
| E2E | Browser automation | Critical journeys only (`37`) |

**Query by role and label, not by test id or class.** A test that queries by
`getByLabelText` fails when the label is removed — which is exactly the regression we
want to catch, since labels are also the accessibility surface (`16` §8).

## 11. Related

- `15-DESIGN-SYSTEM.md` — the components in `components/`
- `16-UI-UX-AND-ACCESSIBILITY.md` — pages, states, interaction
- `11-API-CONTRACT.md` — the contract this client consumes
- `12-VALIDATION-RULES.md` — shared rules
