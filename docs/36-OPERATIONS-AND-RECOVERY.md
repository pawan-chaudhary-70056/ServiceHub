# 36 — Operations and Recovery

**Status:** Approved · **Owner:** DevOps · **Reviewer:** DBA · **Approved:** 2026-10-01
**Consolidates:** old 87, 88 (backup/recovery, disaster recovery)
**Decided by:** `ADR-0004` (D-4 — S3 object storage), `ADR-0005` (D-5 — Kubernetes)
**Quantified by:** `ADR-0007` (D-7 — RPO ≤ 5 min, RTO ≤ 2 h)

> **Scope:** running the system day to day and bringing it back after failure —
> backup, restore, disaster recovery, and runbooks. **Deploy mechanics** are `35`.
> **Signals and alerts** are `34`. **Data classification and retention that drive
> backup policy** are `19`.

---

## 1. Purpose and the honest framing

Recovery documentation exists to answer one question under stress: *when this is down,
what exactly do we do, in what order, and how do we know it worked.* The measure of
this document is not its completeness but whether an on-call engineer who did not write
it can restore service without improvising.

The uncomfortable truth it must state plainly: **a backup that has never been restored
is not a backup.** A disaster-recovery plan that has never been rehearsed is a hope.
So the plan's core requirement is that restore is tested on a schedule, with a recorded
result, not asserted.

## 2. Backup Strategy

| Target | Method | Frequency | Retention | Notes |
|---|---|---|---|---|
| PostgreSQL | Continuous WAL archiving + periodic base backup | Continuous / daily | Per policy (`19`) | Enables point-in-time recovery |
| Object storage (uploads, `ADR-0004`) | Versioned bucket + cross-region copy | Continuous | Per policy | Matches DB retention for linked files |
| Configuration / secrets | Platform store with its own export guarded by policy | On change | — | Secrets are recoverable without being copied loosely |
| Audit log | Included in DB backup; long retention (`31`) | Continuous | 24 months minimum | Never pruned early |
| Container images | Registry with retention | Per release | Last N releases | Enables rollback without rebuild |

**Point-in-time recovery (PITR) is the primary database recovery tool.** A daily
snapshot alone loses up to a day of data; WAL archiving lets recovery target a timestamp
just before an incident, which is usually the difference between "restore" and
"reconstruct".

## 3. Recovery Objectives

| Objective | Definition | Target |
|---|---|---|
| RPO (Recovery Point Objective) | Maximum acceptable data loss | Set per data class in `02` (**D-7**) |
| RTO (Recovery Time Objective) | Maximum acceptable downtime | Set per data class in `02` (**D-7**) |

These are decisions, not defaults. Until **D-7** is closed, this document states the
*mechanisms* that can meet a range of RPO/RTO values and leaves the *numbers* to the
product decision. What is not optional: the numbers must exist, be tested against, and
be owned.

## 4. Restore Procedure

```
Incident: data loss / corruption suspected
   ↓
1. Stop writes (enable maintenance mode) so the restore is not immediately re-corrupted
   ↓
2. Identify the target recovery point (timestamp just before the incident)
   ↓
3. Restore the base backup into a NEW database (never overwrite in place first)
   ↓
4. Replay WAL to the target point
   ↓
5. Validate: row counts, key invariants, migration state, application smoke test
   ↓
6. Repoint the application (configuration change, no image rebuild)
   ↓
7. Resume; verify; record the recovery in the incident log
```

**Restore into a new database, not over the old one.** Overwriting destroys the
evidence and the fallback simultaneously; if the restore is wrong, nothing remains.

Dynamic values (counts, target timestamps, connection names) live in the runbook tool,
not hard-coded here, where they would drift.

## 5. Disaster Recovery

| Scenario | Impact | Approach |
|---|---|---|
| Single instance failure | One of N backends | LB drains it; capacity temporarily reduced; auto-recovery (`03` §8) |
| Database primary failure | All writes | Promote replica (or restore to a standby); application repoints; RPO = lag at failure |
| Availability-zone / region failure | Infra scope | Failover to the DR region using replicated backups; documented, tested, slower |
| Object storage loss | Attachments | Restore from versioned/cross-region copy |
| Cache/queue loss | Performance/delivery | Cache and queue are reconstructable; delivery retries from the outbox (`29` §3) |
| Total loss (ransomware, catastrophic) | Everything | DR region + immutable offsite backups; restore in dependency order (DB → files → app) |

**Restore order is: database → object storage → application → integrations.** The
application is useless without its data and files; bringing it up first produces an
error-spamming instance that obscures the real recovery state.

