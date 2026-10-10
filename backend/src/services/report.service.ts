import { assertPermission, hasPermission, type Principal } from '../helpers/authorization';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { listTeamIdsForUser } from '../models';
import {
  countMajorIncidents,
  incidentPriorityCounts,
  incidentStatusCounts,
  notificationOutcomeCounts,
  requestPriorityCounts,
  requestStatusCounts,
  slaAttainment,
  taskStatusCounts,
  taskWorkload,
  type ScopedReportWindow,
} from '../models/report.model';

/**
 * Reporting — docs/30 §3, F-14.
 *
 * Reports share the caller's scope: there is no "run as admin" path (`docs/30` §3.2 R3).
 * Every figure is recomputed from stored timestamps (`R1`), and the response carries the
 * period, time zone and scope it was run under (`R2`) — a number without its scope is not a
 * report.
 *
 * **Implemented metrics (`docs/30` §3.3):** the request, incident, task and SLA summaries,
 * task workload/overdue (`24`) and notification delivery outcomes (`29`). **Still tracked
 * as not implemented:** the time-based metrics that need a percentile over a duration
 * (mean/median time to resolve, MTTR, approval turnaround), the KB and asset metrics, and
 * materialised aggregates with a short-TTL cache (`§3.4`). Each remaining metric belongs to
 * one owner document, so it is added where its owner changes. Async exports and the export
 * audit record (`R4`/`R5`) live in `report-export.service.ts`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

/** Metric names, so an unknown one is a clean 404 rather than an empty report. */
const METRICS = [
  'requests.summary',
  'incidents.summary',
  'tasks.summary',
  'tasks.workload',
  'sla.attainment',
  'notifications.delivery',
] as const;
export type ReportMetric = (typeof METRICS)[number];

export interface ReportInput {
  from?: string;
  to?: string;
}

export interface ReportResult {
  metric: ReportMetric;
  period: { from: string; to: string; timeZone: string };
  scope: 'own' | 'team' | 'any';
  generatedAt: string;
  figures: Record<string, unknown>;
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can run reports.');
  }
  return actor.organizationId;
}

/**
 * The report scope. `report:read.all` is the cross-team grant (lead/admin, `docs/30` §4);
 * without it the caller sees their team or their own work, never the whole tenant.
 */
function resolveScope(actor: Principal): 'own' | 'team' | 'any' {
  if (hasPermission(actor, 'report:read.all')) return 'any';
  if (hasPermission(actor, 'request:read.team') || hasPermission(actor, 'incident:read.team')) {
    return 'team';
  }
  return 'own';
}

function parseWindow(input: ReportInput, now: Date): { from: Date; to: Date } {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new NotFoundError('Invalid report period.');
  }
  return { from, to };
}

function toCountMap(rows: Array<{ [key: string]: unknown; count: number }>, key: string) {
  const map: Record<string, number> = {};
  for (const row of rows) map[String(row[key])] = row.count;
  return map;
}

/** Runs one report over a period, scoped to the caller (`docs/30` §3, §5). */
export async function runReport(
  actor: Principal,
  metric: string,
  input: ReportInput,
): Promise<ReportResult> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'report:read');

  if (!(METRICS as readonly string[]).includes(metric)) {
    throw new NotFoundError('Unknown report metric.');
  }

  const now = new Date();
  const { from, to } = parseWindow(input, now);
  const scope = resolveScope(actor);
  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  const window: ScopedReportWindow = {
    organizationId,
    from,
    to,
    scope,
    userId: actor.userId,
    teamIds,
  };

  let figures: Record<string, unknown>;
  switch (metric as ReportMetric) {
    case 'requests.summary': {
      const [status, priority] = await Promise.all([
        requestStatusCounts(window),
        requestPriorityCounts(window),
      ]);
      figures = {
        byStatus: toCountMap(status, 'status'),
        byPriority: toCountMap(priority, 'priority'),
      };
      break;
    }
    case 'incidents.summary': {
      const [status, priority, major] = await Promise.all([
        incidentStatusCounts(window),
        incidentPriorityCounts(window),
        countMajorIncidents(window),
      ]);
      figures = {
        byStatus: toCountMap(status, 'status'),
        byPriority: toCountMap(priority, 'priority'),
        majorCount: major,
      };
      break;
    }
    case 'tasks.summary': {
      const status = await taskStatusCounts(window);
      figures = { byStatus: toCountMap(status, 'status') };
      break;
    }
    case 'tasks.workload': {
      // `docs/30` §3.3, owner `24`: open load, the late subset, and completions in the
      // period. The share is null rather than 0% when nothing is open, because a share of
      // an empty set is undefined and "0% late" would be a lie.
      const workload = await taskWorkload({ ...window, now });
      figures = {
        open: workload.open,
        overdue: workload.overdue,
        completedInWindow: workload.completedInWindow,
        overdueSharePercent:
          workload.open === 0 ? null : Math.round((workload.overdue / workload.open) * 1000) / 10,
        byStatus: toCountMap(workload.byStatus, 'status'),
      };
      break;
    }
    case 'notifications.delivery': {
      // `docs/30` §3.3, owner `29`. Tenant-wide: a row is one person's delivery attempt.
      if (scope !== 'any') {
        throw new ForbiddenError('Notification delivery is a cross-team report.');
      }
      const rows = await notificationOutcomeCounts({ organizationId, from, to });
      const byStatus = toCountMap(rows, 'status');
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      const delivered = (byStatus.SENT ?? 0) + (byStatus.DELIVERED ?? 0);
      const failed = byStatus.FAILED ?? 0;
      const deadLettered = byStatus.DEAD ?? 0;
      figures = {
        total,
        delivered,
        failed,
        deadLettered,
        // A skipped row is a recipient preference, not a delivery failure (`docs/29` §7),
        // so it is reported separately and never folded into the failure rate.
        skipped: byStatus.SKIPPED ?? 0,
        deliveryRatePercent: total === 0 ? null : Math.round((delivered / total) * 1000) / 10,
        failureRatePercent:
          total === 0 ? null : Math.round(((failed + deadLettered) / total) * 1000) / 10,
        byStatus,
      };
      break;
    }
    case 'sla.attainment': {
      // Tenant-wide attainment is cross-team reporting and requires the all-scope grant.
      if (scope !== 'any') {
        throw new ForbiddenError('SLA attainment is a cross-team report.');
      }
      const { total, breached, attained } = await slaAttainment({ organizationId, from, to });
      figures = {
        totalClocks: total,
        breached,
        attained,
        attainmentPercent: total === 0 ? null : Math.round((attained / total) * 1000) / 10,
      };
      break;
    }
    default:
      throw new NotFoundError('Unknown report metric.');
  }

  return {
    metric: metric as ReportMetric,
    period: { from: from.toISOString(), to: to.toISOString(), timeZone: 'UTC' },
    scope,
    generatedAt: now.toISOString(),
    figures,
  };
}

export const REPORT_METRICS = METRICS;
