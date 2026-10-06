# 29 — Notifications and Messaging

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** Product Lead · **Approved:** 2026-10-01
**Consolidates:** old 62, 69
**Decided by:** **ADR-0006** — Knock orchestration; SendGrid (email), Twilio (SMS) (**D-6**)

> **Scope:** the delivery pipeline for email, SMS and in-app notifications. **The
> events that trigger notifications** are owned by each domain document; they are
> listed here only as the subscription map. **Outbound webhooks as an integration
> surface** are `32`.

---

## 1. Purpose

Notifications are not a feature; they are the mechanism by which work moves without a
human polling the system. Their correctness criterion is not "was an email sent" but
"did the right person learn the thing they needed, once, in time to act".

Two failure modes drive every rule below:

- **Loss** — an event fires but no notification is delivered because the process died
  between the database write and the send.
- **Duplication** — a retry, a fan-out bug, or a double-subscribed event sends the same
  notification twice, and users start ignoring all of them.

## 2. Concepts

| Concept | Definition |
|---|---|
| Event | A domain fact (`request.assigned`, `sla.breached`, `approval.requested`) |
| Notification | A delivery intent for one recipient, channel and event |
| Channel | `EMAIL`, `SMS`, `IN_APP` |
| Template | A versioned rendering of an event into a channel's content |
| Preference | A per-user, per-event channel opt-in/opt-out |
| Job | The async unit of work that performs the actual send (see `03` §6) |

## 3. Architecture

Notifications are **event-driven sinks** (`03` §4): domain modules emit events; the
notifications module consumes them. No domain module knows about email.

```
Domain mutation (transactional)
        │
        ├── writes AuditLog          (31, same transaction)
        └── writes Outbox row        (same transaction — the reliability boundary)
                    │
                    │ (after commit, an outbox publisher picks it up)
                    ▼
              Queue (Redis, `ADR-0003`)
                    │
                    ▼
        ┌───────────────────────────┐
        │ notifications worker      │
        │  1. resolve recipients    │
        │  2. apply preferences     │
        │  3. render template       │
        │  4. deliver via adapter   │
        │  5. record Notification   │
        └───────────┬───────────────┘
                    ▼
        Provider adapter: Knock → SendGrid / Twilio   (`ADR-0006`)
```

**The outbox is the load-bearing part.** Writing the outbox row in the *same
transaction* as the mutation is what makes "the record changed but no one was told"
impossible. Sending email inside the request transaction would instead make a provider
outage roll back a business change — both are wrong, and the outbox avoids both.

## 4. Delivery Rules

| # | Rule | Reason |
|---|---|---|
| N1 | Domain writes the event to the outbox in the mutation's transaction | Atomicity without blocking on the provider |
| N2 | Delivery happens in a worker, never in the request path | Latency independence |
| N3 | Every notification carries an idempotency key `(eventId, recipientId, channel)` | Prevents duplicate sends on redelivery |
| N4 | Delivery is at-least-once; the consumer must tolerate repeats | Queue guarantees |
| N5 | Preferences are applied at send time, per event and channel | Opt-out must be honoured at the last moment |
| N6 | Transactional/security notifications bypass marketing-style opt-out, and the reason is stated in the preference UI | A password reset cannot be opt-out |
| N7 | Provider failure retries with bounded exponential backoff, then dead-letters with an alert | No infinite retry storms |
| N8 | Provider webhooks (bounce, complaint, delivery) update the `Notification` record | Delivery is not "sent", it is "delivered" |
| N9 | Templates are versioned; changing a template never rewrites an already-sent message | History integrity |
| N10 | Recipient resolution is scoped by authorization after the event (`07`) | A notification is itself a data disclosure |

**N10 is the security-critical rule.** Fan-out that notifies "everyone who might care"
by resolving a role without re-checking object-level access leaks the existence and
content of records. A notification body contains enough to be a data leak on its own.

## 5. Event Subscription Map

Each event names its owning document; that document is authoritative for the trigger.
This table is the **only** place the fan-out is listed, so the two can never drift.

| Event | Owning doc | Typical recipients | Channels |
|---|---|---|---|
| `request.created` | `22` | Requester (confirmation), fulfilment team | IN_APP, EMAIL |
| `request.assigned` / `.reassigned` | `22` | Assignee | IN_APP, EMAIL |
| `request.commented` (public) | `22` | Requester, assignee | IN_APP, EMAIL |
| `request.status.changed` | `22` | Requester | IN_APP |
| `request.resolved` / `.closed` | `22` | Requester | IN_APP, EMAIL |
| `incident.created` / `.major` | `23` | On-call, affected holders, stakeholders | EMAIL, SMS (major) |
| `incident.status.changed` | `23` | Watchers | IN_APP |
| `task.assigned` / `.due.soon` | `24` | Assignee | IN_APP, EMAIL |
| `sla.at_risk` | `25` | Assignee, team lead | IN_APP, EMAIL |
| `sla.breached` | `25` | Assignee, team lead, admin | IN_APP, EMAIL, SMS (critical) |
| `approval.requested` / `.advanced` | `26` | Active step approvers | IN_APP, EMAIL |
| `approval.approved` / `.rejected` / `.expired` | `26` | Requester, fulfilment team | IN_APP, EMAIL |
| `kb.review.overdue` | `27` | KB owner | IN_APP |
| `asset.warranty.expiring` / `.assignment.stale` | `28` | Asset managers | IN_APP, EMAIL |
| `auth.login.new_device` | `06` | User | EMAIL |
| `auth.password.reset` | `06` | User | EMAIL |
| `auth.mfa.enrolled` | `06` | User | EMAIL |

