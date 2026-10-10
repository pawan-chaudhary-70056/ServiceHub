# 32 — Integrations

**Status:** Approved · **Owner:** Backend Lead · **Reviewer:** Security Lead · **Approved:** 2026-10-08
**Consolidates:** old 68

> **Scope:** how ServiceHub talks to external systems and how external systems talk to
> it, safely and without coupling the core domain to any vendor. **Notification
> providers** are `29`; **where integration credentials live** is `17`/`35`.

---

## 1. Purpose and the governing principle

Integrations are the least reliable part of any system: the remote side is slower than
you, changes without asking, and fails in ways you did not anticipate. The governing
principle is that **an integration failure must never corrupt the core domain or the
request path**.

This produces three non-negotiable rules:

1. External calls never happen inside a request transaction.
2. External systems never write to domain tables directly.
3. Vendor types never appear in domain services — only in adapters.

## 2. Integration Patterns

| Pattern | Direction | Mechanism | Example |
|---|---|---|---|
| Outbound API call | → external | Adapter, timeout, retry, circuit breaker | Directory lookup, ticketing sync |
| Outbound webhook | → external | Event-driven, signed, retried | Notify a downstream system of a status change |
| Inbound webhook | ← external | Signed, idempotent, replay-protected | Provider delivery receipts (`29`) |
| Inbound sync (pull) | ← external | Scheduled job, reconcile by external id | HR user roster |
| File exchange | ↔ external | Object storage + job | Bulk import/export |

## 3. The Adapter Boundary

Every integration is implemented as an **adapter** in `src/integrations/`, behind a
domain-owned interface.

```
domain service ──▶ integration interface (domain-defined)
                          ▲
             ┌────────────┴────────────┐
             │        adapter          │
             └────────────┬────────────┘
                          ▼
                  vendor SDK / HTTP
```

| Rule | Reason |
|---|---|
| The interface is defined by the domain, not by the vendor | The domain must not depend on a vendor's shape |
| The adapter maps vendor errors to domain errors | Services reason about "unavailable", not HTTP 502 |
| The adapter owns retries/timeouts; the service does not | Retry policy lives with protocol knowledge |
| No vendor type escapes the adapter | Removing a vendor touches one file |
| Adapters are replaceable and testable with a fake | Tests do not call the network (`37`) |

**Why this matters concretely:** without the boundary, a provider change ripples through
services, tests, and jobs. With it, the blast radius is one adapter and its fake.

## 4. Outbound Webhooks

| Concern | Rule |
|---|---|
| Subscription | Per-event, per-endpoint, with a secret (`WebhookSubscription`, `08` §2) |
| Signing | HMAC over the raw body with a per-subscription secret and a timestamp; receivers verify both |
| Delivery | Async via the queue (`03` §6); never in the request path |
| Idempotency | Each delivery carries an event id; receivers dedupe on it |
| Retry | Bounded exponential backoff with jitter; then dead-letter with alert |
| Ordering | **Not guaranteed**; payloads carry a sequence/version so receivers can order |
| Replay protection | Timestamp window + signature; stale events rejected |
| Payload | Minimal: ids, action, timestamp — **not** the full record, which may contain data the receiver should not hold |
| Secret rotation | Supported with an overlap window so receivers can roll over without downtime |

**Webhooks are an exfiltration surface.** Sending the full record to a subscriber
copies data outside the system's classification controls (`19`). Payloads carry
identifiers and a summary; a receiver that needs detail calls the API under its own
credentials and authorization.

## 5. Inbound Webhooks

| Concern | Rule |
|---|---|
| Authentication | Signature verification is mandatory; unsigned inbound is rejected |
| Idempotency | Provider event id stored; duplicate delivery is a no-op |
| Replay protection | Timestamp window enforced |
| Processing | Verify → persist raw event → ack → process in a worker; never process synchronously before acking |
| Failure | Unprocessable events dead-letter with the raw payload retained briefly for diagnosis |
| Trust | **Inbound payloads are untrusted input** — validated with Zod exactly like user input (`12`) |

Acknowledging before processing is deliberate: a slow handler must not cause the
provider to retry and amplify load, and the raw event is persisted so nothing is lost.

## 6. Inbound Sync (Roster and Similar)

| Concern | Rule |
|---|---|
| Identity mapping | External id ↔ internal id mapping table; never key on mutable attributes like email |
| Reconciliation | Scheduled, single-leader (`03` §6); idempotent |
| Deletions | A user missing from the source is **deactivated, never deleted** (`06`) |
| Conflict | Source of truth is declared per attribute; the integration does not overwrite fields it does not own |
| Volume | Batched, rate-limited, resumable from a checkpoint |
| Drift alert | Count and identity mismatches above a threshold alert rather than silently correct |