### Why immutable offsite backups

The catastrophic case is not hardware failure; it is an attacker with credentials
deleting both the primary and the accessible backups. Backups that the compromised
credential can delete are not a recovery control (`18`). At least one copy is
immutable, offsite, and reachable only by a separate credential.

## 6. Maintenance Operations

| Operation | Cadence | Notes |
|---|---|---|
| Vacuum / analyze | Continuous + scheduled | Observe bloat; do not disable autovacuum (`09`, `34`) |
| Index maintenance | As measured | Reindex `CONCURRENTLY`; drop unused indexes |
| Retention pruning | Scheduled job | Per `19`; **never audit before 24 months** (`31`) |
| Archival | Scheduled job | Move closed records to archives (`33` §13) |
| Certificate renewal | Before expiry | Alerted (`34`) |
| Dependency/security updates | Regular cadence | Via the CI pipeline (`35`); emergency path documented |
| DR rehearsal | Scheduled | Restore a backup into a scratch environment and verify |

## 7. Runbooks

A runbook exists for every page-level alert (`34` §7). Each contains: symptom, likely
cause, safe diagnostic steps, remediation, rollback, and escalation. Runbooks live with
the code so they version with the system they describe.

Core runbooks:

| Runbook | Trigger |
|---|---|
| Database connection exhaustion | Pool saturated alert |
| Slow query storm | Latency burn alert |
| Queue backlog / dead letters growth | Queue depth alert |
| SLA sweep stalled | Sweep alert (`25` §6) |
| Data corruption / suspected tampering | Integrity alert; audit chain verification (`31`) |
| Integration outage | Integration health alert (`32`) |
| Certificate expiry | Certificate alert |
| Backup failure | Backup stale alert |
| Full restore / DR activation | Disaster declaration |

## 8. Operational Access

- Production access is **least-privilege, individually attributable, and audited**
  (`17`, `31`). Shared credentials are prohibited.
- Administrative actions in production are logged with actor and reason.
- Access is granted for a task and time-boxed where the platform supports it.
- Break-glass access exists for emergencies and is alerted on whenever used.

## 9. Incident Response

```
Detect (34) → Triage → Contain → Recover → Verify → Review
```

- **Contain** before diagnosing when the impact is growing (e.g. stop writes during
  suspected corruption).
- **Verify** recovery against measurable criteria, not "it looks up".
- **Review** every significant incident with a blameless postmortem producing tracked
  actions; repeat incidents indicate a missing control, not bad luck.
- Security incidents additionally follow `18` and involve the Security Lead.

## 10. Capacity and Cost Operations

- Capacity is reviewed against the SLO burn and growth trends (`33`, `34`).
- Scaling actions follow the ordered principle in `33` §1 — measure, then optimize,
  then add capacity.
- Cost of the protection layers (cache, queue, replicas, storage) is reviewed against
  their measured benefit; an unmeasured layer is a candidate for removal.

## 11. Open Decisions

| ID | Decision | Effect |
|---|---|---|
| D-4 | File storage backend | **Closed** (`ADR-0004`, S3 object storage) — backup method for files |
| D-5 | Orchestrator | **Closed** (`ADR-0005`, Kubernetes) — failover mechanics and secret/backup tooling |
| D-7 | RPO/RTO targets and retention | The numbers this plan is validated against |

## 12. Acceptance Criteria

1. A backup restore into a scratch environment is performed and verified on the
   documented cadence, with a recorded result — proving restore works, not just that
   backups run.
2. PITR to a chosen timestamp is demonstrated.
3. At least one backup copy is immutable, offsite, and not deletable with application
   credentials.
4. Every page-level alert has a runbook with testable remediation steps.
5. RPO and RTO are stated per data class and tested against (pending **D-7**).
6. Production access is individually attributable and audited; no shared credentials.
7. A DR rehearsal demonstrates failover to the DR environment for the database.
8. The audit log is included in backups and never pruned before 24 months.
9. A break-glass access is alerted on when used.

## 13. Related

- `19-DATA-PROTECTION-AND-FILES.md` — classification and retention driving backup policy
- `31-AUDIT-LOGGING.md` — backup and tamper evidence for the audit log
- `33-SCALABILITY-AND-DATABASE-PROTECTION.md` — replica and archival mechanics
- `34-OBSERVABILITY.md` — the alerts that trigger these runbooks
- `35-DEPLOYMENT-AND-CI-CD.md` — rollback and release artifacts
