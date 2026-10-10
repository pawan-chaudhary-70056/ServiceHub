# 07 — Roles and Authorization

**Status:** Approved · **Owner:** Security Lead · **Reviewer:** Product Lead · **Approved:** 2026-10-01
**Consolidates:** old 11 (user roles/permissions) and 49 (authorization security)
**Decided by:** **ADR-0002** — multi-tenant shared schema (**D-2**)

> **Scope:** deciding *what an authenticated caller may do*, on what object, in what
> scope. Establishing identity is `06`.

---

## 1. Authorization Model

ServiceHub authorizes in three stages, always in this order:

```
1  ROLE         does this role hold the required permission at all?
2  SCOPE        is the object inside the caller's scope (tenant/org/team)?
3  OBJECT       is the caller entitled to THIS object (owner, assignee,
                approver, custodian, member)?
```

A check that stops at stage 1 is **necessary and insufficient**. The dominant
real-world failure in tools like this is a correct role check combined with a
missing object check, producing IDOR — where any agent can read any ticket by
changing an id in the URL. Stage 3 exists specifically to prevent that.

### Permission naming

```
<resource>:<action>[.<qualifier>]

request:create          request:read.own        request:read.team
request:read.any        request:update.assigned request:update.any
request:assign          request:cancel.own      request:close.any
incident:create         incident:read.any       incident:update.any
sla:policy:manage       sla:clock:override      approval:decide
kb:article:publish      asset:assign            user:role:manage
audit:read              report:read             admin:config
integration:manage      integration:read        integration:retry
platform:organization:manage                     platform:operator:manage
```

`platform:*` permissions are **platform-scoped**, not tenant-scoped: they are held only
by a platform operator (`ADR-0012`) and grant no access to tenant records.

Permissions are data, not literals scattered through code. Roles map to permission
sets; a service asks "does this caller hold `request:update.assigned` for this
request?" and never inspects a role name directly.

## 2. Roles

| Role | Purpose | Notes |
|---|---|---|
| Requester | Raise and track own work | Default role for every employee |
| Agent | Work assigned items across a team | Read is team-scoped unless granted `.any` |
| Team Lead | Own queue health and SLA compliance | Team-scoped management + reassignment |
| Approver | Decide approvals only | May hold no fulfilment permissions |
| Knowledge Contributor | Author and publish articles | No access to work items |
| Asset Manager | Own asset register and lifecycle | No access to SLA administration |
| Administrator | Configure the system | **Cannot** approve requests (see §5) |
| Auditor | Read-only over audit and records | **No** mutation permission of any kind |
| Integration | Non-human principal for APIs/webhooks | Scoped to declared operations only |
| Super Admin (platform operator) | Provision and suspend tenants; manage platform operators (`ADR-0012`) | Member of no organization; **cannot** administer or approve tenant records |

Roles are additive: effective permissions are the **union**. There are no negative
permissions and no role hierarchy — hierarchy produces surprising inherited grants,
and the union model is trivially auditable.

## 3. Permission Matrix

Legend: **A** = all/any · **T** = within team/scope · **O** = own only · **—** = none

| Capability | Requester | Agent | Team Lead | Approver | KB Contrib | Asset Mgr | Admin | Auditor |
|---|---|---|---|---|---|---|---|---|
| Catalog browse | A | A | A | A | A | A | A | A |
| Catalog manage | — | — | — | — | — | — | A | — |
| Request create | A | A | A | A | — | A | A | — |
| Request read | O | T | T | — | — | — | A | A |
| Request read (any) | — | — | A | — | — | — | A | A |
| Request update | O (cancel) | T | T | — | — | — | A | — |
| Request assign | — | T | T | — | — | — | A | — |
| Request close | — | T | T | — | — | — | A | — |
| Incident create | A | A | A | A | A | A | A | — |
| Incident read | O | T | T | — | — | — | A | A |
| Incident update | — | T | T | — | — | — | A | — |
| Task update | O (status) | T | T | — | — | — | A | — |
| Approval decide | — | — | — | A | — | — | — | — |
| Approval read pending | — | — | T | A | — | — | A | A |
| SLA policy manage | — | — | — | — | — | — | A | — |
| SLA clock override | — | — | T (reason) | — | — | — | A | — |
| KB read | A | A | A | A | A | A | A | A |
| KB author | — | — | — | — | A | — | A | — |
| KB publish | — | — | — | — | A | — | A | — |
| Asset read | O (own) | T | T | — | — | A | A | A |
| Asset manage | — | — | — | — | — | A | A | — |
| Asset assign | — | — | — | — | — | A | A | — |
| Notification preferences | O | O | O | O | O | O | A | — |
| Report read | — | T | T | — | — | T | A | A |
| Audit read | — | — | T | — | — | — | A | A |
| Audit export | — | — | T | — | — | — | A | A |
| Integration read | — | — | — | — | — | — | A | — |
| Integration manage | — | — | — | — | — | — | A | — |
| Integration retry | — | — | — | — | — | — | A | — |
| User manage | — | — | — | — | — | — | A | — |
| Role manage | — | — | — | — | — | — | A | — |
| System config | — | — | — | — | — | — | A | — |

