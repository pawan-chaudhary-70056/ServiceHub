# 16 — UI, UX and Accessibility

**Status:** Approved · **Owner:** Design Lead · **Reviewer:** Frontend Lead · **Approved:** 2026-10-01
**Consolidates:** old 35, 37, 38, 42 and the UX half of old 41 (UI/UX requirements,
UI flow, page structure, responsive/accessibility, form UX)

> **Scope:** pages, states, interaction and accessibility. Components are `15`;
> routing and state are `14`.

---

## 1. UX Principles

1. **The queue is the product.** Most time is spent in lists, not forms. Optimise list
   scanning, filtering and keyboard throughput before beautifying detail pages.
2. **Never show a lie.** An empty table, a stuck spinner, and a silently swallowed
   error are all lies about system state. Every page has distinct loading, empty,
   error, and forbidden states (§4).
3. **Show the clock.** SLA state is visible wherever work is listed or opened. A user
   should never have to open a record to discover it is about to breach.
4. **Confirm the irreversible, not the routine.** Destructive and state-terminal
   actions are confirmed. Routine status moves are not — dialog fatigue makes people
   click through the dangerous one.
5. **Reversible where possible.** Prefer undo over confirmation for low-consequence
   actions.
6. **Respect the keyboard.** Power users live on the keyboard; every action is
   reachable without a mouse.
7. **Fail visibly and informatively.** Errors name what failed and what to do, and
   carry a correlation id for support.

## 2. Page Inventory

| Page | Route | Primary task | Key states |
|---|---|---|---|
| Dashboard | `/dashboard` | Orient: my work, my queue, SLA risk | loading, empty, error, partial |
| Request list | `/requests` | Find and triage | loading, empty, filtered-empty, error |
| Request detail | `/requests/:id` | Work one request | loading, not-found, forbidden, error |
| New request | `/requests/new` | Raise work from catalog | loading catalog, validation, submit, error |
| Incident list/detail | `/incidents`, `/incidents/:id` | Respond to disruption | as above |
| Tasks | `/tasks` | My assigned tasks | loading, empty, error |
| Approvals | `/approvals` | Decide pending approvals | loading, empty, expired, error |
| Catalog admin | `/admin/catalog` | Define services | loading, empty, conflict, error |
| Knowledge list/detail | `/knowledge`, `/knowledge/:slug` | Find or author guidance | loading, empty, draft-hidden, error |
| Assets list/detail | `/assets`, `/assets/:id` | Track assets | loading, empty, error |
| Reports | `/reports` | Measure | loading, computed, job-queued, error |
| Audit | `/audit` | Investigate | loading, empty, forbidden, error |
| Admin | `/admin/*` | Configure | as per sub-page |
| Status pages | `/403`, `/404`, `/500` | Recover | — |

## 3. Page Anatomy

```
┌──────────────────────────────────────────────────────────────┐
│ AppShell: brand · global search · notifications · user menu  │
├───────────┬──────────────────────────────────────────────────┤
│ Side nav  │ PageHeader: title · SLA state · primary action   │
│ (scoped   ├──────────────────────────────────────────────────┤
│  by       │ FilterBar: search · filters · sort · saved views │
│  perms)   ├──────────────────────────────────────────────────┤
│           │ Content: table | detail body | form             │
│           │                                                  │
│           ├──────────────────────────────────────────────────┤
│           │ Pagination / load more                           │
└───────────┴──────────────────────────────────────────────────┘
```

Search, filters, sort and pagination are **URL state** (`14` §3) so a filtered queue is
shareable and survives refresh. Navigation items the user lacks permission for are
hidden; routes are guarded; the server still enforces (`07`).

## 4. Mandatory Page States

Every data page implements all five. This is a definition-of-done item
(`41-DEFINITION-OF-DONE.md`).

| State | Requirement |
|---|---|
| **Loading** | Skeleton preserving layout geometry. No full-page spinner over existing content. No layout shift on load. |
| **Empty (no data yet)** | Explains what the page is for and offers the primary action. "No requests yet — raise one." |
| **Empty (filtered)** | Distinguishes "none exist" from "none match", and offers **Clear filters**. Getting this wrong makes users think data was lost. |
| **Error** | States what failed, offers **Retry**, shows the correlation id. Never an empty list. |
| **Forbidden** | Explains the missing access and who to contact. Not a crash, not a silent blank page. |

Partial failure is a real state: if the page header loads and the activity feed fails,
the page renders header + feedback for the failed region, not a blank screen.

## 5. List and Queue UX

| Concern | Rule |
|---|---|
| Default sort | Most recent first, with a stable tiebreaker |
| Column set | Title, reference, status, priority, SLA, assignee, updated — the scanning set |
| SLA column | Always visible; breached rows visually marked, with a **text** label not only colour |
| Row interaction | Whole row clickable, with the title as a real link for keyboard and new-tab users |
| Inline action | Reassign/status change from the list where the permission allows, to avoid an open-edit-return cycle |
| Bulk action | Available only with selection enabled; results reported per item |
| Saved views | Follow-up feature; the URL state model makes it cheap later |
| Density | Compact default for agents; comfortable available |
| Keyboard | `j`/`k` navigation, `Enter` to open, `/` to focus search, `Esc` to clear |

