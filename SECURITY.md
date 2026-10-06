# Security Policy

ServiceHub handles service records, user identity, approval decisions and audit history.
Security is a design constraint of this project, not a hardening phase — see
`docs/17-SECURITY-ARCHITECTURE.md` and `docs/18-THREAT-MODEL.md`.

---

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately to the maintainers with:

- affected component and version/commit,
- a description of the impact,
- reproduction steps or a proof of concept,
- any suggested remediation.

You will receive an acknowledgement, an assessment, and a remediation timeline. Please
allow time for a fix before public disclosure.

---

## Supported versions

The project is pre-1.0 and has no released versions yet. Security fixes are applied to
the main branch.

---

## Security controls in force

The implementation must satisfy the controls below. Each is owned by a document; the
document, not this file, is authoritative.

| Control | Requirement | Document |
|---|---|---|
| Password hashing | **Argon2id**; never reversible, never logged | `docs/06` |
| Authentication | Server-side sessions in a shared store, `httpOnly` cookie + CSRF token, immediately revocable (**D-1** → `ADR-0001`) | `docs/06` |
| Authorization | RBAC **and** object-level access, enforced in the **service layer** | `docs/07` |
| Input validation | Zod at every boundary; client validation is UX only | `docs/12` |
| Output encoding | User content escaped in HTML and email templates | `docs/17` |
| Rate limiting | Distinct limits per surface, incl. authentication and password reset | `docs/33` |
| Audit logging | Append-only, written in the mutation's transaction, tamper-evident | `docs/31` |
| Secrets | Injected at runtime; never in the repo, the image, or a `VITE_` variable | `docs/17`, `docs/35` |
| File uploads | Validated by content, size-bounded, scanned, stored off-instance | `docs/19` |
| Data protection | Classified, retention-bounded, redacted before storage | `docs/19` |
| Supply chain | Dependency and container scanning gate the build | `docs/35` |
| Logging hygiene | No secrets, tokens or PII in logs, errors or audit snapshots | `docs/34` |

---

## Non-negotiable rules for contributors

1. **Never commit a secret.** `.env` is git-ignored; `.env.example` carries keys only.
2. **Anything in a `VITE_` variable is public** — it is compiled into the browser bundle.
   No API key, token or credential may appear there.
3. **Every mutation writes its audit record in the same transaction.** A mutation without
   an audit entry is a defect.
4. **Authorization belongs in the service layer.** Route-level checks alone are a defect,
   because every non-HTTP caller bypasses them.
5. **Never delete or rewrite an audit row**, and never add an update path to an approval
   decision.
6. **Report suspected data exposure immediately**, even if you are unsure.

---

## Handling of sensitive data

- No production data in development, CI or staging; staging uses anonymised data
  (`docs/35`).
- Personal data is minimised in payloads, logs and audit snapshots (`docs/19`).
- Backups include at least one immutable, offsite copy that application credentials
  cannot delete (`docs/36`).