This matrix is the source of truth for role defaults. It is seeded, not hard-coded,
so an organisation can adjust it without a deployment.

**Platform-scoped capabilities** (`ADR-0012`) are deliberately **not** in
the tenant matrix above: no tenant-scoped role holds them. Legend: **A** = all.

| Capability | Super Admin |
|---|---|
| Provision / suspend an organization | A |
| Create and manage platform operators | A |
| Read platform-scope audit | A |
| Read or administer tenant records | — |

## 4. Object-Level Rules

| Entity | Entitled when |
|---|---|
| Service request | Requester (own) · assignee · member of owning/assigned team · admin · auditor |
| Incident | Reporter (create only) · assignee · team member · admin · auditor |
| Task | Assignee · parent's requester (read only) · parent's team · admin |
| Approval | Designated approver for the active step · admin (read) |
| Knowledge article | Published: everyone · Draft/In review: author, contributor, admin |
| Asset | Custodian · assignee · asset manager · admin · auditor |
| Attachment | Anyone entitled to the parent entity |
| Notification | The addressed user only |
| Audit record | Auditor and admin only |
| Organization (tenant) | Platform operator (provision/suspend, `ADR-0012`) · tenant Administrator (read own organization) |

**Read entitlement is derived from the parent for children.** A task is never more
visible than its parent; an attachment is never more visible than its parent. This
prevents the classic leak where a child record's list endpoint omits the access rule
its parent enforces.

## 5. Separation of Duties

| Rule | Rationale |
|---|---|
| Administrator cannot approve requests | Configure-and-approve is a fraud path |
| Approver holds no fulfilment permissions | Prevents self-approval by working the ticket |
| Auditor has no write permission | A read-only trail must be read by a read-only principal |
| A requester cannot approve their own request | Self-approval invalidates the control |
| A user may not assign work to themselves to bypass approval | Assignment is audited; the rule is enforced at the approval step, not at assignment |
| A platform operator cannot administer or approve tenant work | Provisioning must not become tenant control |
| A tenant Administrator cannot provision tenants | Tenant administration is not platform administration |

Where a rule must be broken operationally, the break is an **audited override with a
recorded reason**, never a permission grant.

## 6. Enforcement Points

| Layer | Enforces | Notes |
|---|---|---|
| Route/middleware | Coarse permission presence | Fast rejection; not sufficient alone |
| Service | Full role + scope + object check | **The authoritative check** |
| Repository query | Scope filter in the query itself | Defence in depth |
| UI | Visibility of controls | **UX only — never a control** |

**Repository-level scoping** deserves emphasis: list endpoints must scope in the
query (`where: { teamId: { in: callerTeams } }`), not by fetching everything and
filtering in application code. Filtering after the fetch means a single missed
`filter()` leaks the whole table, and the query is unbounded besides.

## 7. Scope and Tenancy (resolved by `ADR-0002`, **D-2**)

**Decision (2026-10-01):** ServiceHub is **multi-tenant with a shared schema**. Scope
is therefore a **mandatory dimension** of every query and every index prefix, and stage 2
of §1 is the **tenant check**, applied before the object check. `organizationId` is
present on every tenant-scoped table (`08` §1) and must be applied **inside** the query
in `models/`, never as a post-fetch filter (§6). A missing tenant predicate is a
cross-tenant leak and carries a mandatory negative test (`20`, `37`).

## 8. Escalation and Break-Glass

| Mechanism | Behaviour |
|---|---|
| Role change | Audited; effective immediately (entitlements resolved per request) |
| Emergency admin grant | Time-bounded, dual-approved, loudly audited |
| Delegation | Time-bounded, attributed to both delegator and delegate |
| Service accounts | Least-privilege, scoped, rotated, never interactive |

## 9. Test Obligations

| Test | Assertion |
|---|---|
| IDOR sweep | Every entity's read/update endpoint rejects a foreign id for every role |
| List scoping | A list endpoint never returns an object outside the caller's scope |
| Child inheritance | Task/attachment visibility ≤ parent visibility |
| Separation of duties | Admin cannot approve; approver cannot fulfil |
| Role union | Adding a role only adds permissions |
| Revocation timing | A removed permission denies on the very next request |
| Enumeration | Unauthorized access to an existing object does not confirm existence |
| Override auditing | Every override leaves actor + reason |
| Operator scope | A platform operator cannot read or mutate any tenant record |
| Provisioning authority | Only a platform operator can create or suspend a tenant (`ADR-0012`) |

This is table-driven, not hand-written: the roles × entities matrix is the test
fixture (`20-SECURITY-TESTING.md`).

## 10. Related

- `06-IDENTITY-AND-AUTHENTICATION.md` — establishing the caller
- `11-API-CONTRACT.md` — `401` vs `403` vs `404` semantics
- `19-DATA-PROTECTION-AND-FILES.md` — data classification by role
- `31-AUDIT-LOGGING.md` — recording authorization decisions and overrides
- `20-SECURITY-TESTING.md` — automated IDOR and matrix tests
