# 31 — Audit Logging

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 65, 66

> **Scope:** the append-only record of who did what, when, and under what authority.
> **Operational logs** (debug, request traces) are `34` and are a different artifact
> with a different lifecycle. **Data classification and retention** are `19`.

---

## 1. Purpose and the line it must not cross

An audit log exists to answer, after the fact and without trusting the application:
*who changed this, when, from where, and what did it look like before.* Its value comes
entirely from two properties — **completeness** and **immutability** — and both are
easy to lose by accident:

- If any mutation path can skip writing an audit row, completeness is gone and no one
  notices until the log is needed.
- If any code path can update or delete an audit row, immutability is gone and the log
  becomes a liability rather than evidence.

Every rule below defends one of those two properties.

## 2. Scope: What Is Audited

| Class | Examples | Always audited |
|---|---|---|
| Authentication | Login success/failure, logout, password change, MFA enrol/disable | Yes |
| Authorization | Role change, permission grant/revoke, access denial, authorization override | Yes |
| Record mutation | Create, status change, reassignment, priority change, delete/retire | Yes |
| Sensitive data access | Export, bulk view, report generation, viewing a restricted record | Yes |
| Approvals | Every decision, step advance, reassignment, expiry | Yes |
| SLA overrides | Target change, manual pause, breach clearing | Yes |
| Configuration | SLA policy, calendar, catalog item, template, integration config changes | Yes |
| Integrations | Credential change, webhook config, inbound sync outcomes | Yes |

Every entry records `actorId`/`actorType`, `action`, target `(entityType, entityId)`,
`before`/`after`, `reason` where required, `correlationId`, `sourceIp`, `userAgent`,
and `occurredAt` (`08` §4.7).

## 3. The Three Mechanisms That Keep It Complete

### 3.1 Transactional write

Audit rows are written **in the same database transaction as the mutation** (`03` §5
step 8). If the mutation commits, the audit committed; if the mutation rolls back, the
audit rolls back. This is what closes the "changed but not audited" gap — a
post-commit fire-and-forget audit write is exactly the gap.

### 3.2 Central write path

There is **one** audit writer (`03` §3). Modules call it; they do not insert into the
audit table. A single path means a code review of one file, not a hunt across the
codebase, and an integration test can assert that every mutating service call produces
a record.

### 3.3 Immutability at the database, not the application

| Control | Mechanism |
|---|---|
| No update path | The application grants `UPDATE` to none; there is no service method that updates |
| No delete path | Same for `DELETE` |
| Append-only at the database | A trigger rejects `UPDATE`/`DELETE` on the audit table, so even a future careless migration cannot rewrite it |
| No `updatedAt` column | Its absence is the design (`08` §4.7) |
| Separate credentials | The audit sink writes with a role that has `INSERT` only |

**The trigger is the control.** Application-layer-only immutability is defeated by the
next developer who writes a "quick fix" query. The database refuses.

## 4. Record Shape and Redaction

| Concern | Rule |
|---|---|
| `before` / `after` | JSON snapshots, **redacted per classification** before storage (`19`) |
| Secrets | Never stored: password hashes, tokens, MFA secrets, full card-like data are excluded by the audit writer, not by each module |
| PII | Stored where the field is the subject of the change, otherwise summarised; retention per class |
| Large values | Truncated with a marker and a reference to the object, not stored whole |
| Field-level diff | Stored as the changed fields plus context, not the entire record on every micro-change |
| Free text | `reason` and comments included verbatim — they are usually the most valuable part |

**Redaction must happen before the row is written.** A redaction applied on read means
the sensitive value is already at rest and in every backup.

## 5. Reading the Audit Log

| Viewer | Sees |
|---|---|
| Administrator | All entries in scope |
| Team lead | Entries for their team's records and members |
| Record participant | The history of a record they can read, without security-class entries |
| Security role | All authentication, authorization and access entries |
| Support | Read-only, scoped, **every access to the log itself is audited** |

Reading the audit log is itself a sensitive action: viewing who changed what is a
capability that leaks information about records the viewer may not read. Access to the
log is therefore audited and scoped.

## 6. Integrity and Tamper Evidence

