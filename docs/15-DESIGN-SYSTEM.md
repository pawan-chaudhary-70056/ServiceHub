# 15 — Design System

**Status:** Approved · **Owner:** Design Lead · **Reviewer:** Frontend Lead · **Approved:** 2026-10-01
**Consolidates:** old 34, 36 (UI design system, UI component architecture)

> **Scope:** tokens and components — the vocabulary of the interface. How they are
> arranged into pages is `16`.

---

## 1. Purpose

A dense, repetitive, data-heavy product like ServiceHub lives or dies on consistency.
Agents work through queues for hours; a table that behaves differently on two pages, or
a status colour that means two things, costs real time and produces real mistakes.

**The rule:** a UI element that appears more than twice is a system component. If a
page needs a variation, it is a new variant on the component — never a bespoke
implementation on the page.

## 2. Design Tokens

Tokens are the only place raw values exist. Components reference tokens; pages
reference components. No hex codes, pixel values, or font stacks in components.

| Category | Tokens |
|---|---|
| Colour | `surface`, `surface-raised`, `border`, `border-strong`, `text`, `text-muted`, `text-inverted`, `primary`, `danger`, `warning`, `success`, `info`, plus hover/active/focus overlays |
| Status | `status-new`, `status-open`, `status-pending`, `status-resolved`, `status-closed`, `sla-ok`, `sla-at-risk`, `sla-breached` |
| Typography | `display`, `heading`, `subheading`, `body`, `label`, `caption`, `mono` |
| Spacing | `1`–`12` on a 4 px scale |
| Radius | `sm`, `md`, `lg`, `full` |
| Elevation | `flat`, `raised`, `overlay` |
| Motion | `fast` (100 ms), `normal` (200 ms), `slow` (300 ms), easing curves |
| Z-index | `base`, `dropdown`, `sticky`, `overlay`, `modal`, `toast` — a named scale prevents the z-index arms race |

Tokens map to `tailwind.config.ts` so they are available as utility classes and are
themeable without touching a component.

### Status colour semantics

Status colour is **not decoration** — it is information. Each semantic has exactly one
colour across the whole product:

| Meaning | Colour family | Never used for |
|---|---|---|
| New / unassigned | Neutral blue | Errors |
| Open / in progress | Amber | Success |
| Awaiting approval | Violet | Breach |
| Resolved / fulfilled | Green | Anything unresolved |
| Closed / cancelled | Grey | Active work |
| SLA at risk | Amber outline | SLAs on track |
| SLA breached | Red, high contrast | Anything non-breach |

Colour is **never the sole carrier of meaning** — status always pairs colour with text
or an icon, for colour-blind users and for print (`16` §8).

## 3. Component Tiers

```
Tier 3  Patterns      DataTable · PageHeader · FormLayout · EmptyState · FilterBar
                      StatusBadge · ActivityFeed · ApprovalPanel
Tier 2  Composites    Select · DatePicker · Modal · Drawer · Toast · Tabs ·
                      Pagination · Combobox · FileUpload · Breadcrumbs
Tier 1  Primitives    Button · Input · Textarea · Checkbox · Radio · Switch ·
                      Badge · Avatar · Tooltip · Card · Spinner · Skeleton
Tier 0  Tokens        Colours · type · spacing · radius · elevation · motion
```

Rules:

- A Tier 2 component composes Tier 1 components; it does not restyle them.
- A page composes Tiers 2–3; it never introduces a new primitive.
- A new pattern used on exactly one page stays in `pages/` until it is reused; then it
  is promoted to `components/` in the same change that creates the second use.

## 4. Component API Conventions

| Convention | Rule |
|---|---|
| Variants | Explicit `variant` prop backed by a variant map — never a `type`/`kind`/`style` alias |
| Sizes | `size="sm" | "md" | "lg"` only |
| Composition | Children and named slots over boolean prop proliferation |
| Spread | Native attributes pass through to the underlying element |
| Ref | Forwarded |
| Controlled | Form controls are controlled by React Hook Form (`14` §3) |
| Accessibility | Required (`16` §8) — a component that cannot be used by keyboard is not done |
| Docs | Each Tier 2+ component has an example in the styleguide covering default, variants, disabled, loading, and error |
| No styling escape hatches | No `className` overrides that break tokens; no inline styles except for computed values (e.g. progress width) |

## 5. Form Components

Form controls carry the accessibility and validation contract so pages cannot get it
wrong:

| Requirement | Implementation |
|---|---|
| Label association | `Label` is linked by `htmlFor`/`id`; every control requires a label or `aria-label` |
| Error display | `aria-invalid` plus `aria-describedby` pointing at the message element |
| Required | Visible indicator **and** `aria-required` |
| Help text | Rendered in the described-by chain, not as a placeholder |
| Placeholder | Never used as a label |
| Disabled vs read-only | Distinct states with distinct semantics |
| Field groups | `fieldset`/`legend` for related controls (radio groups, address blocks) |

## 6. Data Display Components

`DataTable` is the highest-leverage component in the product — it renders most of the
application.

| Feature | Requirement |
|---|---|
| Columns | Declared per page with typed accessors |
| Sorting | Server-side (`11` §6); the component emits a sort key and does not sort locally |
| Pagination | Cursor-based; the component renders "load more"/next, never page numbers, matching the API contract |
| Empty state | Renders the empty-state component with page-supplied copy — **never a blank table** |
| Loading state | Skeleton rows preserving column geometry (no layout shift) |
| Error state | Explicit error state with retry — never an empty table |
| Selection | Optional; bulk actions shown only when selection is enabled |
| Row actions | Keyboard reachable; never hover-only |
| Density | A compact and a comfortable mode; agents default to compact |
| Responsive | Below the breakpoint, rows collapse to a card list — a horizontally scrolling table is not acceptable on a work queue |

## 7. Feedback Components

| Component | Use |
|---|---|
| `Toast` | Transient confirmation of an action; never for errors requiring a decision |
| `InlineAlert` | Persistent, page-level; used for SLA breach banners and degraded modes |
| `Modal` | Blocking decision only — confirmation, approval, destructive action |
| `Drawer` | Side-panel detail without losing list context |
| `Skeleton` | Loading in place of content |
| `Spinner` | Loading inside a control |
| `Progress` | Determinate operations (uploads, long jobs) |

**Rule:** a fatal error is not a toast. Toasts disappear; an error the user must act on
stays visible until resolved.

## 8. Theming

- A light and a dark theme from day one; both are token sets, not separate stylesheets.
- Theme is a user preference, persisted, defaulting to system.
- Every token pair is verified for contrast in both themes (`16` §8).
- Component code never branches on theme; it references tokens.

## 9. Motion

Motion communicates state change, never decorates. Every animation has a
`prefers-reduced-motion` fallback that removes it. Durations come from tokens. No
animation longer than 300 ms in a workflow UI, because agents perform thousands of
actions a day and perceive every unnecessary 400 ms.

## 10. What This Document Forbids

1. Page-level custom CSS that restates a token.
2. A one-off button that is "almost" the system button.
3. Colour as the only status signal.
4. A table that sorts locally while the API sorts by cursor.
5. Placeholders used as labels.
6. Modal used for non-blocking content.
7. Components without a keyboard path.
8. A new library introduced for a widget the system already provides.

## 11. Related

- `16-UI-UX-AND-ACCESSIBILITY.md` — usage, pages, states
- `14-FRONTEND-ARCHITECTURE.md` — where components live
- `03-ARCHITECTURE.md` — the SPA's place in the system
