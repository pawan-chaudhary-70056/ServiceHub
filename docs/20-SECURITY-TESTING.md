# 20 — Security Testing

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** QA Lead · **Approved:** 2026-10-01
**Consolidates:** old 52 and old 80 — these were duplicates of each other

> **Scope:** how the controls in `17` and the mitigations in `18` are verified. General
> test strategy and levels are `37`.

---

## 1. Principle

Security review that relies on reading code finds the mistakes someone thought of.
The controls in this product are **table-driven and therefore testable**: the roles ×
entities matrix from `07` §3, the object-level rules from `07` §4, and the endpoint
catalogue from `11` §9 are all data. Those become generated test fixtures.

The one failure mode that matters most in this product is a **missing object-level
check on a single endpoint**. Nobody notices it in review; it is found by an
exhaustive sweep or by an attacker. So the sweep is generated, not hand-written.

## 2. Test Layers

| Layer | What it covers | When it runs |
|---|---|---|
| Static analysis (SAST) | Injection sinks, unsafe patterns, taint flows | Every PR |
| Dependency scan | Known vulnerable packages | Every PR + nightly |
| Secrets scan | Committed credentials | Every PR + pre-commit |
| IaC/container scan | Image and config misconfiguration | Every build |
| Unit security tests | Hash params, token generation, redaction filters, sanitizers | Every PR |
| Authorization matrix | Every role × entity × action | Every PR |
| IDOR sweep | Every endpoint × foreign object | Every PR |
| API abuse tests | Rate limits, lockout, enumeration, oversized input | Every PR |
| Upload tests | Type sniffing, quarantine, serving headers | Every PR |
| DAST | Running application, authenticated and unauthenticated | Nightly on staging |
| Manual review | New auth/authz/file/crypto changes | Per PR |
| Penetration test | Full surface | Pre-major-release |

## 3. Automated Gates

A build fails on any of the following. There is no "warn only" mode for these.

| Gate | Failure condition |
|---|---|
| SAST | Any High or Critical finding |
| Dependency scan | Any Critical (High allowed only with a recorded, dated exception) |
| Secrets scan | Any match, without exception |
| Authorization matrix | Any endpoint lacking an annotation for its required permission |
| IDOR sweep | Any endpoint returning data for a foreign object |
| Redaction | Any secret-shaped value appearing in log output during tests |
| DAST | Any High finding, or any new Medium without triage |
| Coverage of security tests | The generated matrix must cover 100 % of documented endpoints |

**Exception process:** an exception is a document in the repository with a rationale,
an owner and an expiry date. Expiry forces re-review. Permanent exceptions are not
permitted.

## 4. Authorization Matrix Tests (generated)

The fixture is generated from the permission matrix and the endpoint catalogue:

```
for each endpoint E in openapi:
  for each role R in roles:
    for each object O in {owned, same-team, other-team, other-tenant}:
      assert response(E, R, O) matches expected(E, R, O)
```

| Scenario | Expected |
|---|---|
| Owner accessing own object | `200` |
| Team member accessing team object | `200` where the matrix grants team scope |
| Foreign user accessing an object | `404` (not `403`, per `07` §1) |
| Unauthenticated | `401` |
| Role lacking the permission entirely | `403` |
| Auditor attempting any mutation | `403` on every mutating endpoint |
| Admin attempting an approval decision | `403` — separation of duties (`07` §5) |

**Exhaustiveness is the point.** Adding an endpoint without adding it to the matrix
fails the coverage gate in §3, so a new route cannot ship untested for authorization.

## 5. IDOR Sweep

For every endpoint that accepts an object id and returns or mutates data, the sweep
creates two tenants' worth of fixtures and asserts that user A can never reach user B's
object — for reads *and* writes, and including child entities (comments, tasks,
attachments) which must never be more visible than their parent.

Coverage requirements:

| Vector | Tested |
|---|---|
| Path id substitution | Yes |
| Query filter substitution (`?teamId=other`) | Yes |
| Nested resource id substitution | Yes |
| Bulk operations containing a foreign id | Yes — partial failure, no foreign mutation |
| Export/report parameters that widen scope | Yes |
| Search results leaking out-of-scope items | Yes |

## 6. Authentication Tests

