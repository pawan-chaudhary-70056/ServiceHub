# 17 — Security Architecture

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** Tech Lead · **Approved:** 2026-10-01
**Consolidates:** old 43, 44, 45, 46, 97 and the policy half of old 53 (security
requirements, architecture, flow, controls, secure coding, secrets)
**Decided by:** **ADR-0001** (D-1 — cookie-based sessions with CSRF)

> **Scope:** the security posture and the controls that implement it. Specific threats
> and their residual risk are `18`. Data classification and files are `19`. How it is
> tested is `20`. Where secrets are physically injected is `35`.

---

## 1. Objectives and Non-Goals

| Objective | Priority |
|---|---|
| Confidentiality — a caller sees only what they are entitled to | Highest |
| Integrity — a record is changed only by an entitled actor, and the change is recorded | Highest |
| Availability — the service resists abuse and degrades predictably | High |
| Accountability — every mutation is attributable and reconstructable | Highest |
| Privacy — personal data is minimised, retained deliberately, and erasable | High |

**Non-goals:** ServiceHub is not a secrets manager, not a payment processor, and not
an identity provider. Where those capabilities are needed, they are integrated, not
built.

## 2. Control Layers

Security is layered so that no single failure is fatal. A control that exists in only
one layer is a control that fails when that layer is bypassed.

```
┌─────────────────────────────────────────────────────────────┐
│ EDGE          TLS · HSTS · CSP · CORS · coarse rate limit    │
├─────────────────────────────────────────────────────────────┤
│ TRANSPORT     certificate management · modern suites only    │
├─────────────────────────────────────────────────────────────┤
│ IDENTITY      Argon2id · session hygiene · lockout · reset   │ (06)
├─────────────────────────────────────────────────────────────┤
│ AUTHORIZATION role + scope + object, enforced in services    │ (07)
├─────────────────────────────────────────────────────────────┤
│ INPUT         Zod at every boundary · strict · bounded        │ (12)
├─────────────────────────────────────────────────────────────┤
│ APPLICATION   state machines · idempotency · transactionality │
├─────────────────────────────────────────────────────────────┤
│ DATA          parameterised queries · least privilege · backups│(19)
├─────────────────────────────────────────────────────────────┤
│ OBSERVABILITY audit trail · security logging · alerting       │ (31, 34)
├─────────────────────────────────────────────────────────────┤
│ OPERATIONS    secret rotation · patch SLAs · IR runbook       │ (35, 36)
└─────────────────────────────────────────────────────────────┘
```

## 3. Transport

| Control | Requirement |
|---|---|
| Protocol | HTTPS only; HTTP redirects to HTTPS permanently |
| TLS version | 1.2 minimum, 1.3 preferred; weaker versions and suites disabled |
| HSTS | `max-age` ≥ 6 months, `includeSubDomains`, preload where the domain is fully controlled |
| Certificates | Automated issuance and renewal; expiry alerted ≥ 30 days ahead |
| Internal traffic | Encrypted in transit as well, including application↔database |
| Mixed content | Blocked; no `http://` subresources |

## 4. Headers and Browser Policy

