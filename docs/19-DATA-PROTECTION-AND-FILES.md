# 19 — Data Protection and File Handling

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** DBA · **Approved:** 2026-10-01
**Consolidates:** old 50, 51, 67 (data protection, file upload security, file/media handling)
**Decided by:** **ADR-0004** (D-4 — S3-compatible object storage)

> **Scope:** classification, retention, encryption, and the file pipeline. Access
> rules live in `07`; the schema is `08`; backups are `36`.

---

## 1. Data Classification

Every field is classified. An unclassified field is a defect, because it means nobody
decided who may read it or how long it lives.

| Class | Definition | Controls |
|---|---|---|
| **Restricted** | Compromise causes account takeover or audit loss | Encrypted, never logged, never exported to a client, access audited |
| **Confidential** | Personal or commercially sensitive | Access via authorization only, not in URLs, masked in exports by default |
| **Internal** | Operational data not intended for public release | Available to authenticated users within scope |
| **Public** | Safe to disclose | No restriction |

| Data | Class |
|---|---|
| Password hashes, reset tokens, session ids, API keys | Restricted |
| Audit log contents | Restricted |
| Requester name, email, phone, location | Confidential |
| Work item body, internal notes, attachments | Confidential |
| Approval decisions and comments | Confidential |
| Asset serial numbers, warranty details | Confidential |
| Category names, catalog item names/descriptions | Internal |
| Published KB articles | Internal (may be Public if explicitly marked) |
| Enumeration labels and UI copy | Public |

**Minimisation rule:** do not collect a field because it might be useful. Every
personal field has a stated purpose and a retention period, or it is not stored.

## 2. Encryption

| State | Control |
|---|---|
| In transit | TLS 1.2+ for browser and service traffic; encrypted connections to the database (`17` §3) |
| At rest | Encrypted volumes/managed storage for the database, object storage, and backups |
| Backups | Encrypted with a key distinct from the application's data keys |
| Secrets | Managed in a secret store, never alongside data (`17` §7) |
| Key management | Keys are versioned, rotatable, and never committed; rotation is procedural, not ad hoc |

**Deliberately not implemented in v1:** application-level field encryption. It
complicates querying, indexing and search, and it protects only against a threat
(database-file theft) already covered by volume encryption. This is a recorded decision
(`18` §8), revisited if regulated data is introduced.

## 3. Personal Data Inventory

| Data | Purpose | Lawful basis (indicative) | Retention |
|---|---|---|---|
| Name, email | Identity, notification | Contract / legitimate interest | Account lifetime + 24 months |
| Phone (optional) | SMS notification, contact | Consent | Account lifetime |
| Job title, department | Routing, reporting | Legitimate interest | Account lifetime |
| Request/incident content | Service delivery | Contract | 24 months active, then archive |
| Attachments | Service delivery | Contract | Same as parent record |
| Audit records | Accountability, compliance | Legal obligation | ≥ 24 months, append-only |
| Logs | Security, operations | Legitimate interest | ≥ 90 days |
| Session data | Authentication | Contract | Session lifetime |
| IP/user agent in audit | Security | Legitimate interest | With the audit record |

The table is the basis for the retention enforcement job (§5) and for answering access
requests.

## 4. Subject Rights (Operational Support)

| Right | How ServiceHub supports it |
|---|---|
| Access | An administrator can export all data attached to a user identity |
| Rectification | Profile fields are editable; historical audit records are **not** rewritten |
| Erasure | Deactivation plus anonymisation of personal fields, preserving the audit trail's integrity |
| Restriction | Account deactivation blocks processing without deleting records |
| Portability | Export in a structured format |

**The tension that must be resolved deliberately:** erasure versus audit integrity. The
resolution is **anonymisation, not deletion** — personal fields are replaced with
non-identifying values while the record's structure and timestamps survive, so the
audit trail stays coherent without retaining the personal data.

## 5. Retention and Disposal

| Data | Retention | Mechanism |
|---|---|---|
| Closed work items | 24 months active, then archive partition | Scheduled archival job |
| Audit records | ≥ 24 months; longer if a policy requires | Never pruned below the minimum |
| Logs | ≥ 90 days searchable | Log platform retention policy |
| Notifications (delivered) | 90 days | Prune job |
| Job records (completed) | 30 days | Prune job |
| Expired tokens | Immediately on expiry | Prune job |
| Backups | Daily 35 d, weekly 6 mo, monthly 24 mo | Backup policy (`36`) |
| Deactivated user accounts | 24 months after deactivation | Anonymise, then remove personal fields |

