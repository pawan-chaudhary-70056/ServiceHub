# 04 — Workflows and Flows

**Status:** Approved · **Owner:** Tech Lead · **Reviewer:** Product Lead · **Approved:** 2026-10-01
**Consolidates:** old 06, 07, 23, 29, 33 (application workflow, end-to-end flow,
API flow, backend flow, frontend flow)

> **Scope of this document:** how a unit of work moves through the system, and the
> order in which the layers are touched. **What the layers are** is in `03`. **What
> each state means** is in the owning feature doc (`21`–`28`). **The wire format** is
> in `11` and `12`.

---

## 1. The Master Workflow

Every unit of work in ServiceHub follows one shape. Feature docs specialise the
states; they do not re-invent the shape.

```
IDENTIFY             the actor and their entitlements
   ↓
INTAKE               a catalog item, or an incident report
   ↓
CLASSIFY             category, priority (derived, not free-chosen)
   ↓
PLAN                 approvals required? tasks required?
   ↓
EXECUTE              approvals decided, tasks completed, work done
   ↓
MEASURE              SLA clock running throughout, state derived
   ↓
CLOSE                resolution/fulfilment recorded, requester confirmed
   ↓
RETAIN               audit record, knowledge article, asset history
```

**Cross-cutting at every step:** authorization is re-checked, SLA state is
re-derived, notifications are enqueued, and an audit record is written for every
mutation.

## 2. End-to-End Flow: A Service Request

```
Requester        SPA            API              Service         DB        Async
    │             │              │                  │             │          │
    │ browse cat. │──GET /catalog─▶│                  │             │          │
    │             │◀────items─────│                  │             │          │
    │ submit form │──POST /requests─▶ validate (Zod) │             │          │
    │             │              │──authorize───────▶│             │          │
    │             │              │                  │─BEGIN TX────▶│          │
    │             │              │                  │ create req  │          │
    │             │              │                  │ audit write │          │
    │             │              │                  │ SLA start   │          │
    │             │              │                  │─COMMIT──────▶│          │
    │             │              │                  │──enqueue notify────────▶│
    │             │◀──201 + body─│◀─────────────────│             │          │
    │             │              │                  │             │          │
    │             │              │                  │             │  deliver │
    │             │              │                  │             │  email   │
```

**Invariants demonstrated by this flow**

1. Validation happens **before** any business logic or database access.
2. Authorization happens **inside** the service, on the resolved object — not only
   on the route.
3. The mutation, its audit record, and its SLA start share **one transaction**; a
   partial success is impossible.
4. Notification is enqueued **after** commit. Enqueueing before commit can deliver a
   notification for a rolled-back change — a real and common defect.
5. The response does not wait for delivery.

## 3. Synchronous Request Flow (layer by layer)

```
1  Edge          TLS · IP rate limit · route to healthy instance
2  Middleware    correlation id · request log context
3  Middleware    authenticate → caller identity (401 if absent/invalid)
4  Middleware    route rate limit (auth/upload/search have tighter buckets)
5  Controller    parse body/query → Zod schema → 422 on failure (no partial work)
6  Service       role check → object-level check → 403/404 as appropriate
7  Service       business rules · state machine transition validity
8  Service       transaction boundary opens (only if >1 write)
9  Repository    parameterised, indexed, paginated query
10 Service       audit record written inside the transaction
11 Service       domain events emitted → enqueued after commit
12 Controller    shape response envelope → 2xx
13 Middleware    access log with status, duration, correlation id
```

**Ordering rules that must not be rearranged**

- Validation before authorization: a malformed request should not disclose whether
  an object exists.
- Authorization before business logic: no state is read for a decision until the
  caller is entitled to it.
- Audit inside the transaction: an audit trail that can miss a successful mutation
  is not an audit trail.
- Enqueue after commit: see §2.4.

## 4. Authorization Decision Flow

```
Request
   │
   ▼
Authenticated? ──no──▶ 401
   │ yes
   ▼
Role allows the action? ──no──▶ 403
   │ yes
   ▼
Resolve the target object ──not found / not visible──▶ 404
   │ found
   ▼
Object-level rule satisfied?
  (owner · team · assignee · approver · scope)
   │
   ├── yes ──▶ proceed
   └── no  ──▶ 403
```

**Rule:** "not entitled" and "does not exist" are indistinguishable to the caller
where existence itself is sensitive (returns `404`). The distinction is recorded in
the audit/telemetry layer, not in the response.

Full permission matrix: `07-ROLES-AND-AUTHORIZATION.md`.

## 5. Approval Workflow Flow

