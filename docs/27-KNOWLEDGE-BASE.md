# 27 — Knowledge Base

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-07
**Consolidates:** old 60

> **Scope:** authoring, publishing and consuming knowledge content. **Search ranking
> across all entities** is `30`. **How articles are linked from records** is owned here,
> referenced by `22`/`23`.

---

## 1. Purpose

The knowledge base is the deflection mechanism. Its value is not the number of
articles but the number of **contact minutes avoided** — an article that resolves the
reader's problem before they raise a request. A KB that is never linked from the
request flow, never surfaced during search, and never measured for deflection is
documentation, not a service capability.

## 2. Concepts

| Concept | Definition |
|---|---|
| Article | A knowledge document with a stable identity and versioned content |
| Article category | Hierarchical grouping for browsing |
| Status | `DRAFT → IN_REVIEW → PUBLISHED → ARCHIVED` |
| Visibility | `PUBLIC` (all authenticated), `INTERNAL` (agents/leads), `RESTRICTED` (named roles/teams) |
| Version | An immutable snapshot of published content |
| Link | An association between an article and a request/incident (a resolution aid) |

## 3. Data

Per `08` §2: `ArticleCategory` (hierarchy, mirroring catalog category rules) and
`Article`.

| Field | Notes |
|---|---|
| `title` | Required |
| `slug` | Unique, stable; changes require a redirect record |
| `summary` | Short, shown in search results |
| `body` | Markdown; sanitized on render (`17` §XSS) |
| `status` | Lifecycle state |
| `visibility` | Access class (`07`) |
| `authorId`, `reviewerId` | Accountability |
| `publishedAt`, `reviewedAt` | Freshness tracking |
| `version` | Increments on each publish |

## 4. Lifecycle

```
DRAFT ──▶ IN_REVIEW ──▶ PUBLISHED ──▶ ARCHIVED
  ▲            │             │
  └────reject──┘             └── unarchive → PUBLISHED
```

| State | Visible to readers | Editable | Indexed |
|---|---|---|---|
| `DRAFT` | No | Yes | No |
| `IN_REVIEW` | No (reviewer only) | Yes | No |
| `PUBLISHED` | Per visibility | Yes (creates a new version on publish) | Yes |
| `ARCHIVED` | No (existing links remain resolvable with an archived banner) | No | No (excluded from search) |

**Publishing creates an immutable version.** Editing a published article produces a
new draft; the previously published version stays addressable until republished, so a
link from a resolved incident always resolves to what the resolver actually read.

## 5. Business Rules

| # | Rule | Rationale |
|---|---|---|
| K1 | Publishing requires a reviewer distinct from the author | Prevent unreviewed content reaching requesters |
| K2 | Article body is sanitized; raw HTML is rejected | Stored XSS prevention (`17`) |
| K3 | `RESTRICTED` visibility is enforced server-side on **read**, including search | A hidden article leaking through search is the classic KB defect |
| K4 | Archived articles are excluded from search but direct links resolve with a banner | History integrity |
| K5 | Freshness review is scheduled (default 12 months); overdue articles are flagged, not auto-archived | Prevents silent rot without deleting useful content |
| K6 | Links to requests/incidents store the article **version** at link time | The record shows what was actually applied |
| K7 | Deletion is prohibited; articles are archived | History and inbound-link integrity |
| K8 | Snippets in search results respect visibility filter before ranking | Never rank, then filter |

## 6. Deflection Measurement

| Metric | Definition |
|---|---|
| Article views | Views per article, unique readers |
| Definitive resolution | A reader marked the article helpful **and** raised no request within the session window |
| Link rate | Records resolved with a linked article ÷ records resolved |
| Reopen after KB resolution | Records reopened after being resolved with a KB link — the honesty metric |
| Stale article ratio | Published articles past their review date ÷ published |

**Deflection is only credible when paired with the reopen rate.** Counting "views" as
savings inflates the figure; a KB-linked resolution that reopens was not a resolution.

## 7. Permissions

Permission keys are the canonical ones from `07` §3 (the permission catalogue is owned
by `07`; this document does not mint new keys).

| Action | Permission |
|---|---|
| Read `PUBLIC` | `kb:article:read` (all authenticated roles hold it) |
| Read `INTERNAL` / `RESTRICTED` | `kb:article:author` / `kb:article:publish`, or the article's explicit visibility grant — enforced server-side on read **and** in search (`K3`) |
| Author / edit | `kb:article:author` |
| Publish | `kb:article:publish` (lead/admin); the reviewer must differ from the author (`K1`) |
| Archive | `kb:article:publish`; deletion is prohibited, archiving is the end state (`K7`) |
| Manage categories | `admin:config` |

## 8. API

| Method | Path | Notes |
|---|---|---|
| GET | `/kb/articles` | Visibility-filtered; supports category and text filters |
| GET | `/kb/articles/{id}` | Version-aware; archived returns banner flag |
| POST/PATCH | `/kb/articles/{id}` | Author; body sanitized |
| POST | `/kb/articles/{id}/publish` | Reviewer; creates a version |
| POST | `/kb/articles/{id}/archive` | Manage |
| GET/POST | `/kb/categories` | Read / manage |
| POST | `/requests/{id}/knowledge-links`, `/incidents/{id}/knowledge-links` | Link with version |

## 9. UI Surfaces

| Surface | Contents |
|---|---|
| KB browse | Category tree, search, recently-updated |
| Article view | Rendered body, helpful/not-helpful, related articles |
| Editor | Markdown editor with preview, visibility selector, review scheduling |
| Request/incident side panel | Suggested articles (from `30` search) and linked articles |
| KB admin | Status board, stale-review queue, category management |

## 10. Search and Indexing

Ranking, tokenization and fallback behaviour are owned by `30`. This document owns
only **what is indexable**:

- `PUBLISHED` articles only; `DRAFT`, `IN_REVIEW` and `ARCHIVED` are excluded.
- Visibility is a **pre-filter**, applied before ranking, never a post-filter.
- `title` and `summary` are weighted above `body` (weights set in `30`).

## 11. Edge Cases

| Case | Behaviour |
|---|---|
| Article archived while linked from an incident | Link still resolves, shows an archived banner, incident history unchanged |
| Two authors edit simultaneously | Optimistic concurrency on `version`; the second save is rejected with `409` |
| Article visibility narrowed after publication | New reads are re-evaluated immediately; cached search results are invalidated |
| Unpublished version exists behind a published one | Readers see the published version; authors see their draft with a "unpublished changes" marker |
| Slug collision on import | Rejected; imports never overwrite an existing slug |

## 12. Acceptance Criteria

1. A `RESTRICTED` article does not appear in search results or suggestions for an
   unauthorised reader — verified by test at the search layer, not only the read layer.
2. Publishing creates a version; editing a published article does not alter the
   currently published content until republish.
3. A link created from an incident resolves to the version linked at the time.
4. Archiving removes the article from search and preserves direct-link resolution.
5. A slug change with existing inbound links records a redirect; links do not 404.
6. Every publish, archive and visibility change is audited (`31`).

## 13. Related

- `30-SEARCH-AND-REPORTING.md` — ranking and the suggestion feed
- `17-SECURITY-ARCHITECTURE.md` — sanitization and read enforcement
- `08-DATA-MODEL.md` · `07-ROLES-AND-AUTHORIZATION.md` · `31-AUDIT-LOGGING.md`
