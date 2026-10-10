# 25 — SLA Management

**Status:** Approved · **Owner:** Product Lead · **Reviewer:** Backend Lead · **Approved:** 2026-10-01
**Consolidates:** old 58
**Decided by:** **ADR-0008** — per-policy calendars, default business hours (**D-8**)

> **Scope:** targets, calendars, clocks, breaches and attainment. **This document owns
> SLA semantics.** Requests and incidents reference it; they do not redefine it.

---

## 1. Why This Document Is the Product's Hardest Correctness Problem

SLA reporting is the number executives trust to judge service delivery, and it is the
number most easily wrong. Every one of these produces silently incorrect attainment:

- A clock that keeps running during `APPROVAL_PENDING` inflates attrition that the
  service team does not control.
- Working-hours arithmetic that ignores the time zone reports a breach in a region that
  was closed.
- A breach timestamp inferred later from `resolvedAt` loses the fact that the sweep was
  down.
- A policy edited mid-flight retroactively changes history.

This document fixes the semantics precisely, because "roughly right" SLA reporting is
worse than none — people make resourcing decisions on it.

## 2. Concepts

| Concept | Definition |
|---|---|
| SLA policy | A named set of targets bound to one business calendar |
| SLA target | Response and resolution minutes for one priority, plus a warn threshold |
| Business calendar | Working week, working hours, holidays, and **the time zone they are defined in** |
| SLA clock | The per-record state: start, pause totals, target instants, breach instant, derived state |
| Pause state | A record status during which the clock does not run |
| Warn threshold | The percentage of the target at which a record becomes `AT_RISK` |

## 3. Clock Lifecycle

```
record created
   │  start condition met per policy (request: creation · incident: report)
   ▼
 RUNNING ──────────────▶ state derived: ON_TRACK or AT_RISK
   │                              ▲
   │ entering a pause state       │ leaving a pause state
   ▼                              │
 PAUSED ──────────────────────────┘
   │
   │ (a) target instant passed while RUNNING  → BREACHED (timestamp recorded)
   │ (b) record reaches its stop state        → clock stops (frozen)
   ▼
 STOPPED
```

| Event | Effect |
|---|---|
| Start | `startedAt`, `targetAt`, `warnAt` computed; `state` derived |
| Pause | `pausedAt` recorded; elapsed accumulation suspended |
| Resume | `totalPausedSeconds` increased; `targetAt` and `warnAt` pushed out by the paused duration |
| Stop | `stoppedAt` recorded; used as the resolution instant for attainment |
| Breach | `breachedAt` recorded **at detection**, and `state` becomes `BREACHED` permanently for that cycle |
| Reopen (incident) | A new clock cycle begins if policy allows; the first cycle's breach is never erased |

## 4. Calendar and Elapsed-Time Semantics (resolved by `ADR-0008`, **D-8**)

**Decision (2026-10-01): per-policy choice.** Each `SlaPolicy` selects either a
**working-hours calendar** (Model A) or a **24×7 wall clock** (Model B); the **default is
Model A — working hours with pause states**. Model B would report systematic breaches
overnight for a business-hours desk, so it is opt-in per policy rather than the default.

| Model | Definition | Fits |
|---|---|---|
| **A — Working hours (default)** | Elapsed time counts only within working hours on working days, excluding holidays | Business-hours service desks |
| **B — 24×7 wall clock** | Elapsed time is the raw elapsed duration | Follow-the-sun, always-on operations |

### Rules under Model A

1. All arithmetic is performed in the **calendar's declared time zone**, not the
   server's and not the viewer's.
2. Time only advances during declared working windows; outside them it is frozen.
3. Holidays are excluded as full non-working days.
4. Paused intervals are excluded in addition to non-working time, and are never
   double-counted.
5. **Daylight saving is handled by calendar arithmetic, not by adding fixed offsets.**
   Adding 8 hours on a DST transition day produces a one-hour error twice a year, and
   those errors land in reporting.
6. Changing a calendar's time zone or hours is a **new calendar version**; in-flight
   records keep the version they started under.

### Worked examples (Model A, calendar: Mon–Fri 09:00–17:00, Europe/London)

| # | Scenario | Result |
|---|---|---|
| 1 | Target 8 working hours. Request created Fri 16:00. | Target reached Mon 16:00. The weekend contributes zero elapsed time. |
| 2 | Target 8 working hours. Created Mon 10:00, enters `APPROVAL_PENDING` Mon 12:00, resumes Wed 09:00. | 2 hours elapsed before pause; resumes Wed with 6 hours left; target reached **Wed 15:00**. Approval time is excluded, and the closed hours inside the pause are not counted a second time. |
| 3 | A public holiday falls on a working Tuesday. | Tuesday contributes zero; the target shifts one working day later. |
| 4 | DST spring-forward occurs during the window. | The working day remains 09:00–17:00 local; the actual duration is 7 hours. Calendar arithmetic handles it correctly; naive offset math would not. |
| 5 | A holiday is added retroactively for last month. | The target instants already computed are **not** recalculated; the record keeps its original `targetAt`. Retroactive calendar edits are recorded and do not rewrite history. |

Example 5 is the rule that keeps reporting reproducible: **target instants are computed
at start and frozen**, rather than recomputed on read from current calendar data.

## 5. State Derivation

```
PAUSED            if the record is in a policy pause state
BREACHED          if breachedAt is set
AT_RISK           if elapsed >= warnAt and not breached
ON_TRACK          otherwise
```

`state` is **derived**. The stored field is a cache for list rendering, refreshed by the
sweep; it is never editable through the API. Any hand-edit path is a reporting
integrity bug.

