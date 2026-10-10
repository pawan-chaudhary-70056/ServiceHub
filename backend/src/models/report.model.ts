import type { TaskStatus } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Report data access — docs/30 §3, F-14.
 *
 * Every figure is computed **in the database** (`docs/30` §3.4: "the database aggregates;
 * the application shapes") and over **stored timestamps** (`docs/30` §3.2 R1), so a later
 * policy or calendar edit cannot move a historical number. Scope is a predicate, so a
 * report can never widen the caller's view (`docs/30` §3.2 R3).
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