| Test | Assertion |
|---|---|
| Valid/invalid credentials | Correct status, identical response for unknown user vs wrong password |
| Enumeration | Response body and timing indistinguishable |
| Lockout | Threshold, duration, `Retry-After`, auto-unlock |
| Session expiry | Idle and absolute limits enforced server-side |
| Logout | Session invalid server-side; replaying the token fails |
| Password reset | Single use; expired rejected; all sessions revoked; owner notified |
| Hash strength | Argon2id parameters meet `NFR-SEC-002`; no weaker algorithm present |
| Reset token storage | Only a hash is persisted |
| Deactivation | Immediate effect on live sessions |
| Rate limits | `/auth/*` buckets tighter than general endpoints |

## 7. Injection and Input Tests

| Test | Method |
|---|---|
| SQL injection | Payload corpus against every filter, sort, id and search parameter |
| NoSQL/ORM operator injection | Objects where scalars are expected (e.g. `{"$ne": null}`) |
| Mass assignment | Undeclared fields never persist |
| XSS | Stored and reflected payloads in comments, KB articles, catalog text, asset fields |
| Sanitizer bypass | Known mutation payloads against the render path |
| Header injection | Newlines in header-bound input |
| Path traversal | Traversal sequences in filename and storage-key parameters |
| SSRF | Webhook and integration URLs pointing at internal ranges |
| Oversized input | Body, field and array limits enforced with `413`/`422` |
| Malformed JSON | `400`, no stack trace |
| Unicode/encoding | Homoglyph and mixing attacks in identifiers |

## 8. Abuse and Resilience Tests

| Test | Assertion |
|---|---|
| Rate limiting | `429` with `Retry-After`; limits per class (`33`) |
| Sustained flood | Degrades gracefully; other users unaffected |
| Calendar/date filters | Absurd ranges rejected, not executed |
| Pagination abuse | Over-limit `limit` rejected; cursor tampering rejected |
| Report flooding | Expensive reports throttled and queued |
| Account enumeration via timing on other endpoints | No differential |
| Privilege escalation via self-service | A user cannot modify their own roles or permissions |

## 9. File and Data Tests

Refer to `19-DATA-PROTECTION-AND-FILES.md` §8 for the file-specific set. In addition:

| Test | Assertion |
|---|---|
| Audit immutability | No application path can update or delete an audit record |
| Audit completeness | Every mutating operation leaves exactly one record |
| Log redaction | Secrets never reach any log sink |
| Export controls | Confidential fields masked without elevated permission |
| Backup encryption | Backup artifacts are unreadable without the key |

## 10. Manual and External Testing

| Activity | Cadence | Scope |
|---|---|---|
| Security review of PRs touching auth/authz/files/crypto | Every such PR | Diff-level |
| Threat model review | On new boundary/data class/integration | `18` |
| DAST with a session | Nightly | Authenticated surface |
| Penetration test | Before each major release, and annually | Full application and API |
| Red-team abuse cases | Per phase gate | `18` §6 abuse cases |
| Dependency and image review | Monthly | Full dependency tree |

**Penetration test findings** are triaged with the same severity SLA as dependency
findings (§11) and produce a remediating change, not only a report.

## 11. Severity and Remediation

| Severity | Examples | Fix deadline |
|---|---|---|
| Critical | Auth bypass, IDOR on Confidential data, RCE, secret exposure | ≤ 7 days, or block release |
| High | Privilege escalation with conditions, stored XSS, missing authz on a write | ≤ 30 days |
| Medium | Information disclosure, weak control with limited impact | ≤ 90 days |
| Low | Hardening, defence-in-depth | Next planned work |

**A Critical finding blocks release.** There is no release-with-critical under time
pressure; that trade is exactly how a security programme fails.

## 12. Evidence and Reporting

| Artifact | Contents |
|---|---|
| CI security report | Gate results, findings, exceptions with expiry |
| Authorization matrix report | Pass/fail per role × endpoint × object class |
| Pen test report | Findings, severity, remediation status |
| Security review notes | Per-PR checklist for sensitive changes |
| Threat model history | Dated revisions showing what changed and why |

Reports are retained with the release record so that "was this tested?" is answerable
for any deployed version.

## 13. Related

- `17-SECURITY-ARCHITECTURE.md` — the controls under test
- `18-THREAT-MODEL.md` — the threats these tests address
- `07-ROLES-AND-AUTHORIZATION.md` — the matrix that generates the fixtures
- `19-DATA-PROTECTION-AND-FILES.md` — file and data tests
- `37-TESTING.md` — general test strategy and CI
