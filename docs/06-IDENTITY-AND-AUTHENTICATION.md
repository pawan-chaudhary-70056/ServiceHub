# 06 — Identity and Authentication

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 24 (authN half) and 48 (authentication security)
**Decided by:** **ADR-0001** — server-side sessions in a shared store (**D-1**)

> **Scope:** establishing *who* the caller is. Deciding *what they may do* is
> `07-ROLES-AND-AUTHORIZATION.md`. The session storage choice is **D-1**, closed by
> `ADR-0001` (server-side sessions).

---

## 1. Identity Model

| Concept | Definition | Notes |
|---|---|---|
| Identity | A person or service account | Never a shared login |
| Credential | The secret proving an identity | Only ever a hash at rest |
| Session | A verified, time-bounded claim of identity | Server-invalidatable |
| Service account | A non-human identity for integrations | No interactive login |
| Platform operator | A privileged identity **above** tenants, used to provision them | Belongs to no organization; see §11 and `ADR-0012` |
| Entitlement | What the identity may do | Owned by `07` |

**Rule:** the identity is the audit actor. An action is never attributed to a role,
a team, or a shared account.

## 2. Authentication Strategy — resolved by `ADR-0001` (**D-1**)

**Decision (2026-10-01):** ServiceHub uses **server-side sessions**, stored in the
shared Redis instance (`ADR-0003`), delivered in an `httpOnly`, `Secure`, `SameSite=Lax`
cookie, with a **CSRF token** required on state-changing requests. This gives immediate
revocation, which `FR-USER-001` requires ("deactivation revokes live sessions"), without
building a token denylist. Stateless signed tokens were considered and rejected.

**Mandatory properties of this design:**
1. The session identifier is never readable by client-side script (`httpOnly`).
2. Sessions live in a **shared** store (Redis), not instance memory, so any instance can
   serve any request and a restart does not log every user out.
3. Deactivation and password change revoke existing sessions immediately.
4. Session lifetime is bounded by both an idle timeout and an absolute maximum.
5. Session identifiers are opaque and cryptographically random (≥128 bits).
6. The session identifier is regenerated on privilege change (login, elevation) to
   prevent fixation.
7. State-changing requests from a cookie-authenticated caller require a valid CSRF
   token; a missing or mismatched token is rejected.

**Platform operators** (`ADR-0012`) authenticate through this same
mechanism and receive the same session handling. Their identity has **platform scope**
and belongs to no organization; their entitlements are platform-level permissions only
(`07` §2), and they hold no blanket access to tenant records.

## 3. Login Flow

```
Client                     API                    DB
  │ POST /auth/login        │
  │  {email, password}      │
  ├────────────────────────▶│
  │                         │ rate-limit check (tight bucket)
  │                         │ lookup identity by email
  │                         │   └─ not found → SAME response, same timing
  │                         │ verify password hash
  │                         │   └─ invalid → generic 401
  │                         │ account active? ── no ──▶ generic 401
  │                         │ lockout state? ── locked ──▶ 423 + retry-after
  │                         │ ── issue session ──▶│
  │                         │ ── audit: login.success / login.failure
  │◀── 200 + session cookie │
  │    (never the password, │
  │     never the hash)     │
```

**Failure responses are deliberately indistinguishable** between "unknown email" and
"wrong password" — in body and in timing — to prevent user enumeration. Failed
attempts are counted and audited; successes and failures are both rate limited.

## 4. Password Handling

| Rule | Value | Requirement |
|---|---|---|
| Algorithm | Argon2id | NFR-SEC-002 |
| Memory | ≥ 64 MiB | configurable, tuned at deploy |
| Iterations | ≥ 3 | |
| Parallelism | ≥ 1 | |
| Password policy | Minimum length 12, breached-password check if available | FR-AUTH-004 |
| Storage | Hash only; plaintext never persisted, logged, or returned | FR-AUTH-004 |
| Comparison | Constant-time | |
| Rotation | Never forced on a schedule | NIST guidance: rotation harms more than helps |
| Change | Requires current password (unless initiated by reset flow) | |
| Reuse | Last N hashes rejected | Should |

**Prohibited:** MD5, SHA-1, SHA-256 alone, unsalted schemes, reversible encryption,
"encrypt then hash" patterns, passwords in URLs or query strings.

## 5. Password Reset Flow

```
POST /auth/forgot {email}
   │  ALWAYS returns 202, whether or not the email exists
   ▼
generate token: random ≥128 bits, store HASH of token, set expiry (≤60 min)
   │
   ▼
enqueue email job (async — see 29)
   │
   ▼
user opens link → POST /auth/reset {token, newPassword}
   │
   ├─ token unknown / expired / already used → generic failure
   ├─ password fails policy → 422 with field errors
   └─ valid → set hash · invalidate ALL existing sessions · mark token used
                    │
                    ▼
              audit: password.reset
                    │
                    ▼
              notify the account owner (so a silent takeover is visible)
```

