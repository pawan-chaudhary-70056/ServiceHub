import type { TaskStatus } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Report data access — docs/30 §3, F-14.
 *
 * Every figure is computed from **stored timestamps** (`docs/30` §3.2 R1) with scope as a
 * predicate, so a report can never widen the caller's view (`R3`) and a later policy or
 * calendar edit cannot move a historical number. Counts and shares are aggregated **in the
 * database** (`docs/30` §3.4: "the database aggregates; the application shapes").
 *
 * The duration metrics (`requests.resolution`, `incidents.mttr`,
 * `approvals.turnaround`) fetch their *samples* — one row of stored timestamps each — and
 * are summarised by the caller. That is deliberate, not a shortcut: a median has no Prisma
 * aggregate, and the working-time variant has to run calendar arithmetic per row, which no
 * single SQL expression can do across rows that may declare different time zones. The rows
 * fetched are the window under the caller's scope, and large periods are exported through
 * the async path (`docs/30` R4), never a wider synchronous scan.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface ReportWindow {
  organizationId: string;
  from: Date;
  to: Date;
}

export interface ScopedReportWindow extends ReportWindow {
  scope: 'own' | 'team' | 'any';
  userId: string;
  teamIds: string[];
}

function requestScope(p: ScopedReportWindow) {
  if (p.scope === 'any') return {};
  if (p.scope === 'team') {
    return {
      OR: [{ requesterId: p.userId }, { assigneeId: p.userId }, { teamId: { in: p.teamIds } }],
    };
  }
  return { requesterId: p.userId };
}

function incidentScope(p: ScopedReportWindow) {
  if (p.scope === 'any') return {};
  if (p.scope === 'team') {
    return {
      OR: [{ reporterId: p.userId }, { assigneeId: p.userId }, { teamId: { in: p.teamIds } }],
    };
  }
  return { reporterId: p.userId };
}

export async function requestStatusCounts(params: ScopedReportWindow, client: DataClient = prisma) {
  const rows = await client.serviceRequest.groupBy({
    by: ['status'],
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      AND: [requestScope(params)],
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status as string, count: row._count._all }));
}

export async function requestPriorityCounts(
  params: ScopedReportWindow,
  client: DataClient = prisma,
) {
  const rows = await client.serviceRequest.groupBy({
    by: ['priority'],
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      AND: [requestScope(params)],
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({ priority: row.priority as string, count: row._count._all }));
}

export async function incidentStatusCounts(
  params: ScopedReportWindow,
  client: DataClient = prisma,
) {
  const rows = await client.incident.groupBy({
    by: ['status'],
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      AND: [incidentScope(params)],
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status as string, count: row._count._all }));
}

export async function incidentPriorityCounts(
  params: ScopedReportWindow,
  client: DataClient = prisma,
) {
  const rows = await client.incident.groupBy({
    by: ['priority'],
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      AND: [incidentScope(params)],
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({ priority: row.priority as string, count: row._count._all }));
}

export function countMajorIncidents(params: ScopedReportWindow, client: DataClient = prisma) {
  return client.incident.count({
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      isMajor: true,
      AND: [incidentScope(params)],
    },
  });
}

export async function taskStatusCounts(params: ScopedReportWindow, client: DataClient = prisma) {
  const rows = await client.task.groupBy({
    by: ['status'],
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
      // `any` sees the tenant; `team` and `own` both see the tasks they are assigned or
      // created, which is the task read rule (`docs/24` rule T2 inherits the parent, and a
      // direct task read here is limited to one's own work).
      AND: [
        params.scope === 'any'
          ? {}
          : { OR: [{ assigneeId: params.userId }, { createdById: params.userId }] },
      ],
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status as string, count: row._count._all }));
}

/** A task is open while it is not completed and not cancelled (`docs/24` §3). */
const OPEN_TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED'];

/**
 * Task scope for reporting. A task is visible to its assignee and to whoever raised it,
 * because a task inherits its parent's visibility through that pair (`docs/24` rule T2);
 * `any` is the tenant-wide grant.
 */
function taskScope(p: ScopedReportWindow) {
  if (p.scope === 'any') return {};
  return { OR: [{ assigneeId: p.userId }, { createdById: p.userId }] };
}