```
Request created ──▶ approvals required by policy?
                        │
              ┌─── no ───┴─── yes ───┐
              ▼                       ▼
        IN_PROGRESS          APPROVAL_PENDING
                                      │
                              SLA clock PAUSED
                                      │
                    ┌─────────────────┴─────────────────┐
                    │ notify designated approvers        │
                    └─────────────────┬─────────────────┘
                                      ▼
                          step decision (ANY / ALL)
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
                 approved           rejected          expired
                    │                 │                 │
        more steps? │                 │                 │
        yes → next  │                 ▼                 ▼
        no  → APPROVED        REJECTED → requester   policy-defined
                    │                                    │
                    ▼                                    ▼
              IN_PROGRESS                     (block / escalate)
```

Decisions are immutable; a reversal is a new decision, not an edit
(`26-APPROVAL-MANAGEMENT.md`).

## 6. https://www.startpage.com/av/proxy-image?piurl=https%3A%2F%2Fimg.icons8.com%2Fp1em%2F1200%2Fgithub.jpg&sp=1790918683T2338cb9f9cba8a3dba6785b1b1b4b62c19a04d9a0386da9d0c131b5a68caa389 Clock Flow

```
Record created
     │
     ▼
Policy resolved (category + priority, or item default)
     │
     ▼
Calendar resolved (time zone, working hours, holidays)
     │
     ▼
Clock state ──▶ RUNNING ──▶ state = ON_TRACK | AT_RISK
     │                            ▲
     │ state entered that pauses  │ state exited
     ▼                            │
   PAUSED ────────────────────────┘
     │
     │ target reached while RUNNING
     ▼
  BREACHED  (timestamp recorded at detection, not inferred later)

Sweep job (single leader) periodically re-derives state and fires
at-risk / breach notifications. State is ALWAYS derived, never stored
as an editable field.
```

Detail and calendar semantics: `25-SLA-MANAGEMENT.md` (**D-8**).

## 7. Asynchronous Flow (queue)

```
Domain event in service
        │
        ▼
   build job payload (versioned, idempotency key)
        │
        ▼
      enqueue ──── (after transaction commit)
        │
        ▼
   ┌─────────────┐
   │   QUEUE     │
   └──────┬──────┘
          ▼
   worker picks up ──▶ check idempotency key already processed?
          │                        │
          │ no                     │ yes → ack, discard
          ▼
   execute side effect (email / API / report)
          │
     ┌────┴─────┐
     ▼          ▼
  success    failure
     │          │
     ▼          ▼
  mark done  attempts < max? ──▶ yes → backoff + retry
     │                         └ no  → dead-letter + alert
     ▼
  audit / delivery record
```

Job classes and rules: `03-ARCHITECTURE.md` §6.

## 8. Caching Flow (read path)

```
Read request
     │
     ▼
Is this data eligible for cache?  (see 33 for the eligibility list)
     │ no                                   │ yes
     ▼                                      ▼
  database                        cache lookup
                                            │
                            ┌──── hit ───────┴──── miss ────┐
                            ▼                               ▼
                       return cached                  database read
                                                             │
                                                             ▼
                                                    store with TTL
                                                             │
                                                             ▼
                                                          return
```

**Rule:** a cache failure is never a request failure. Cache errors are logged and
the request continues against the database. Sensitive or per-user-authorized data is
not placed in a shared cache (`33` §Cache eligibility).

## 9. Frontend Flow

```
App boot
   │
   ▼
load session (who am I?) ── unauthenticated ──▶ redirect to login (preserve target)
   │ authenticated
   ▼
load entitlements  → drive route guards and menu visibility
   │
   ▼
render shell
   │
   ▼
route resolves → page queries data (server state) + local UI state
   │
   ▼
user acts → mutation (optimistic update where safe)
   │
   ├── success → invalidate/replace affected queries, show confirmation
   └── failure → roll back optimistic state, surface field or form error
```

Client-side guards are **UX only**. The server enforces the same rule independently;
a hidden button is not a security control.

Detail: `14-FRONTEND-ARCHITECTURE.md`, `16-UI-UX-AND-ACCESSIBILITY.md`.

## 10. Audit Flow

```
Any mutation
     │
     ▼
service builds audit record: actor · action · target · before · after ·
                             timestamp · correlation id · source
     │
     ▼
written INSIDE the same transaction as the mutation
     │
     ▼
append-only storage (no update, no delete path exists in the application)
     │
     ▼
readable only through the audit read model, filtered by auditor entitlement
```

Detail: `31-AUDIT-LOGGING.md`.

## 11. Failure and Compensation Flows

| Situation | Flow |
|---|---|
| Transaction fails | Rollback; no audit record; error response; no notification enqueued |
| Commit succeeds, enqueue fails | Request succeeds; a reconciliation sweep re-enqueues from an outbox |
| Job fails permanently | Dead-letter + alert; operator can replay after fix |
| External call times out | Bounded retry (idempotent only) → circuit breaker → dead-letter |
| Partial bulk operation | Per-item result reported; successes are not rolled back silently |
| Client retries a mutation | Idempotency key on the request prevents duplicate effect |