## 6. Breach Detection

```
Scheduled sweep (single leader, distributed lock — 03 §6)
   │
   ├─ select clocks where state IN (ON_TRACK, AT_RISK) and targetAt <= now
   │     └─ set breachedAt = now, state = BREACHED, emit breach event
   │
   ├─ select clocks where warnAt <= now and state = ON_TRACK
   │     └─ set state = AT_RISK, emit at-risk event
   │
   └─ emit metrics: open clocks, at-risk count, breach count
```

| Rule | Reason |
|---|---|
| Exactly one sweep runner | N instances each running the sweep produces duplicate breach events |
| `breachedAt` is recorded, never inferred | If the sweep is down, a later recomputation from `resolvedAt` would hide the outage and misdate the breach |
| Sweep is idempotent | Running twice must not produce two breach records |
| Sweep interval bounds accuracy | Worst-case detection delay = interval; stated in the policy documentation, and chosen as a small fraction of the shortest target |
| Sweep emits metrics | A stalled sweep is a silent SLA failure, so it is alerted on |

## 7. Overrides

| Override | Permission | Requirements |
|---|---|---|
| Adjust a clock's target | `sla:clock:override` | Reason, audit, alert |
| Pause manually | `sla:clock:override` | Reason, audit |
| Clear a breach | `sla:clock:override` | Reason, audit, alert — **never silent** |

Clearing a breach does not delete `breachedAt`; it records a superseding override so
both the breach and its removal are visible. A breach that can be deleted is a breach
that will be deleted.

## 8. Policy Resolution

```
record created
   │
   ├─ request:  catalog item's defaultSlaPolicyId  (frozen at creation)
   ├─ incident: active policy for the derived priority
   └─ fallback: the organisation default policy
   │
   ▼
policy → calendar (versioned) → target for the record's priority
```

A record with no resolvable policy is a configuration defect and is alerted on, not
silently given no SLA.

## 9. Reporting

| Metric | Definition |
|---|---|
| Attainment | Records stopped within target ÷ records stopped, per policy, priority, team, period |
| Breach rate | Records breached ÷ records with a clock |
| Mean time to resolve | Mean elapsed (working) time from start to stop |
| At-risk exposure | Open records currently `AT_RISK`, as a leading indicator |
| Override rate | Overrides as a share of clocks — a rising rate means the policies are wrong |

**Reproducibility requirement:** every metric must be recomputable from stored
timestamps (`startedAt`, `totalPausedSeconds`, `targetAt`, `breachedAt`, `stoppedAt`).
A metric that depends on current policy or calendar data is not acceptable — it would
change retroactively when configuration changes.

## 10. Permissions

| Action | Permission |
|---|---|
| Manage policies, targets, calendars | `sla:policy:manage` (administrator) |
| View SLA state | Any user entitled to the record |
| Override a clock | `sla:clock:override` (leads, admins) |

## 11. API

| Method | Path | Notes |
|---|---|---|
| GET/POST/PATCH | `/sla/policies`, `/sla/policies/{id}` | Admin |
| GET/POST/PATCH | `/sla/calendars`, `/sla/calendars/{id}` | Admin; edits create a new version |
| GET | `/sla/clocks/{id}` | Scoped to the record |
| POST | `/sla/clocks/{id}/override` | Reason required |
| GET | `/reports/sla-attainment` | Scoped; async above threshold (`30`) |

## 12. UI Surfaces

| Surface | Contents |
|---|---|
| SLA indicator | In every list and detail header: state plus **time remaining** — a state without a number is not actionable |
| SLA panel on detail | Target, warn, elapsed, paused total, breach time if any |
| Policy admin | Policy list, target matrix by priority, calendar editor with holiday management |
| Attainment report | Filters by policy, priority, team, period; export |

## 13. Edge Cases

| Case | Behaviour |
|---|---|
| Record paused at the moment the target passes | No breach — the clock is not running |
| Breach and resolve in the same sweep interval | Breach recorded; attainment counts it as breached |
| Calendar edited mid-cycle | In-flight records keep `targetAt`; new records use the new version |
| Time zone changes for a region | New calendar version; historical records unaffected |
| Policy retired while in use | In-flight records keep their frozen policy reference |
| Clock sweep down for an hour | Detection delayed; `breachedAt` reflects detection time and the delay is visible in metrics |
| Record reopened after closure | New cycle; first cycle's breach preserved |
| Two policies match an incident | Deterministic resolution order documented and tested; no ambiguity |

## 14. Acceptance Criteria

1. Worked examples 1–5 in §4 produce exactly the stated target instants, verified by
   unit tests with an injected clock.
2. Paused intervals are excluded exactly once — never double-counted with non-working
   time.
3. Elapsed time is correct across a DST boundary.
4. Editing a policy or calendar does not change any existing record's `targetAt`.
5. The sweep runs on exactly one instance when multiple backends are running.
6. `breachedAt` is set at detection and is never recomputed from `resolvedAt`.
7. Every attainment figure is reproducible from stored timestamps alone.
8. Every override, including breach clearing, appears in the audit trail.

## 15. Related

- `22-SERVICE-REQUESTS.md` · `23-INCIDENT-MANAGEMENT.md` — records that carry clocks
- `26-APPROVAL-MANAGEMENT.md` — the state that most often pauses a clock
- `30-SEARCH-AND-REPORTING.md` — attainment reporting
- `33-SCALABILITY-AND-DATABASE-PROTECTION.md` — sweep leadership and the clock index