export interface TaskWorkload {
  byStatus: Array<{ status: string; count: number }>;
  open: number;
  overdue: number;
  completedInWindow: number;
}

/**
 * Open task load and the overdue subset (`docs/30` §3.3, owner `24`).
 *
 * `open` and `overdue` are snapshots taken at generation time, not figures over the
 * window: "how much work is late right now" is the question an overdue count answers, and
 * measuring it over a past window would report tasks finished since as still late. The
 * window applies to `completedInWindow`, which is a genuine period measure.
 */
export async function taskWorkload(
  params: ScopedReportWindow & { now: Date },
  client: DataClient = prisma,
): Promise<TaskWorkload> {
  const scope = taskScope(params);
  const [byStatus, overdue, completedInWindow] = await Promise.all([
    client.task.groupBy({
      by: ['status'],
      where: {
        organizationId: params.organizationId,
        status: { in: OPEN_TASK_STATUSES },
        AND: [scope],
      },
      _count: { _all: true },
    }),
    client.task.count({
      where: {
        organizationId: params.organizationId,
        status: { in: OPEN_TASK_STATUSES },
        // A null due date is not late; `lt` excludes it at the database.
        dueAt: { lt: params.now },
        AND: [scope],
      },
    }),
    client.task.count({
      where: {
        organizationId: params.organizationId,
        // `DONE` is the completed state of a task (`docs/24` §3); CANCELLED is not work done.
        status: 'DONE',
        completedAt: { gte: params.from, lt: params.to },
        AND: [scope],
      },
    }),
  ]);

  const rows = byStatus.map((row) => ({ status: row.status as string, count: row._count._all }));
  return {
    byStatus: rows,
    open: rows.reduce((sum, row) => sum + row.count, 0),
    overdue,
    completedInWindow,
  };
}

/**
 * Notification outcomes over a window (`docs/30` §3.3, owner `29`).
 *
 * Tenant-wide by construction: the row is a delivery attempt to one person, so a
 * per-recipient figure would report other people's mail metadata. The caller therefore
 * needs the cross-team grant — the same rule as SLA attainment.
 */
export async function notificationOutcomeCounts(params: ReportWindow, client: DataClient = prisma) {
  const rows = await client.notification.groupBy({
    by: ['status'],
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: params.from, lt: params.to },
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status as string, count: row._count._all }));
}

/**
 * SLA attainment over a window, computed from the stored clock state (`docs/30` §3.2 R1,
 * `docs/25` §9). Breached clocks are counted by `breachedAt`; the denominator is clocks
 * started in the window, so a clock that breached later is attributed to when it ran.
 */
export async function slaAttainment(params: ReportWindow, client: DataClient = prisma) {
  const [total, breached] = await Promise.all([
    client.slaClock.count({
      where: {
        organizationId: params.organizationId,
        startedAt: { gte: params.from, lt: params.to },
      },
    }),
    client.slaClock.count({
      where: {
        organizationId: params.organizationId,
        startedAt: { gte: params.from, lt: params.to },
        breachedAt: { not: null },
      },
    }),
  ]);
  return { total, breached, attained: total - breached };
}

// ---------------------------------------------------------------------------
// Duration metrics (docs/30 §3.3 — owners 22, 23, 26)
// ---------------------------------------------------------------------------

/**
 * Mean and median of a duration sample, in minutes, rounded to one decimal.
 *
 * Rounding is presentation, applied once, here — a figure rounded in three call sites
 * three ways is a report that disagrees with its own export.
 */