## 6. Channels

| Channel | Provided by | Notes |
|---|---|---|
| `IN_APP` | Internal | Stored `Notification`; read/unread; no external provider |
| `EMAIL` | SendGrid, via Knock (`ADR-0006`) | Templated HTML + plain-text alternative; unsubscribe link only for non-transactional |
| `SMS` | Twilio, via Knock (`ADR-0006`) | Restricted to a small allow-list of critical events; cost is a design constraint |

**SMS is deliberately narrow.** SMS has per-message cost and no thread context; using
it for anything short of a major incident or a critical breach trains users to ignore
it and quietly multiplies the bill.

## 7. Preferences

| Class | Opt-out allowed | Examples |
|---|---|---|
| Transactional | No | Password reset, MFA change, approval assigned to you |
| Operational | Per-event, per-channel | Comments, status changes, assignment |
| Informational | Yes, including digest | Weekly summary, KB suggestions |

Preferences never silence a notification that is **the only warning of a security or
correctness event** (a breach, a new-device login). The UI states which classes are
mandatory and why, rather than showing a toggle that silently fails to work.

## 8. Templates

- Versioned; a send records the template version used.
- Rendered server-side; user-supplied values are escaped (`17` XSS).
- Plain-text alternative for every HTML email.
- No sensitive data in subject lines (they appear on lock screens).
- Deep links are absolute and stable; expired links degrade to the record page.
- Localisation: out of scope for v1 unless a decision is recorded.

## 9. Data

Per `08` §2: `Notification` (recipient, channel, event, template version, status,
providerMessageId, sentAt, deliveredAt, failureReason) and `NotificationPreference`.

`Notification` rows are retention-pruned per `19`; security-relevant notifications are
retained with the security retention class.

## 10. Failure Behaviour

| Failure | Behaviour |
|---|---|
| Queue unavailable | Outbox row persists; publisher retries; request already succeeded |
| Provider unavailable | Bounded retry, then dead-letter with alert; the `Notification` records the failure |
| Provider rate limit | Backoff and throttle; never exceed provider limits |
| Bounce / complaint | Recorded; hard bounces suppress future sends to that address; alert |
| Worker crash mid-send | Redelivery; idempotency key prevents a visible duplicate where the provider supports dedupe |
| Template render error | Dead-letter; never send empty or partial content |

## 11. Permissions

| Action | Permission |
|---|---|
| Manage templates | `admin:config` |
| Manage own preferences | own record |
| View notification log (support) | `notif:read.support`, audited |
| Retry a failed notification | `notif:retry` |

## 12. API

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Caller's in-app notifications; cursor-paginated |
| POST | `/notifications/{id}/read`, `/read-all` | Idempotent |
| GET/PUT | `/me/notification-preferences` | Own preferences |
| GET/POST/PATCH | `/admin/notification-templates` | Admin |
| POST | `/admin/notifications/{id}/retry` | Audited |

## 13. UI Surfaces

| Surface | Contents |
|---|---|
| Notification bell | Unread count, recent list, mark-read |
| Notification centre | Filter by type, read/unread, deep link to record |
| Preferences page | Per-channel opt-in/opt-out with mandatory classes explained |
| Template admin | Editor with preview per channel, version history |
| Delivery monitor | Failed/dead-lettered notifications with retry (support/admin) |

## 14. Edge Cases

| Case | Behaviour |
|---|---|
| Event fires but recipient was deactivated between event and send | Applied at send time: suppressed; the `Notification` is recorded as skipped with reason |
| Two events for the same change (e.g. assign + status change) | Coalesced within a short window into one notification where the template supports it; both remain audited |
| Reassignment immediately after assignment | The first assignee may already have been notified; a "corrected assignment" notice follows rather than silently swapping |
| Recipient has no email address | Email channel skipped with a recorded reason; in-app still delivered |
| Provider accepts but never delivers | Delivery webhook or a timeout marks undelivered; alert on rate spike |
| SMS to a region not permitted by policy | Blocked, logged, alert |

## 15. Acceptance Criteria

1. No notification is sent inside the request transaction; a provider outage does not
   fail a business mutation.
2. Killing the worker mid-job does not lose the notification (outbox + retry).
3. Redelivering the same event does not produce a visible duplicate.
4. A user who opts out of an operational channel receives no in-app/email for it, and
   still receives mandatory transactional notifications.
5. A notification fan-out never discloses a record to a user without read access —
   verified by test on a restricted record.
6. Every send records the template version used.
7. Hard bounces suppress future sends and are visible in the delivery monitor.

## 16. Related

- `03-ARCHITECTURE.md` — the async tier and the outbox
- `31-AUDIT-LOGGING.md` — the same transactional boundary
- `32-INTEGRATIONS.md` — outbound webhooks
- `19-DATA-PROTECTION-AND-FILES.md` — retention and PII in notification content
- `07-ROLES-AND-AUTHORIZATION.md` — recipient authorization (N10)