The **transactional outbox** in row 2 is why enqueue-after-commit is safe: the event
is persisted with the mutation and drained by a worker, so a crash between commit and
enqueue cannot lose the notification.

## 12. Flow Invariants (testable)

Each of these is a test case in `37-TESTING.md`:

1. Invalid input never reaches a service.
2. An unauthorized caller can never observe another user's object.
3. A failed transaction leaves no audit record and no queued notification.
4. A successful mutation always leaves exactly one audit record.
5. A notification is never delivered for a rolled-back change.
6. Re-processing the same job twice produces one effect.
7. An illegal state transition returns `409` and changes nothing.
8. SLA elapsed time excludes paused intervals exactly once.
9. Cache unavailability does not change the response, only the latency.
10. A scheduled job runs on exactly one instance.

## 13. Platform Bootstrap, Tenant Provisioning and Onboarding Flow

> **`ADR-0012` (Accepted, 2026-10-02).** Recorded here because §1–§12 all begin with an
> *identified actor*, and the platform previously had no defined beginning. This section
> defines how the first actor and the first tenant come to exist.

This section defines how the first actor and the first tenant come to exist. It closes
the gap where `04` §1 assumes an actor already exists and `10` §8 refers to a "first
administrator" whose tenant is unspecified.

### 13.1 Bootstrap — the first platform operator

```
Deploy                         Guarded one-time command
  │                             or BOOTSTRAP_SECRET from the environment
  │  1. migrations applied on a distinct pipeline step (10 §9)
  ▼
EMPTY DATABASE
  │  2. create the FIRST PLATFORM OPERATOR (Super Admin)
  │     - refuses and exits 0 if a platform operator already exists
  │     - no hard-coded or default password; credential set at creation
  │     - audited: actor SYSTEM, action `platform.bootstrap`
  ▼
PLATFORM OPERATOR (platform scope; member of no tenant)
```

Rules: bootstrap is **guarded** and **idempotent** (`10` §8); the operator exists before
any tenant and belongs to none; the event is audited.

### 13.2 Tenant provisioning

```
PLATFORM OPERATOR
  │  create Organization (name, status, default time zone/locale)
  │     - creates the tenant-root row
  │     - SEEDS the tenant's reference data in the SAME transaction:
  │         default roles + role→permission mapping (07 §3)
  │         baseline business calendar + SLA policy skeleton (25, ADR-0008)
  │     - audited: `platform.organization.create`
  ▼
ORGANIZATION (tenant)
  │  create the first tenant ADMINISTRATOR
  │     - identity with organizationId = <org>, role = Administrator (07 §2)
  │     - credential delivered by INVITATION, never a default password
  ▼
FIRST TENANT ADMINISTRATOR
```

Provisioning is **transactional**: organization + seeded reference data commit together,
so a tenant never exists half-configured.

### 13.3 User onboarding by invitation

```
TENANT ADMINISTRATOR
  │  invite user (email + initial role + optional team)
  │     - creates Invitation: hashed single-use token, expiry, invitedBy
  │     - enqueues the invitation email via the outbox (29 §3) — never sent inline
  │     - audited: `user.invited`
  ▼
INVITED USER
  │  opens the link → sets password (policy enforced, 06 §4)
  │     - token verified: hash matches, unused, unexpired
  │     - credential created; identity becomes ACTIVE
  │     - ALL prior outstanding invitations for that identity invalidated
  │     - audited: `user.activated`
  ▼
USER SIGNS IN (06 §3) → §1 onward
```

Rules:

1. Invitation tokens are single-use, hashed at rest, and expiry-bounded.
2. Re-inviting or revoking a user invalidates any outstanding token.
3. The invitation email is transactional and cannot be opted out (`29` §7).
4. Requesting an invitation never confirms whether an account already exists.
5. An invitation grants nothing until a credential is set and the identity is active.
6. Invitation is **distinct from reset** (`06` §5): it establishes the first credential;
   reset replaces an existing one.

### 13.4 Invariants (testable)

1. Bootstrap refuses when a platform operator already exists, and exits 0.
2. No default or hard-coded credential exists in any seed, fixture, or image.
3. A tenant cannot be created without its seeded reference data (one transaction).
4. An expired, already-used, or superseded invitation token is rejected.
5. A user cannot act within a tenant until its invitation is accepted.
6. Every bootstrap, provisioning and invitation event is audited.
7. A platform operator is a member of no tenant and cannot read tenant records by
   default.

## 14. Related

- `03-ARCHITECTURE.md` — the components used by these flows
- `07-ROLES-AND-AUTHORIZATION.md` — the authorization decision
- `11-API-CONTRACT.md` — wire-level detail
- `13`, `14` — layer internals
- `31`, `33` — audit and caching detail
