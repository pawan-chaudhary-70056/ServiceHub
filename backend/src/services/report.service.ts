import { assertPermission, hasPermission, type Principal } from '../helpers/authorization';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { workingMinutesBetween, type CalendarSpec, type WorkingWindow } from '../helpers/calendar';
import { listTeamIdsForUser } from '../models';
import { readReportRegion, type ReportRegion } from './report-cache';
import {
  approvalBacklog,
  approvalDecisionSamples,
  countMajorIncidents,
  incidentPriorityCounts,
  incidentResolutionSamples,
  incidentStatusCounts,
  notificationOutcomeCounts,
  requestPriorityCounts,
  requestResolutionSamples,
  requestStatusCounts,
  slaAttainment,
  summariseMinutes,
  taskStatusCounts,
  taskWorkload,
  type ResolutionSample,
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
 * task workload/overdue (`24`), notification delivery outcomes (`29`), and the three
 * time-based metrics — mean/median time to resolve (`22`), reopen-aware MTTR (`23`) and
 * approval turnaround plus backlog (`26`). **Still tracked as not implemented:** the KB
 * and asset metrics (`27`/`28`), and materialised period aggregates refreshed by a
 * scheduled job (`§3.4`). Each remaining metric belongs to one owner document, so it is
 * added where its owner changes. Async exports and the export audit record (`R4`/`R5`) live
 * in `report-export.service.ts`.
 *
 * **Caching (`docs/30` §3.1/§3.4).** The operational-dashboard metrics are read through
 * `report-cache.ts`: a short TTL per class, invalidated when a write lands in that class.
 * The cached payload is the finished `ReportResult`, so a hit and a miss cannot disagree
 * about shape — and because the key carries the metric, the period and the caller's scope
 * (`R2`/`R3`), one caller's figures are never served to another.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

/** Metric names, so an unknown one is a clean 404 rather than an empty report. */
const METRICS = [
  'requests.summary',
  'requests.resolution',
  'incidents.summary',
  'incidents.mttr',
  'tasks.summary',
  'tasks.workload',
  'sla.attainment',
  'notifications.delivery',
  'approvals.turnaround',
] as const;
export type ReportMetric = (typeof METRICS)[number];

export interface ReportInput {
  from?: string;
  to?: string;
}

/**
 * Which cached class each metric reads (`docs/30` §3.4, "invalidated on write of that
 * class").
 *
 * `notifications.delivery` is deliberately **absent**: its writes come from the outbox
 * drain (`docs/29` §3), which runs continuously, so invalidating on them would evict the
 * entry as fast as the worker refilled it. It stays a live indexed aggregate.
 */
const REPORT_CACHE_REGION: Partial<Record<ReportMetric, ReportRegion>> = {
  'requests.summary': 'report.requests',
  'requests.resolution': 'report.requests',
  'incidents.summary': 'report.incidents',
  'incidents.mttr': 'report.incidents',
  'tasks.summary': 'report.tasks',
  'tasks.workload': 'report.tasks',
  'sla.attainment': 'report.sla',
  'approvals.turnaround': 'report.approvals',
};

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

/**
 * Rebuilds a sample's calendar spec from the stored JSON (`ADR-0008`: the calendar is a
 * per-policy attribute; the report states which ones it used rather than assuming one).
 */
function specOf(sample: ResolutionSample): CalendarSpec {
  const { calendar } = sample;
  return {
    timeZone: calendar.timeZone,
    model: calendar.model,
    workingHours: (calendar.workingHours ?? {}) as unknown as Record<string, WorkingWindow[]>,
    holidays: Array.isArray(calendar.holidays) ? calendar.holidays.map(String) : [],
  };
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

  /** Computes the figures for this period and scope. Called once on a cache miss. */
  const compute = async (): Promise<ReportResult> => {
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
      case 'requests.resolution': {
        // `docs/30` §3.3 (owner `22`): mean/median from `submittedAt` to `resolvedAt`,
        // **working time per `25`** — so each sample is measured through its own policy's
        // calendar (DST-correct, `25` §4 rule 5). Two honesty rules travel with the numbers:
        //   - the raw stored-timestamp elapsed figures ride along as the reproducibility
        //     anchor (`30` §3.2 R1): a calendar is configuration, so a later edit of one must
        //     not silently move history — the elapsed pair cannot move at all;
        //   - the calendars actually used are stated (`ADR-0008`): figures measured on
        //     different calendars are not comparable otherwise.
        const samples = await requestResolutionSamples(window);
        const working = summariseMinutes(
          samples.map((sample) =>
            workingMinutesBetween(sample.submittedAt, sample.resolvedAt, specOf(sample)),
          ),
        );
        const elapsed = summariseMinutes(
          samples.map(
            (sample) => (sample.resolvedAt.getTime() - sample.submittedAt.getTime()) / 60_000,
          ),
        );
        const calendarsUsed: Record<string, number> = {};
        for (const sample of samples) {
          const key = `${sample.calendar.timeZone} (${sample.calendar.model})`;
          calendarsUsed[key] = (calendarsUsed[key] ?? 0) + 1;
        }
        figures = {
          resolvedCount: samples.length,
          meanMinutes: working.mean,
          medianMinutes: working.median,
          meanElapsedMinutes: elapsed.mean,
          medianElapsedMinutes: elapsed.median,
          calendarsUsed,
        };
        break;
      }
      case 'incidents.mttr': {
        // `docs/30` §3.3 (owner `23`), reopen-aware: a reopen clears `resolvedAt` and the next
        // resolution rewrites it, so each incident measures to its **latest** resolution —
        // full report-to-final-resolution time — while the reopens are reported beside the
        // average. An MTTR that hides a reopen loop is the figure that gets trusted past its
        // usefulness.
        const samples = await incidentResolutionSamples(window);
        const summary = summariseMinutes(
          samples.map(
            (sample) => (sample.resolvedAt.getTime() - sample.createdAt.getTime()) / 60_000,
          ),
        );
        const reopened = samples.filter((sample) => sample.reopenCount > 0).length;
        figures = {
          resolvedCount: samples.length,
          meanMinutes: summary.mean,
          medianMinutes: summary.median,
          reopenedCount: reopened,
          reopenRatePercent:
            samples.length === 0 ? null : Math.round((reopened / samples.length) * 1000) / 10,
          majorCount: samples.filter((sample) => sample.isMajor).length,
        };
        break;
      }
      case 'approvals.turnaround': {
        // `docs/30` §3.3 (owner `26`): time from instance (the step being raised) to the
        // decision. The backlog is a snapshot at generation time, like `tasks.workload` —
        // a window over "waiting right now" would report decided steps as still open.
        const [decisions, backlog] = await Promise.all([
          approvalDecisionSamples(window),
          approvalBacklog({ ...window, now }),
        ]);
        const summary = summariseMinutes(
          decisions.map(
            (sample) => (sample.decidedAt.getTime() - sample.stepCreatedAt.getTime()) / 60_000,
          ),
        );
        figures = {
          decisionCount: decisions.length,
          meanMinutes: summary.mean,
          medianMinutes: summary.median,
          pending: backlog.pending,
          overdue: backlog.overdue,
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
  };

  /**
   * The dashboard classes are cached (`docs/30` §3.1/§3.4); a metric that is not a cached
   * class is computed live. The key carries the metric, the period and the caller's scope,
   * so a hit is always *this* caller's answer to *this* question (`R2`/`R3`).
   */
  const region = REPORT_CACHE_REGION[metric as ReportMetric];
  if (!region) {
    return compute();
  }

  const viewKey = [
    metric,
    scope,
    actor.userId,
    teamIds.join(','),
    from.toISOString(),
    to.toISOString(),
  ].join('|');

  const payload = await readReportRegion({
    region,
    organizationId,
    viewKey,
    // Serialised inside the loader, so the cached and the freshly computed payloads are
    // the same shape by construction rather than by agreement.
    load: async () => JSON.stringify(await compute()),
  });
  return JSON.parse(payload) as ReportResult;
}

export const REPORT_METRICS = METRICS;