| Concern | Approach |
|---|---|
| Tamper detection | Daily job computes a rolling hash (chain) over the previous day's entries and stores the digest in a separate control record and an immutable backup |
| Retention | **Never pruned before 24 months** (`08` §6); security-class entries governed by `19` |
| Archival | Older entries move to archive storage (`33`) but remain queryable by restore |
| Backups | Audit is included in backups (`36`) and excluded from "clean up space" routines |
| Export | Exports are themselves audited with filters and requester |

A chained digest is not full tamper-proofing, but it **detects** after-the-fact edits
by an actor with database access, which is the realistic threat (`18`). Perfect
immutability against the DBA is not claimed.

## 7. Naming and Correlation

- Actions use a stable dotted namespace: `request.status.change`, `authz.override`,
  `approval.decide`, `sla.breach.clear`.
- `correlationId` ties an audit entry to the operational logs of the same request
  (`34`), so a sequence of actions can be reconstructed end to end.
- Actor types are explicit: `USER`, `SERVICE`, `SYSTEM` (scheduler). A change with no
  human actor still records which system component made it.

## 8. Retention and Privacy

| Class | Retention | Notes |
|---|---|---|
| Authentication / authorization | Longest (per policy) | Security investigations |
| Record mutations | 24 months minimum | Business history |
| Sensitive access | Longest | Disclosure investigations |
| Configuration | 24 months minimum | "When did this change" |
| Low-risk reads | Not audited (only writes and sensitive reads) | Auditing every read would swamp the log |

**The log must not become the privacy problem it is meant to help investigate:**
redaction (§4), retention by class, and storing identifiers rather than whole payloads
limit what a breach of the audit store exposes.

## 9. Permissions

| Action | Permission |
|---|---|
| Read audit (scoped) | `audit:read.team` / `audit:read.all` |
| Read security class | `audit:read.security` |
| Export audit | `audit:export` (audited) |
| Manage retention policy | `admin:config` (audited) |

No permission exists to **modify** audit entries. That is intentional.

## 10. API

| Method | Path | Notes |
|---|---|---|
| GET | `/audit` | Scoped; filters: actor, action, entity, date; cursor-paginated |
| GET | `/audit/records/{entityType}/{entityId}` | Record history, without security class |
| GET | `/audit/security` | Security class only |
| POST | `/audit/export` | Async export (audited) |

## 11. UI Surfaces

| Surface | Contents |
|---|---|
| Record history tab | Human-readable timeline on requests, incidents, tasks, assets, articles |
| Audit explorer | Filterable table for leads/admins with diff viewer |
| Security activity view | Auth events, denials, overrides |
| Diff viewer | Field-level before/after with redaction markers |

## 12. Edge Cases

| Case | Behaviour |
|---|---|
| Bulk import changes many records | One entry per record plus a summary entry referencing the batch |
| A mutation with no changed fields | No audit entry (nothing changed); the attempt may be logged operationally, not in audit |
| Scheduler-driven change (SLA breach) | Actor type `SYSTEM`, with the job id in the correlation id |
| Audit write fails in the transaction | The whole transaction fails — no unaudited change is committed |
| Auditor views a restricted record's history | Security-class fields are redacted for them; the view itself is audited |
| Time correction on the database host | Entries store database-set `occurredAt`; host clock drift is a monitoring concern (`34`), not a per-record fix |
| Restore from backup | Restored audit rows keep original ids and timestamps; the restore is itself recorded |

## 13. Acceptance Criteria

1. Every mutating service path produces exactly one audit entry per changed record —
   verified by an integration test that enumerates mutating endpoints.
2. No API or service path can update or delete an audit row; the database trigger
   rejects direct `UPDATE`/`DELETE`.
3. An audit write failure rolls back its mutation.
4. Secrets never appear in `before`/`after` — verified by scanning recorded snapshots
   for known secret fields.
5. Access to the audit log is itself audited.
6. Entries contain a `correlationId` resolvable to the operational logs of the same
   request.
7. Retention never prunes audit before 24 months; the job is prevented by policy and
   test.
8. The tamper-evidence digest verifies for a period with no changes.

## 14. Related

- `17-SECURITY-ARCHITECTURE.md` — the control this log evidences
- `34-OBSERVABILITY.md` — operational logs and correlation ids
- `19-DATA-PROTECTION-AND-FILES.md` — classification, redaction, retention
- `36-OPERATIONS-AND-RECOVERY.md` — backup and archival of the log
