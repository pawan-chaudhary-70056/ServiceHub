# 18 — Threat Model

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 47 (threat model)

> **Scope:** what can go wrong, how it is mitigated, and what risk remains. Controls
> are described in `17`; this document is the reasoning behind them, not a second copy.

---

## 1. Method

STRIDE, applied per trust boundary rather than per component, because ServiceHub's
risk concentrates at boundaries: browser↔API, API↔database, API↔external services, and
user↔user (the last being the one most often forgotten and most often exploited in
this product class).

**Review triggers:** a new trust boundary, a new data class, a new external
integration, a change to authentication or authorization, or a security incident.

## 2. Assets

| Asset | Classification | Why it matters |
|---|---|---|
| Credentials (password hashes, reset tokens) | Restricted | Account takeover |
| Session/token material | Restricted | Impersonation |
| Personal data (requester identity, contact details) | Confidential | Privacy obligation |
| Access control data (roles, permissions, delegations) | Confidential | Privilege escalation |
| Work item content (requests, incidents, internal notes) | Confidential | Business exposure; internal notes may contain sensitive commentary |
| Approval records | Confidential, integrity-critical | Fraud and governance |
| Knowledge articles | Internal | May embed operational detail |
| Asset register | Confidential | Physical security signal |
| Audit log | Restricted, integrity-critical | Tamper evidence |
| Attachments | Varies | May contain contracts, screenshots, credentials |
| Availability of the platform | — | Business operations stop |

## 3. Threat Agents

| Agent | Capability | Motivation |
|---|---|---|
| External unauthenticated attacker | Network access, public endpoints | Data theft, disruption |
| Malicious authenticated user | Valid credentials, normal API access | Escalation, snooping on colleagues' tickets |
| Careless insider | Valid credentials, no intent | Accidental disclosure, misconfiguration |
| Compromised account | Valid credentials | Lateral movement, exfiltration |
| Malicious integrator | API access as a service account | Over-reach beyond declared scope |
| Rogue administrator | Highest privileges | Fraud: configure-and-approve |
| Automated scraper | High request volume | Enumeration, load |
| Supply-chain attacker | Package or image compromise | Arbitrary code in the product |

## 4. Trust Boundaries

```
┌─ Browser (untrusted) ─────────────────────────────────────┐
│                                                           │
└────────────────────────┬──────────────────────────────────┘
                         │  B1: network boundary — TLS, authn, validation
┌────────────────────────▼──────────────────────────────────┐
│ Edge: LB, TLS, rate limiting                              │
└────────────────────────┬──────────────────────────────────┘
                         │  B2: application boundary — authorization, object rules
┌────────────────────────▼──────────────────────────────────┐
│ Application (trusted code, untrusted input)               │
├──────────────┬──────────────┬─────────────────────────────┤
│              │              │  B3: data boundary          │
│              │              ▼                             │
│              │      PostgreSQL (least privilege)          │
│              │                                            │
│              │  B4: external boundary — allow-list, timeout│
│              ▼                                            │
│      Email / SMS / Webhook / Storage providers             │
└───────────────────────────────────────────────────────────┘
         B5: user-to-user boundary — object-level authorization
```

**B5 is where this product is most often broken.** Every authenticated user has a
legitimate session; the only thing standing between an agent and another team's
incident is an object-level check on the resolved record.

## 5. Threats and Mitigations

### 5.1 Authentication (B1)

| Threat | STRIDE | Mitigation | Residual risk |
|---|---|---|---|
| Credential stuffing | S | Rate limits, lockout, breached-password rejection | Shared passwords elsewhere |
| Brute force | S | Lockout + per-IP limits | Distributed slow attack |
| User enumeration | I | Uniform responses and timing | Timing side-channels in proxies |
| Session fixation | S | Identifier regenerated on login | — |
| Session hijack | S | `httpOnly`, `Secure`, `SameSite`, short idle timeout | Endpoint malware |
| Reset token theft | S | Hashed at rest, single use, short expiry, session revocation | Email account compromise |
| CSRF | T | `SameSite` + CSRF token (cookie sessions, `ADR-0001`) | — |
| Credential replay from logs | I | Log redaction filters | Misconfigured log sink |

### 5.2 Authorization (B2/B5)

| Threat | STRIDE | Mitigation | Residual risk |
|---|---|---|---|
| IDOR — read another user's record by changing an id | I | Object-level checks in services; repository-level scoping; automated sweep test | A single endpoint that forgets the check |
| Scope leak in a list endpoint | I | Scope filter inside the query, not post-filter | Developer adds a new list without scope |
| Privilege escalation via role assignment | E | Role management requires admin; audited; separation of duties | Compromised admin account |
| Self-approval to bypass governance | T | Requester cannot approve own record; approver holds no fulfilment rights | Collusion between two users |
| Hidden-endpoint access | E | Routes annotated with permissions; no client-only guards | New route without annotation |
| Enumerable identifiers | I | Opaque ids; `404` for unauthorized existence | Timing differences |
| Over-broad service account | E | Least privilege, declared scopes, rotation | Scope creep over time |

### 5.3 Data (B3)