Deactivation-not-deletion matters: an external directory outage that returns an empty
roster must not delete the user base. A guard rejects a sync that would remove more
than a configured fraction of users without explicit confirmation.

## 7. Credentials and Configuration

- Integration credentials are secrets, handled per `17`: runtime-injected, never in
  the image or repository (`35`).
- Each integration has its own credential; no shared global token.
- Credential changes are audited (`31`).
- Outbound calls use the **least-privileged** credential the remote side offers.
- TLS verification is never disabled; a self-signed exception is an explicit,
  documented, audited configuration, not a code-level `rejectUnauthorized: false`.

## 8. Reliability Patterns

| Pattern | Application |
|---|---|
| Timeout | Every external call has an explicit timeout; no default "wait forever" |
| Retry | Bounded, exponential, jittered, idempotent operations only |
| Circuit breaker | Open after a failure threshold; fail fast while the remote is down |
| Bulkhead | One integration's failure must not exhaust the shared connection pool of others |
| Dead letter | Poison messages retained and alerted, never dropped silently |
| Backpressure | Inbound volume throttled to protect the domain |

## 9. Failure Behaviour

| Failure | Effect on the core system |
|---|---|
| Directory integration down | Login via existing local credentials still works; sync pauses; alert |
| Outbound webhook subscriber down | Deliveries retry and dead-letter; the domain mutation is unaffected |
| Inbound provider retries storm | Idempotency absorbs duplicates; rate limiting protects the app |
| Malformed inbound payload | Rejected by validation, recorded, alert; no partial write |
| Credential expired | The integration disables itself with an alert; the rest of the system is unaffected |

**The invariant:** no single integration failure takes down authentication, request
handling, or the database.

## 10. Data Protection

- Data sent to an external system is limited to what the integration needs
  (minimisation, `19`).
- The classification of data leaving the system is recorded per integration.
- Integrations that receive PII have their retention recorded and their logs redacted.
- Cross-border transfer is a policy decision recorded with the integration, not a
  default.

## 11. Permissions and Governance

| Action | Permission |
|---|---|
| Configure integrations | `admin:config` (audited) |
| Manage webhook subscriptions | `integration:manage` (audited) |
| View integration status/health | `integration:read` |
| Retry a dead-lettered integration job | `integration:retry` (audited) |

## 12. API

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/integrations` | Status, last success, last error |
| POST/PATCH | `/admin/integrations/{id}` | Configure; audited |
| GET/POST/PATCH | `/admin/webhooks` | Subscription management |
| GET/POST/PATCH | `/admin/inbound-endpoints` | Inbound receiver management; the verification secret is returned once, on create |
| POST | `/webhooks/inbound/{provider}` | Public, signature-verified, idempotent; **verify → persist → ack**, processed by a worker |
| GET | `/admin/integrations/{id}/dead-letters` | Failed payloads |
| GET | `/admin/integrations/inbound-dead-letters` | Failed inbound events |
| POST | `/admin/integrations/dead-letters/{id}/retry` | Audited |
| POST | `/admin/integrations/inbound-dead-letters/{id}/retry` | Audited |

## 13. UI Surfaces

| Surface | Contents |
|---|---|
| Integration admin | Configure, enable/disable, test connection, rotate credentials |
| Health board | Last success/failure per integration, error rate |
| Webhook admin | Subscriptions, event selection, secret rotation, recent deliveries |
| Dead-letter viewer | Failed payloads with retry/replay |

## 14. Edge Cases

| Case | Behaviour |
|---|---|
| Integration enabled but unreachable at boot | Application boots; the integration reports unhealthy; the rest works |
| Webhook secret rotated mid-flight | Overlap window accepts both old and new signatures during rollover |
| Two inbound events with the same id | Second is a no-op; both are recorded |
| Sync would deactivate most users | Guarded; requires explicit confirmation and alerts |
| External id changed for a known user | Mapping is by external id; a changed id creates a new mapping, flagged for review |
| Provider deprecates an endpoint | Adapter is the only change; a versioned adapter can run alongside during migration |

## 15. Acceptance Criteria

1. No external call occurs inside a request transaction; a slow integration does not
   extend request latency.
2. Inbound webhooks reject unsigned, stale, or duplicate events.
3. A vendor SDK change touches only its adapter — verified by dependency lint.
4. A dead-letters-visible failure path exists for every integration, with retry.
5. Integration credentials never appear in logs, audit payloads, or error messages.
6. No integration failure prevents authentication or request handling.
7. Every integration credential or configuration change is audited.

## 16. Related

- `03-ARCHITECTURE.md` — adapters in the layer model, async tier
- `29-NOTIFICATIONS-AND-MESSAGING.md` — provider delivery and receipts
- `18-THREAT-MODEL.md` — the trust boundary for inbound data
- `17-SECURITY-ARCHITECTURE.md` · `35-DEPLOYMENT-AND-CI-CD.md` — secrets