**Rules:** tokens are single-use, hashed at rest, and invalidated by a successful
reset; requesting a reset never reveals whether an account exists; resetting a
password revokes every active session.

## 6. Lockout and Throttling

| Control | Behaviour | Requirement |
|---|---|---|
| Per-account lockout | After N consecutive failures, temporary lock with `423` + `Retry-After` | FR-AUTH-006 |
| Per-IP rate limit | Tight bucket on `/auth/*` | FR-AUTH-* |
| Global auth throttle | Bounds credential-stuffing volume | SEC |
| Backoff | Exponential, resets on success | |
| Unlock | Automatic on timeout; administrative unlock is audited | |

Auth endpoints get the strictest limits in the system (`33` §Rate limiting).

## 7. Session Lifecycle

| Event | Effect |
|---|---|
| Login | New session issued; identifier regenerated |
| Idle timeout reached | Session invalid; next request → `401` |
| Absolute lifetime reached | Session invalid regardless of activity |
| Logout | Server-side invalidation |
| Password change/reset | All sessions for the identity invalidated |
| Account deactivated | All sessions invalidated immediately |
| Role changed | Session remains; entitlements are re-read per request |
| Suspicious activity | Administrative revocation, audited |

Entitlements are resolved **per request** from the database, not cached in the
session, so a role revocation takes effect immediately without waiting for expiry.

## 8. MFA (post-v1)

`FR-AUTH-007` is Could. When implemented: TOTP with recovery codes; enrolment requires
re-authentication; disabling MFA requires re-authentication and is audited; MFA state
is checked at login before a session is issued.

## 9. Threat Notes

| Threat | Control |
|---|---|
| Credential stuffing | Rate limiting, lockout, breached-password rejection |
| User enumeration | Identical responses and timing on the login path |
| Session fixation | Regenerate identifier on login/elevation |
| Session hijacking | `httpOnly` + `Secure` + `SameSite`; short idle timeout |
| CSRF | `SameSite` + CSRF token (cookie-based, `ADR-0001`) |
| XSS stealing credentials | No token in `localStorage`; CSP (`17`) |
| Brute force on reset tokens | High-entropy token, hashed storage, expiry, single use |
| Timing attacks | Constant-time comparison; uniform failure paths |
| Credential leakage in logs | Logging filter rejects password/token fields (`34`) |
| Shared accounts | Prohibited; service accounts are distinct and audited |

## 10. Test Obligations

| Test | Assertion |
|---|---|
| Login success/failure | Correct status; no enumeration signal |
| Inactive user | Cannot log in; existing sessions dead |
| Password reset | Token single-use; sessions revoked; owner notified |
| Lockout | Threshold honoured; auto-unlock; `Retry-After` present |
| Session expiry | Idle and absolute limits enforced |
| Deactivation | Immediate effect on live sessions |
| Hash at rest | No plaintext or weak hash appears anywhere |
| Log filtering | Passwords and tokens absent from all log output |
| Invitation | Token single-use, hashed, expiry-bounded; re-invite invalidates the prior token |
| Invitation vs reset | An invitation establishes a first credential; reset replaces an existing one |
| Operator scope | A platform operator belongs to no organization and reads no tenant record |

## 11. User Onboarding and Invitation

> **`ADR-0012` (Accepted, 2026-10-02).** Implements the onboarding flow of `04` §13.3.

§5 replaces an existing credential. This section **establishes** the first one, which
`FR-AUTH-001` assumes has already happened ("a registered active user").

```
Tenant administrator
   │  invites (email + initial role)
   ▼
create Invitation: random token (≥128 bits) → store HASH, set expiry, record invitedBy
   │  enqueue invitation email via the outbox (29 §3) — NEVER sent inline
   ▼
invitee opens link → POST /auth/accept-invitation {token, password}
   │
   ├─ token unknown / expired / already used → generic failure
   ├─ password fails policy (§4) → 422 with field errors
   └─ valid → set hash · identity ACTIVE · invalidate all prior outstanding tokens
                    │
                    ▼
              audit: user.invited → user.activated
```

**Rules**

1. Tokens are single-use, hashed at rest, and expiry-bounded (`ADR-0012`).
2. Re-inviting or revoking a user invalidates any outstanding token.
3. The invitation email is transactional and cannot be opted out (`29` §7).
4. Inviting an address never confirms whether an account already exists.
5. An invitation grants nothing until a credential is set and the identity is active.
6. Inviting an identity into a **new organization** is the provisioning flow of
   `04` §13.2, not the ordinary per-tenant invite.

## 12. Related

- `07-ROLES-AND-AUTHORIZATION.md` — what the authenticated caller may do
- `17-SECURITY-ARCHITECTURE.md` — transport, headers, CSP, secrets
- `12-VALIDATION-RULES.md` — auth payload schemas
- `29-NOTIFICATIONS-AND-MESSAGING.md` — reset and security emails
- `31-AUDIT-LOGGING.md` — auth audit events
