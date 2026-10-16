import {
  listClocksDueForBreach,
  listClocksDueForWarn,
  markClockAtRisk,
  markClockBreached,
  runInTransaction,
  writeAudit,
  writeOutboxEvent,
} from '../models';
import { logger } from '../utils/logger';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import { invalidateReportCache } from './report-cache';

/**
 * SLA breach and at-risk sweep — docs/25 §6.
 *
 * The clock's `state` is a **derived cache refreshed by this sweep**, never set from the
 * API (§5). Two properties make the sweep safe to run repeatedly:
 *
 *   - **Idempotent.** Breaching is restricted to clocks still `ON_TRACK`/`AT_RISK`, and
 *     warning to clocks still `ON_TRACK`. A clock that has been moved leaves the candidate
 *     set, so a second run in the same interval produces no duplicate event.
 *   - **`breachedAt` is recorded at detection, never inferred** (§6). Recomputing a breach
 *     later from a resolution instant would hide a sweep outage and misdate the breach.
 *
 * Exactly one runner must execute this (docs/03 §6). The scheduler takes a distributed
 * lock; the function itself is pure of leadership concerns so it can be tested directly.
 */

/** Bounds one run so a large backlog is worked down over several intervals, not one. */
const SWEEP_BATCH_SIZE = 500;

export interface SweepResult {
  breached: number;
  atRisk: number;
}

export async function runSlaSweep(now: Date = new Date()): Promise<SweepResult> {
  const breaching = await listClocksDueForBreach(now, SWEEP_BATCH_SIZE);
  for (const clock of breaching) {
    await runInTransaction(async (tx) => {
      await markClockBreached(clock.id, now, tx);
      await writeAudit(
        {
          organizationId: clock.organizationId,
          actorId: null,
          actorType: 'SYSTEM',
          action: AUDIT_ACTION.SLA_BREACH,
          entityType: AUDIT_ENTITY.SLA_CLOCK,
          entityId: clock.id,
          after: { state: 'BREACHED', targetAt: clock.targetAt, breachedAt: now },
          correlationId: `sla-sweep:${clock.id}`,
        },
        tx,
      );
      await writeOutboxEvent(
        {
          organizationId: clock.organizationId,
          eventType: OUTBOX_EVENT.SLA_BREACHED,
          idempotencyKey: `sla.breached:${clock.id}`,
          payload: {
            clockId: clock.id,
            entityType: clock.entityType,
            entityId: clock.entityId,
            priority: clock.priority,
          },
        },
        tx,
      );
    });
  }

  // A breach stamp changes the stored attainment figure (`docs/30` §3.2 R1), and it arrives
  // from this worker rather than a request, so the invalidation is explicit here (`§3.4`).
  // One bump per tenant, after the commits, rather than one per clock.
  for (const organizationId of new Set(breaching.map((clock) => clock.organizationId))) {
    await invalidateReportCache(organizationId, 'report.sla');
  }

  const warning = await listClocksDueForWarn(now, SWEEP_BATCH_SIZE);
  for (const clock of warning) {
    await runInTransaction(async (tx) => {
      await markClockAtRisk(clock.id, tx);
      await writeOutboxEvent(
        {
          organizationId: clock.organizationId,
          eventType: OUTBOX_EVENT.SLA_AT_RISK,
          idempotencyKey: `sla.at_risk:${clock.id}`,
          payload: {
            clockId: clock.id,
            entityType: clock.entityType,
            entityId: clock.entityId,
            warnAt: clock.warnAt,
          },
        },
        tx,
      );
    });
  }

  const result = { breached: breaching.length, atRisk: warning.length };
  if (result.breached > 0 || result.atRisk > 0) {
    // A stalled sweep is a silent SLA failure, so a productive run is logged (docs/25 §6).
    logger.info(result, 'SLA sweep processed clocks');
  }
  return result;
}