export function summariseMinutes(values: number[]): {
  mean: number | null;
  median: number | null;
} {
  if (values.length === 0) return { mean: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const round = (value: number): number => Math.round(value * 10) / 10;
  return { mean: round(mean), median: round(median) };
}

/** One resolved request's stored interval plus the calendar its policy declares. */
export interface ResolutionSample {
  submittedAt: Date;
  resolvedAt: Date;
  calendar: {
    timeZone: string;
    model: 'WORKING_HOURS' | 'WALL_CLOCK';
    workingHours: unknown;
    holidays: unknown;
  };
}

/**
 * Requests resolved in the window, with the calendar needed for the working-time measure
 * (`docs/30` §3.3: "from `submittedAt` to `resolvedAt`, working time per `25`").
 */
export async function requestResolutionSamples(
  params: ScopedReportWindow,
  client: DataClient = prisma,
): Promise<ResolutionSample[]> {
  const rows = await client.serviceRequest.findMany({
    where: {
      organizationId: params.organizationId,
      resolvedAt: { gte: params.from, lt: params.to },
      AND: [requestScope(params)],
    },
    select: {
      submittedAt: true,
      resolvedAt: true,
      slaPolicy: {
        select: {
          calendar: {
            select: { timeZone: true, model: true, workingHours: true, holidays: true },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    submittedAt: row.submittedAt,
    resolvedAt: row.resolvedAt as Date,
    calendar: row.slaPolicy.calendar,
  }));
}

/** One incident's report-to-latest-resolution interval, reopen-aware (`docs/23`). */
export interface IncidentResolutionSample {
  createdAt: Date;
  resolvedAt: Date;
  reopenCount: number;
  isMajor: boolean;
}

/**
 * Incidents resolved in the window. `resolvedAt` is nulled by a reopen and rewritten by
 * the next resolution (`incident.service`), so a reopened incident contributes its **full
 * report-to-final-resolution** time rather than its first pass — the reopen-awareness
 * `docs/30` §3.3 asks owner `23` for.
 */
export async function incidentResolutionSamples(
  params: ScopedReportWindow,
  client: DataClient = prisma,
): Promise<IncidentResolutionSample[]> {
  const rows = await client.incident.findMany({
    where: {
      organizationId: params.organizationId,
      resolvedAt: { gte: params.from, lt: params.to },
      AND: [incidentScope(params)],
    },
    select: {
      createdAt: true,
      resolvedAt: true,
      reopenCount: true,
      isMajor: true,
    },
  });
  return rows.map((row) => ({
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt as Date,
    reopenCount: row.reopenCount,
    isMajor: row.isMajor,
  }));
}

/** One decision's wait: from its step being raised to the moment it was decided. */
export interface DecisionSample {
  stepCreatedAt: Date;
  decidedAt: Date;
}

/**
 * Decisions made in the window (`docs/30` §3.3, owner `26`: "time from instance to
 * decision"). Visibility is the **request's** — an approval hangs off a request, so the
 * caller's request scope decides which decisions they may measure (`R3`).
 */
export async function approvalDecisionSamples(
  params: ScopedReportWindow,
  client: DataClient = prisma,
): Promise<DecisionSample[]> {
  const rows = await client.approvalDecision.findMany({
    where: {
      organizationId: params.organizationId,
      decidedAt: { gte: params.from, lt: params.to },
      ...(params.scope === 'any' ? {} : { workflow: { request: { ...requestScope(params) } } }),
    },
    select: { decidedAt: true, step: { select: { createdAt: true } } },
  });
  return rows.map((row) => ({ stepCreatedAt: row.step.createdAt, decidedAt: row.decidedAt }));
}

/**
 * The approval backlog: a snapshot at generation time, like `taskWorkload` — "how much is
 * waiting on a decision right now" is the question, and a window would report steps that
 * have since been decided as still open. PENDING and ACTIVE are both undecided: the first
 * is queued behind an earlier step, the second is waiting on an approver.
 */
export async function approvalBacklog(
  params: ScopedReportWindow & { now: Date },
  client: DataClient = prisma,
): Promise<{ pending: number; overdue: number }> {
  const workflowScope =
    params.scope === 'any'
      ? { organizationId: params.organizationId }
      : {
          organizationId: params.organizationId,
          request: { ...requestScope(params) },
        };
  const undecided = ['PENDING', 'ACTIVE'] as const;
  const [pending, overdue] = await Promise.all([
    client.approvalStep.count({
      where: { status: { in: [...undecided] }, workflow: workflowScope },
    }),
    client.approvalStep.count({
      where: {
        status: { in: [...undecided] },
        // A step with no deadline cannot be overdue; `lt` excludes nulls at the database.
        deadlineAt: { lt: params.now },
        workflow: workflowScope,
      },
    }),
  ]);
  return { pending, overdue };
}