| Threat | STRIDE | Mitigation | Residual risk |
|---|---|---|---|
| SQL injection | T/I | Prisma parameterisation; raw SQL reviewed | A justified raw query |
| Mass assignment | T | Strict schemas, explicit field allow-lists | — |
| Sensitive data in logs | I | Redaction; no body logging on auth routes | Third-party log tooling |
| Unencrypted data at rest | I | Volume/disk encryption; encrypted backups | Key management |
| Audit tampering | R | Append-only grants; no update/delete path; separate retention | DBA with superuser access |
| Illegal mass export | I | Rate limits, export auditing, alerting on volume | Legitimate bulk use |
| Replica leaking stale/unauthorized data | I | Same authorization on replica reads | Replication lag affecting freshness |
| Backup exposure | I | Encrypted backups; access-controlled; restore tested | Offline media handling |

### 5.4 Input and Output (B1)

| Threat | STRIDE | Mitigation | Residual risk |
|---|---|---|---|
| Stored XSS via comment/article | T/E | Sanitised allow-list, output encoding, CSP without `unsafe-inline` | Sanitiser bypass |
| Reflected XSS | T/E | Encoding; CSP | — |
| Open redirect | T | Same-origin/allow-list targets | — |
| SSRF via webhook config | I | Allow-list, block private ranges, no redirects | DNS rebinding |
| Malicious upload | T/E | Content-sniffed type, scanning, server-generated keys, non-executable serving | Zero-day payload |
| Path traversal | I | Server-generated storage keys | — |
| DoS via unbounded input | D | Field length bounds, body size limits, rate limits | Distributed flood |
| Expensive query via crafted filters | D | Bounded ranges, statement timeouts, pagination caps | — |

### 5.5 Async and Integration (B4)

| Threat | STRIDE | Mitigation | Residual risk |
|---|---|---|---|
| Forged webhook to a subscriber | S | HMAC signature + timestamp | Subscriber misconfiguration |
| Replay of a webhook | S | Timestamp window + idempotency key | — |
| Job payload tampering | T | Payload validated on consumption with Zod | Queue compromise |
| Duplicate side effects | T | Idempotency keys on every handler | Handler missing a key |
| Poison message stalls a queue | D | Bounded attempts, dead-letter, alert | — |
| External provider compromise | I | Minimal data sent; no secrets in payloads | Provider breach |
| Retry storm amplifying load | D | Bounded, jittered backoff; circuit breaker | — |

### 5.6 Availability (all)

| Threat | STRIDE | Mitigation | Residual risk |
|---|---|---|---|
| Traffic flood | D | Edge rate limiting, backpressure, queueing | Large-scale DDoS without upstream protection |
| Connection exhaustion | D | Pooling, statement timeouts, query caps | Slow query under adoption |
| Scheduled-job stampede | D | Distributed lock ensures one runner | Lock failure |
| Runaway report | D | Async execution with caps | — |
| Cache stampede on expiry | D | Jittered TTLs, single-flight | — |
| Blast radius of one tenant's load | D | Per-principal and per-tenant quotas (`ADR-0002`) | — |

## 6. Abuse Cases

Written alongside functional requirements so misuse is designed against, not discovered:

| # | Abuse case | Control |
|---|---|---|
| AC-1 | An agent enumerates request ids to read other teams' tickets | Object-level check + opaque ids + sweep test |
| AC-2 | An administrator approves their own request to hide a breach | Separation of duties |
| AC-3 | A user floods the API to deny service to others | Per-principal rate limits |
| AC-4 | An insider exports the entire audit log weekly | Export volume alerting + audit-read restriction |
| AC-5 | A requester uploads a file to probe internal storage paths | Content sniffing, server keys, non-executable serving |
| AC-6 | An integrator uses a service account beyond its declared scope | Declared operation scopes; scope-change review |
| AC-7 | A user replays an approval decision request to record two decisions | Immutable decisions + idempotency key |
| AC-8 | A user sets an SLA override to hide a breach | Override requires reason, permission, and is alerted |
| AC-9 | Someone edits an audit record to remove a change | Append-only grants; no update path exists |
| AC-10 | A stale replica serves pre-revocation data | Authorization re-checked on read; lag monitored |

## 7. Assumptions and Dependencies

| # | Assumption | If false |
|---|---|---|
| A1 | The hosting layer provides DDoS protection | Edge protection must be procured |
| A2 | The database is not directly reachable from the internet | Network policy is the primary control for B3 |
| A3 | Operators do not share administrative accounts | Attribution is meaningless; separation of duties fails |
| A4 | Email is not fully trusted for delivery | Reset flow needs a secondary channel |
| A5 | Tenancy is multi-tenant with a shared schema (`ADR-0002`) | The tenant dimension is mandatory in every query; a missing predicate is a cross-tenant leak |
| A6 | Object storage enforces access policy | Signed URL policy becomes the sole control |

## 8. Accepted and Deferred Risks

| Risk | Decision | Rationale |
|---|---|---|
| No MFA in v1 | Accepted for v1, scheduled v1.1 | Coverage requires enrolment UX; mitigated by lockout and rate limits |
| Multi-tenant shared schema | Accepted (`ADR-0002`) | Isolation is enforced by the mandatory tenant predicate and row-level security; a missing predicate is a tested-against leak (`20`) |
| No field-level encryption | Accepted | Classification and access controls are the boundary; revisit if regulated data is added |
| Full CMDB impact analysis out of scope | Accepted, recorded as `ADR-0011` | Reduces attack surface |

Each accepted risk has an owner and a review date; acceptance is a decision, not an
oversight.

## 9. Related

- `17-SECURITY-ARCHITECTURE.md` — the controls referenced throughout
- `07-ROLES-AND-AUTHORIZATION.md` — the B5 boundary
- `19-DATA-PROTECTION-AND-FILES.md` — classification and file handling
- `20-SECURITY-TESTING.md` — how these mitigations are verified