## 6. Detail Page UX

- Header shows reference, title, status, priority, SLA state, assignee, requester — the
  facts a decision needs, without scrolling.
- SLA state shows **time remaining as well as a state**, because "at risk" without a
  number is not actionable.
- Tabs: Conversation · Details · Tasks · Approvals · Attachments · History.
- Public vs internal notes are visually and structurally distinct; the composer makes
  the audience explicit before sending. A comment accidentally visible to a requester
  is a real harm.
- The activity feed is read-only and derived from the audit record, so it never
  disagrees with it.

## 7. Form UX

| Concern | Rule |
|---|---|
| Validation timing | Validate on blur; re-validate on change once a field is already invalid; validate all on submit |
| Error placement | Inline at the field, plus an error summary at the top when more than three fields fail |
| Error focus | On failed submit, focus moves to the error summary; the summary links to each field |
| Error text | Says what is wrong and how to fix it; never "Invalid input" |
| Submit state | Button shows progress and is disabled while in flight; the action is not double-submittable |
| Unsaved changes | Warn on navigation away when the form is dirty |
| Destructive actions | Confirm with the object named ("Cancel REQ-2026-000123?"), never "Are you sure?" |
| Long forms | Group into sections with a persistent summary; never one 30-field column |
| Server errors | Mapped back onto fields using the error `field` paths (`11` §4) |
| Success | Confirm what happened and where to go next; do not silently redirect |
| Draft preservation | Long-form content is preserved on accidental navigation where feasible |

**Client validation is UX only.** The server re-validates everything (`12`).

## 8. Accessibility — WCAG 2.1 AA

Accessibility is a requirement (`NFR-UX-001`), not a polish pass. Since most of this
product is dense tables and forms, the failures that matter are concrete:

| Area | Requirement |
|---|---|
| Keyboard | Every interactive element reachable and operable by keyboard, in a logical order |
| Focus | Visible focus indicator on every focusable element; never `outline: none` without a replacement |
| Focus management | Modals trap focus and restore it on close; drawers do too; route changes move focus to the heading |
| Landmarks | Header, nav, main, complementary regions labelled |
| Headings | One `h1` per page; heading levels never skipped; headings describe structure, not size |
| Tables | Real `<table>` with `<th scope>`; a div-grid table is not accessible; sortable headers expose `aria-sort` |
| Forms | Label association, `aria-invalid`, described-by errors, required indicated (`15` §5) |
| Contrast | Body text ≥ 4.5:1; large text and UI borders ≥ 3:1 — verified in both themes |
| Colour independence | Status conveyed by text or icon as well as colour |
| Live regions | Toasts and async status changes announced politely; errors announced assertively but without moving focus unexpectedly |
| Skip link | "Skip to main content" as the first focusable element |
| Zoom | Usable at 200 % zoom and at 320 px width without loss of function |
| Motion | `prefers-reduced-motion` respected |
| Time limits | No session timeout without warning; warn before idle logout and allow extension |
| Language | Page `lang` set; abbreviations expanded |

## 9. Responsive Behaviour

| Breakpoint | Behaviour |
|---|---|
| ≥ 1280 | Full shell: side nav, dense tables, multi-column detail |
| 1024–1279 | Collapsible side nav, table density reduced |
| 768–1023 | Tables collapse to card lists; detail becomes single column |
| < 768 | Single column; filters in a drawer; action bar sticky at the bottom |

**Requester flows are mobile-important; agent workflows are desktop-important.** Both
must function at every size, but optimisation effort follows that split. A horizontally
scrolling ticket table is not an acceptable mobile experience.

## 10. Content and Microcopy

| Rule | Example |
|---|---|
| Name the object in confirmations | "Cancel REQ-2026-000123?" not "Are you sure?" |
| Say what happens next | "Request submitted. Priya will be notified." |
| Errors state a cause and a remedy | "Attachment exceeds 10 MB. Choose a smaller file." |
| Never blame the user | "That file type is not supported" not "You uploaded the wrong file" |
| No jargon in requester-facing copy | "Request" not "ticket entity" |
| Dates | Relative for recent ("2 hours ago"), absolute with time zone on hover |
| Empty states give direction | "No approvals waiting. You are clear." |
| Numbers are formatted consistently | One locale formatter, used everywhere |

## 11. Verification

| Check | Mechanism |
|---|---|
| Automated | axe-core on every page in CI; zero critical violations allowed |
| Structure | Heading order and landmark assertions |
| Colour contrast | Token-pair test on both themes |
| Keyboard | Manual pass per primary flow before each phase gate |
| Screen reader | Manual pass with one screen reader per major release |
| State coverage | A test per page asserting all five states from §4 render |
| Zoom/mobile | Manual pass at 320 px and 200 % zoom |

## 12. Related

- `15-DESIGN-SYSTEM.md` — the components used here
- `14-FRONTEND-ARCHITECTURE.md` — routes, state, data fetching
- `12-VALIDATION-RULES.md` — the rules behind the messages
- `37-TESTING.md` — how these guarantees are tested