**Disposal must be real.** A "deleted" row that survives in a backup for 24 months is
retained data, and that is stated here rather than pretended otherwise.

## 6. Logging and Disclosure Rules

| Rule | Detail |
|---|---|
| Never log | Passwords, tokens, secrets, reset links, full card-like data, request bodies on auth routes |
| Log with care | Identifiers (not names) by default; IP and user agent only where the security purpose is stated |
| Never return | Other users' data in any response, including error messages and validation detail |
| Export | Confidential fields masked unless the exporter holds an elevated permission, and every export is audited |
| Third parties | Only the minimum necessary is transmitted (e.g. email address to the mail provider); no bulk transfer without review |

## 7. File Handling

### 7.1 Storage Backend (resolved by `ADR-0004`, **D-4**)

**Decision (2026-10-01): S3-compatible object storage** (cloud). Because there are N
backend instances, local disk storage is incorrect — a file uploaded to instance 1 is
not readable from instance 2 — so backends keep **no file bytes** and store metadata
only. Uploads are server-keyed and served via short-lived signed URLs (§7.3).
Self-hosted S3-compatible storage is deferred until an on-premise requirement appears.

### 7.2 Upload Pipeline

```
Client                API                  Scanner            Object storage
  │ POST multipart      │
  ├────────────────────▶│
  │                     │ 1 size check against the request cap
  │                     │ 2 content-type sniff (never trust extension/header)
  │                     │ 3 allow-list check
  │                     │ 4 authorization: may this caller attach to THIS parent?
  │                     │ 5 generate storage key (never the client filename)
  │                     │ 6 persist metadata row: PENDING
  │                     │ 7 ── enqueue scan job ──▶│
  │◀── 201 metadata ────│                        │ scan
  │    status: PENDING  │                        │  ├ clean  → status AVAILABLE
  │                     │                        │  └ infected → status QUARANTINED
  │                     │◀───── status update ───┘
  │                     │ 8 store bytes with server-side encryption
  │                     │ 9 audit: attachment.upload
```

**Rules**

1. Files are **not retrievable until scanned**; a quarantined file is never served.
2. The client filename is metadata only and is sanitized before display.
3. The storage key is server-generated and unguessable.
4. Size is checked before reading the body, and again on the stream, so a lying
   `Content-Length` cannot bypass it.
5. The parent's authorization rule governs the attachment (`07` §4) — attachments are
   never more visible than their parent.
6. An unreferenced file (uploaded, never attached) is pruned by a job.

### 7.3 Serving Files

| Control | Rule |
|---|---|
| Access | Authorization is re-checked on every download, not just at upload |
| URLs | Short-lived signed URLs where the storage backend supports them |
| Content type | Served with a restrictive type; **never** as `text/html` or any executable type |
| Disposition | `Content-Disposition: attachment` for non-image types |
| Origin | Files are **not** served from the application's origin, so a malicious SVG/HTML cannot execute in the app's context |
| Headers | `X-Content-Type-Options: nosniff` |
| Range requests | Bounded; no unbounded streaming of huge files |
| Audit | Downloads of Confidential/Restricted attachments are audited |

### 7.4 Constraints

| Constraint | Value |
|---|---|
| Per-file size | 10 MB default, configurable |
| Per-request total | 25 MB |
| Per-record count | 20 |
| Allowed types | Documents, images, spreadsheets, archives (with care), plain text |
| Always rejected | Executables, scripts, anything sniffed as HTML/JS/SVG-with-script |
| Storage encryption | Server-side encryption at rest |
| Retention | Inherits the parent record's retention; deleted with the parent's lifecycle |

## 8. Verification

| Test | Assertion |
|---|---|
| Unscanned file | Not retrievable before the scan completes |
| Quarantined file | Never served, even with a direct URL |
| Content-type spoof | A `.pdf` containing HTML is rejected by sniffing |
| Cross-parent access | An attachment is not readable by someone without parent access |
| Post-revocation access | A revoked user cannot download a previously accessible file |
| Orphan pruning | Unreferenced files are removed |
| Retention job | Records past retention are archived/anonymised, audit untouched |
| Export masking | Confidential fields are masked without elevated permission |
| Log inspection | No password, token or secret appears in any log line |

## 9. Related

- `08-DATA-MODEL.md` — the `Attachment` entity
- `17-SECURITY-ARCHITECTURE.md` — controls and secure coding
- `18-THREAT-MODEL.md` — file and data threats
- `31-AUDIT-LOGGING.md` · `33-SCALABILITY-AND-DATABASE-PROTECTION.md` · `36-OPERATIONS-AND-RECOVERY.md`