| Header | Value / purpose |
|---|---|
| `Strict-Transport-Security` | Force HTTPS |
| `Content-Security-Policy` | `default-src 'self'`; no `unsafe-inline` for scripts; connect-src limited to the API origin; no third-party script inclusion without review |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` / `frame-ancestors` | Deny framing — prevents clickjacking of approval decisions |
| `Permissions-Policy` | Deny camera, microphone, geolocation unless a feature requires one |
| `Cross-Origin-Opener-Policy` | `same-origin` |

**CSP is the mitigation of last resort for XSS**, because output encoding is a habit
and CSP is a mechanism. A nonce-based policy is required for scripts; `unsafe-inline`
on scripts is prohibited.

## 5. CORS

- Allow-list of origins only — never `*` with credentials.
- Credentials are allowed only for known frontend origins; cookie-based sessions
  (`ADR-0001`) require this, so a wildcard origin with credentials is never acceptable.
- Preflight cached; methods and headers enumerated, not wildcarded.
- Requests from unlisted origins receive no CORS headers (the browser enforces it),
  and the attempt is logged.

## 6. Injection and Output

| Class | Control |
|---|---|
| SQL/NoSQL injection | Prisma parameterisation only; raw SQL is exceptional, reviewed, and always parameterised (`13` §6) |
| XSS (stored/reflected) | Output encoding by framework default; **no `dangerouslySetInnerHTML`**; markdown/rich text sanitised with an allow-list on render |
| Template injection | No user input in template or message construction |
| Command injection | No shell execution on user input; if unavoidable, argument arrays and no shell |
| Header/response splitting | Header values validated and encoded |
| Open redirect | Redirect targets constrained to same-origin or an allow-list |
| SSRF | Outbound integration URLs are allow-listed and not derived from user input; private address ranges blocked |
| Path traversal | Storage keys are server-generated; user filenames never used as paths (`19`) |
| Mass assignment | Strict schemas; only documented fields accepted (`11` §7) |
| Deserialisation | JSON only; no untrusted object graphs |

## 7. Secrets Management

| Rule | Detail |
|---|---|
| Never in source | No secrets in the repository, including history; secrets scanning runs in CI and blocks the build |
| Never in the image | Container images contain no secrets; injected at runtime |
| Centralised | Environment-injected in dev/staging; a managed secret store in production |
| Typed and validated | Loaded once, validated at boot, fail fast (`13` §9) |
| Redacted in logs | Logging filter removes secrets, tokens and passwords (`34`) |
| Rotatable | Every secret has a documented owner and a rotation procedure |
| Rotation cadence | Database credentials ≤ 90 days; API keys ≤ 90 days; **immediately and unconditionally on suspected exposure** |
| Least privilege | Each component gets only the secrets it needs; no shared "app" credential across services |
| Separation | Database credentials for the app, for migrations, and for backups are distinct |

**Exposure response is not a judgement call:** a leaked secret is rotated first and
investigated second. Rotating costs minutes; not rotating costs the incident.

## 8. Secure Coding Standards

Rules that apply to every change. Violations are review blockers, not suggestions.

| # | Rule |
|---|---|
| SC-1 | Every boundary input is validated with Zod; unknown fields are rejected |
| SC-2 | Authorization is checked in the service on the resolved object, never only on the route |
| SC-3 | Scope filters are applied **inside** queries, never as a post-fetch filter |
| SC-4 | All queries are parameterised; string-concatenated SQL is prohibited |
| SC-5 | No secret, token, password or key is logged, returned, or placed in a URL |
| SC-6 | Errors returned to clients contain no stack traces, SQL, paths or other users' data |
| SC-7 | Cryptographic primitives come from vetted libraries; no hand-rolled crypto |
| SC-8 | Randomness for security purposes comes from a CSPRNG, never `Math.random` |
| SC-9 | Comparisons of secrets and tokens are constant-time |
| SC-10 | External calls have explicit timeouts and bounded retries; retries only for idempotent operations |
| SC-11 | Files are validated by content, named by the server, and served non-executably |
| SC-12 | Every mutation writes an audit record in the same transaction |
| SC-13 | Dependencies are pinned, scanned, and patched per the SLA in §10 |
| SC-14 | Feature flags and debug endpoints are disabled in production; no debug bypass of auth |
| SC-15 | New external integrations are security-reviewed before release |

## 9. Secure Development Lifecycle

| Phase | Activity |
|---|---|
| Requirements | Abuse cases recorded alongside functional requirements (`18` §6) |
| Design | Threat model updated for any new trust boundary or data class (`18`) |
| Implementation | Secure coding standards; secrets scanning; dependency review |
| Review | Security checklist in the PR template; security reviewer required for auth, authz, file, crypto changes |
| Test | SAST, DAST, dependency scan, authorization matrix tests (`20`) |
| Release | Security gates in CI; no release with a Critical finding |
| Operate | Monitoring, alerting, patch SLAs, rotation, incident response |

## 10. Dependency and Supply Chain

| Control | Rule |
|---|---|
| Pinning | Lockfiles committed; builds are reproducible |
| Scanning | Automated scan on every PR and nightly |
| Remediation SLA | Critical ≤ 7 days; High ≤ 30 days; Medium ≤ 90 days |
| Abandoned packages | No dependency without a maintained release in 18 months without explicit review |
| Typosquatting | New dependencies require a look at the publisher, download volume, and repository |
| Build integrity | CI runs from a pinned toolchain; build artifacts are not hand-assembled |
| Transitive depth | A dependency that pulls 50 transitive packages is reviewed as 51 decisions, not one |

## 11. Security Logging and Monitoring

| Event | Logged | Alerted |
|---|---|---|
| Authentication success/failure | Yes | On failure spikes |
| Lockout triggered | Yes | Yes |
| Authorization denial | Yes | On volume spikes |
| Authorization override used | Yes, with reason | Yes |
| Role or permission change | Yes | Yes |
| Secret rotation | Yes | No |
| Rate limit exhaustion | Yes | On sustained saturation |
| Admin configuration change | Yes | Yes |
| Audit record write failure | Yes | **Immediate — this is a control failure** |

Security events are written to the audit trail (`31`) where they concern data, and to
security logs where they concern access attempts. **Sensitive values are never
logged**, including in failure paths — a debug log of a failed login containing the
attempted password is a breach.

## 12. Incident Response (summary)

1. **Detect** — alert or report.
2. **Contain** — revoke sessions/keys, isolate the instance, disable the affected path.
3. **Preserve** — do not destroy logs; snapshot before remediation.
4. **Eradicate** — patch, rotate, redeploy.
5. **Notify** — affected parties and, where required, regulators, within legal windows.
6. **Learn** — blameless review; produce a change (ADR, control, or test), not just a document.

Full procedure and contacts: `36-OPERATIONS-AND-RECOVERY.md`.

## 13. Anti-Patterns (Prohibited)

1. Authentication or authorization enforced in the UI.
2. Role checks without object checks.
3. A "temporary" admin bypass, debug endpoint, or backdoor account.
4. Secrets in environment defaults committed to the repo.
5. `unsafe-inline` scripts, wildcard CORS with credentials, or disabled TLS verification.
6. Trusting a client-supplied identifier, role, price, or timestamp.
7. Caching a response that varies by user in a shared cache.
8. Serving uploaded files from the application's own origin as active content.
9. Retrying a non-idempotent operation automatically.
10. Logging request bodies on authentication endpoints.

## 14. Related

- `06-IDENTITY-AND-AUTHENTICATION.md` · `07-ROLES-AND-AUTHORIZATION.md`
- `18-THREAT-MODEL.md` · `19-DATA-PROTECTION-AND-FILES.md` · `20-SECURITY-TESTING.md`
- `31-AUDIT-LOGGING.md` · `34-OBSERVABILITY.md` · `35-DEPLOYMENT-AND-CI-CD.md`
