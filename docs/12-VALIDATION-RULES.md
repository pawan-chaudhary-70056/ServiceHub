# 12 — Validation Rules

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** Frontend Lead · **Approved:** 2026-10-01
**Consolidates:** old 25 (validation rules) and the server-side half of old 41 (form validation)

> **Scope:** what makes input acceptable, and where that is enforced. Form *UX*
> behaviour (when errors appear, focus handling) is `16`. The error *envelope* is
> `11` §4.

---

## 1. Principle

**The client validates for the user's benefit. The server validates for the system's
integrity. They are not the same check and the client's copy is never trusted.**

Every input crossing the trust boundary is validated: body, query, path parameters,
headers, uploaded files, and webhook payloads. There is no "internal" endpoint that
skips validation.

**Layer responsibilities**

| Layer | Validates | Does not validate |
|---|---|---|
| Zod schema (boundary) | Shape, type, format, range, required, enum membership | Business rules, state transitions, authorization |
| Service (domain) | State machine legality, referential rules, cross-entity invariants, authorization | Field formats |
| Database (constraint) | Uniqueness, foreign keys, nullability, check constraints | Anything else |

A schema that encodes business rules becomes unmaintainable and produces wrong error
codes. A service that re-implements format validation duplicates work and drifts.

## 2. Mechanism

- **Zod** is the only validation library (NFR-CONST-005).
- One schema per request shape, colocated with the route, imported by the controller.
- Schemas are **composed** (`.extend`, `.pick`, `.omit`) rather than copy-pasted;
  `CreateX` and `UpdateX` share a base, so a field added to one is not silently absent
  from the other.
- **Strict by default:** unknown keys are rejected. Silently dropping an unknown field
  hides client bugs and has historically been a mass-assignment vector.
- Parsing produces a **typed** value; services receive parsed types, never raw input.
  No service method accepts `any` or an un-narrowed `Record<string, unknown>`.

```ts
const BaseRequest = z.object({
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().max(10_000).optional(),
  catalogItemId: z.string().id(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  fields: z.record(z.string(), FieldValue).default({}),
});

export const CreateRequest = BaseRequest.strict();
export const UpdateRequest = BaseRequest.partial().strict();
```

## 3. Normalization Rules

Normalize **before** validating, so that semantically equal inputs are equal:

| Input | Normalization |
|---|---|
| Email | Trim, lowercase |
| Names/titles | Trim; collapse internal whitespace; preserve case |
| Free text | Trim trailing whitespace; do not strip internal newlines |
| Enums | Uppercase before membership check |
| IDs | Trim; reject anything not matching the id format |
| Dates | Parse to UTC; reject ambiguous formats rather than guessing |
| Numbers as strings | **Not coerced silently** — reject, except where a query parameter is declared numeric |

Silent coercion is how `"5"` becomes `5` in one place and `NaN` in another. Coerce
only at declared boundaries, and never in a way that changes meaning.

## 4. Field Rules by Type

| Type | Rules |
|---|---|
| Short text | Length bounds; no control characters; no leading/trailing whitespace after normalization |
| Long text | Length bound (explicit maximum — never unbounded); control characters stripped |
| Email | Format check plus length bound; uniqueness is a **database** concern |
| Password | Minimum 12; maximum 128 (bound the work); breached-password check if available (`06`) |
| ID reference | Format check plus existence check in the service (existence is not a schema concern) |
| Enum | Membership in the declared set; unknown → `422 INVALID_ENUM` |
| Integer | Bounds; reject floats for integer fields |
| Money | Integer minor units + ISO currency; reject negative where meaningless |
| Date | Valid calendar date; reject `2026-02-30` |
| Timestamp | ISO 8601 with offset; range-bounded (no year 9999) |
| Boolean | Strict; `"true"`/`"false"` accepted only in query parameters |
| Array | Explicit max length; per-item validation; reject duplicates where they are meaningless |
| Free-form JSON | Explicit schema per use; never `z.any()` |
| URL | Scheme allow-list (`https` only for webhooks); length bound |
| File | See §8 |
| Rich text / markdown | Length bound; sanitized on **output** as well as input |

**No field is unbounded.** An unbounded string field is a denial-of-service path and a
guarantee of a later migration.

## 5. Cross-Field and Business Rules

Live in the service, because they need context the schema does not have:

| Rule | Enforced where | Error |
|---|---|---|
| `resolve` requires `resolutionSummary` | Service | `422` field error |
| Parent cannot close with open children | Service | `409 ILLEGAL_TRANSITION` |
| Transition must be legal for the current state | Service | `409 ILLEGAL_TRANSITION` |
| Approver must be designated for the active step | Service | `403` |
| SLA policy must belong to the caller's organisation | Service | `403`/`404` |
| Start date must precede end date | Schema (`.refine`) | `422` |
| At least one approver per step | Schema | `422` |
| Bulk selection cannot exceed N items | Schema | `422` |

Rule of thumb: if the rule needs the database or the caller, it is a service rule. If
it needs only the payload, it is a schema rule — put it in the schema so it fails
earliest and produces the best error.

## 6. Query and Path Parameter Validation

| Concern | Rule |
|---|---|
| `limit` | Integer, 1–100; out of range → `422` (not silent clamping) |
| `cursor` | Opaque format; malformed → `422` |
| `sort` | Allow-list of sortable fields; unknown → `422` |
| Filters | Typed per endpoint; unknown filter → `422` |
| Date ranges | Parseable, and range bounded (maximum span enforced to protect the database) |
| Path `id` | Format validated before any service call, so a malformed id never reaches a query |

## 7. Authorization Is Not Validation

A `403`/`404` decision is never produced by a schema. Schemas do not know who is
calling, so a payload that is valid for one caller may be refused for another
(`07` §6). Keeping these separate is what makes the IDOR test suite meaningful.

## 8. File Validation

| Check | Rule |
|---|---|
| Size | Per-file and per-request maximums; reject with `413` |
| Type | Allow-list, determined by **content sniffing**, not by extension or client header |
| Name | Sanitized; path separators and control characters stripped; never used as a storage path |
| Storage key | Server-generated; the client name is metadata only |
| Malware | Scanned before the file is made retrievable |
| Serving | Never served from the app's origin as executable content; restrictive `Content-Type` and `Content-Disposition` (`19`) |

## 9. Error Mapping

| Failure | Response |
|---|---|
| Schema validation | `422 VALIDATION_FAILED` with `errors[]` per field |
| Malformed JSON | `400` |
| Business rule violated | `409` with a specific code |
| Not entitled | `403` / `404` per `07` |
| Unknown field | `422` with the offending field named |

Field paths are dot/bracket notation matching the request shape (`approvers[0].id`) so
the client can map an error directly onto a form control.

## 10. Frontend Relationship

The frontend validates with the same **rules**, expressed for UX: inline errors, focus
management, disabled submit while invalid. It is explicitly not a security boundary.

**Gap (`A-12`):** with no shared workspace between the frontend and backend packages,
these rules are currently duplicated. Two mitigations, to be decided by ADR:

1. Generate TS types and validators from the OpenAPI document (`11` §10) — recommended,
   because the spec is already generated and CI-checked.
2. Introduce a shared workspace package for schemas — more direct, but changes the
   fixed repository structure (charter §3) and therefore needs an explicit exception.

Until one is chosen, any change to a validation rule must be made in both places in the
same change, and the CI duplication check (§11) guards against silent divergence.

## 11. Test Obligations

| Test | Assertion |
|---|---|
| Schema unit tests | Every schema accepts the valid fixture and rejects each invalid variant |
| Boundary tests | Empty, whitespace-only, maximum-length, over-maximum, wrong type, unknown field |
| Query validation | Malformed `limit`, `cursor`, `sort`, unknown filter all rejected with `422` |
| Business rules | Illegal transitions rejected with `409` and no state change |
| Error shape | Every failure conforms to the envelope in `11` §4 |
| Duplication check | CI compares frontend and backend rule definitions and fails on divergence |
| Mass assignment | Undeclared fields never reach a repository |

## 12. Related

- `11-API-CONTRACT.md` — the error envelope and status codes
- `16-UI-UX-AND-ACCESSIBILITY.md` — how errors are presented
- `19-DATA-PROTECTION-AND-FILES.md` — file handling specifics
- `13-BACKEND-ARCHITECTURE.md` — where validation sits in the request path
