import { randomUUID } from 'node:crypto';
import type {
  CommentVisibility,
  IncidentImpact,
  IncidentStatus,
  IncidentUrgency,
  Priority,
} from '@prisma/client';
import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  INCIDENT_READ_PERMISSIONS,
  type Principal,
} from '../helpers/authorization';
import { config } from '../config';
import {
  ConflictError,
  ForbiddenError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  countOpenTasksForParent,
  createComment,
  createIncident,
  findCommentById,
  findDefaultSlaPolicy,
  findIncidentById,
  findSlaPolicyById,
  findTeamById,
  findUserById,
  listAuditForEntity,
  listComments,
  listIncidents,
  listTeamIdsForUser,
  reserveReferenceValue,
  runInTransaction,
  updateIncident,
  writeAudit,
  writeOutboxEvent,
  type CommentWithAuthor,
  type IncidentScope,
  type IncidentWithRelations,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import type { RequestMeta } from './context';
import { invalidateReportCache } from './report-cache';
import {
  clockViewFor,
  clockViewsFor,
  startClock,
  stopClock,
  type SlaClockView,
} from './sla-clock.service';

/**
 * Incidents — docs/23, F-06.
 *
 * An incident is *something that is broken*, as opposed to a request, which is *something
 * someone wants* (`docs/08` §3). The two share a shape but diverge in the ways that
 * matter, and this service is where the divergence lives:
 *
 *   - **Priority is derived, never chosen** (§3). The impact × urgency matrix is
 *     authoritative; a client cannot set priority at creation. It may be overridden only
 *     through a separate permissioned, reasoned, audited action (rule I1).
 *   - **The lifecycle is closed** (§4): NEW → IN_PROGRESS → RESOLVED → CLOSED, with reopen
 *     from RESOLVED/CLOSED. There is no approval path (rule I5) and no deletion (rule I8).
 *   - **The clock starts at report and stops at RESOLVED** (§7); a reopen starts a new
 *     cycle so attainment is measured per cycle.
 */

const ENTITY_TYPE = 'Incident';

/** Read scope for the caller: `any` > `team` > `own` (`docs/23` §9). */
function resolveScope(actor: Principal): IncidentScope {
  if (hasPermission(actor, 'incident:read.any')) return 'any';
  if (hasPermission(actor, 'incident:read.team')) return 'team';
  return 'own';
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can work with incidents.');
  }
  return actor.organizationId;
}

/** Only agents and leads may update an incident (`docs/23` §9). */
function mayUpdate(actor: Principal): boolean {
  return hasPermission(actor, 'incident:update.any');
}

function mayReadObject(
  actor: Principal,
  incident: IncidentWithRelations,
  teamIds: string[],
): boolean {
  const scope = resolveScope(actor);
  if (scope === 'any') return true;
  if (incident.reporterId === actor.userId) return true;
  if (scope === 'team') {
    return (
      incident.assigneeId === actor.userId ||
      (incident.teamId !== null && teamIds.includes(incident.teamId))
    );
  }
  return false;
}

// ===========================================================================
// Priority derivation (docs/23 §3) — the authoritative matrix
// ===========================================================================

const IMPACT_RANK: Record<IncidentImpact, number> = {
  EXTENSIVE: 2,
  SIGNIFICANT: 1,
  MINOR: 0,
};

const URGENCY_RANK: Record<IncidentUrgency, number> = {
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
};

/**
 * Derives priority from impact × urgency exactly as the matrix in docs/23 §3 specifies.
 *
 * The implementation encodes the matrix as a lookup rather than arithmetic, because the
 * matrix is the requirement: if a cell ever changes, changing the table is a one-line
 * edit that no reader has to reverse-engineer.
 */
export function derivePriority(impact: IncidentImpact, urgency: IncidentUrgency): Priority {
  const impactRank = IMPACT_RANK[impact];
  const urgencyRank = URGENCY_RANK[urgency];

  // CRITICAL is the single Extensive×High cell; everything else follows the bands below.
  if (impactRank === 2 && urgencyRank === 2) return 'CRITICAL';
  if (impactRank === 2 && urgencyRank === 1) return 'HIGH';
  if (impactRank === 2 && urgencyRank === 0) return 'MEDIUM';
  if (impactRank === 1 && urgencyRank === 2) return 'HIGH';
  if (impactRank === 1 && urgencyRank === 1) return 'MEDIUM';
  if (impactRank === 1 && urgencyRank === 0) return 'LOW';
  if (impactRank === 0 && urgencyRank === 2) return 'MEDIUM';
  return 'LOW';
}

// ===========================================================================
// Views
// ===========================================================================

export interface IncidentView {
  id: string;
  reference: string;
  title: string;
  description: string;
  impact: IncidentImpact;
  urgency: IncidentUrgency;
  priority: Priority;
  isMajor: boolean;
  status: IncidentStatus;
  reporter: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  slaPolicy: { id: string; name: string };
  /** The live clock, or null when the incident has none (`docs/25` §12). */
  sla: SlaClockView | null;
  resolutionSummary: string | null;
  reopenCount: number;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IncidentSummary {
  id: string;
  reference: string;
  title: string;
  priority: Priority;
  status: IncidentStatus;
  isMajor: boolean;
  reporterName: string;
  assigneeName: string | null;
  teamName: string | null;
  slaPolicyName: string;
  /** SLA state and time remaining, so the list can surface criticals (`docs/25` §12). */
  sla: SlaClockView | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Projects an incident for a response, attaching the live clock.
 *
 * Async for the same reason as a request's projection: every path that returns an incident
 * — report, read, assign, resolve, close, reopen, major on/off — must carry the current SLA
 * state, or a mutation would leave the countdown on screen disagreeing with the record.
 */
async function toView(incident: IncidentWithRelations): Promise<IncidentView> {
  const sla = await clockViewFor(incident.organizationId, ENTITY_TYPE, incident.id);
  return {
    id: incident.id,
    reference: incident.reference,
    title: incident.title,
    description: incident.description,
    impact: incident.impact,
    urgency: incident.urgency,
    priority: incident.priority,
    isMajor: incident.isMajor,
    status: incident.status,
    reporter: { id: incident.reporter.id, displayName: incident.reporter.displayName },
    assignee: incident.assignee
      ? { id: incident.assignee.id, displayName: incident.assignee.displayName }
      : null,
    team: incident.team ? { id: incident.team.id, name: incident.team.name } : null,
    slaPolicy: { id: incident.slaPolicy.id, name: incident.slaPolicy.name },
    sla,
    resolutionSummary: incident.resolutionSummary,
    reopenCount: incident.reopenCount,
    resolvedAt: incident.resolvedAt,
    closedAt: incident.closedAt,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
  };
}

function toSummary(incident: IncidentWithRelations, sla: SlaClockView | null): IncidentSummary {
  return {
    id: incident.id,
    reference: incident.reference,
    title: incident.title,
    priority: incident.priority,
    status: incident.status,
    isMajor: incident.isMajor,
    reporterName: incident.reporter.displayName,
    assigneeName: incident.assignee?.displayName ?? null,
    teamName: incident.team?.name ?? null,
    slaPolicyName: incident.slaPolicy.name,
    sla,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
  };
}

// ===========================================================================
// Creation
// ===========================================================================

export interface CreateIncidentInput {
  title: string;
  description: string;
  impact: IncidentImpact;
  urgency: IncidentUrgency;
  teamId?: string | null;
}

export async function createIncidentFromReport(
  input: CreateIncidentInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  assertPermission(actor, 'incident:create');
  const organizationId = requireTenant(actor);

  const teamId: string | null = input.teamId ?? null;
  if (teamId) {
    const team = await findTeamById(teamId);
    if (!team || team.organizationId !== organizationId) {
      throw new NotFoundError('Team not found.');
    }
  }

  const slaPolicy = await findDefaultSlaPolicy(organizationId);
  if (!slaPolicy) {
    throw new ConflictError('No active SLA policy is configured for incidents.');
  }

  const priority = derivePriority(input.impact, input.urgency);
  const now = new Date();
  const year = now.getUTCFullYear();

  const created = await runInTransaction(async (tx) => {
    const sequence = await reserveReferenceValue(organizationId, 'INC', String(year), tx);
    const reference = `INC-${year}-${String(sequence).padStart(6, '0')}`;

    const incident = await createIncident(
      {
        organizationId,
        reference,
        title: input.title,
        description: input.description,
        impact: input.impact,
        urgency: input.urgency,
        priority,
        isMajor: false,
        reporterId: actor.userId,
        teamId,
        slaPolicyId: slaPolicy.id,
      },
      tx,
    );

    await startClock(
      {
        organizationId,
        entityType: ENTITY_TYPE,
        entityId: incident.id,
        slaPolicy,
        priority,
        startAt: now,
      },
      tx,
    );

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.INCIDENT_CREATE,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        after: {
          reference,
          status: incident.status,
          priority,
          impact: input.impact,
          urgency: input.urgency,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    await writeOutboxEvent(
      {
        organizationId,
        eventType: OUTBOX_EVENT.INCIDENT_REPORTED,
        idempotencyKey: `incident.reported:${incident.id}`,
        payload: { incidentId: incident.id, reference, priority, isMajor: false },
      },
      tx,
    );

    return incident;
  });

  // After the commit (`docs/30` §3.4): a new incident moves the incident figures and
  // starts its SLA clock.
  await invalidateReportCache(organizationId, 'report.incidents', 'report.sla');

  return toView((await findIncidentById(created.id)) as IncidentWithRelations);
}

// ===========================================================================
// Reads
// ===========================================================================

async function loadReadable(id: string, actor: Principal): Promise<IncidentWithRelations> {
  const organizationId = requireTenant(actor);
  assertAnyPermission(actor, INCIDENT_READ_PERMISSIONS);
  const incident = await findIncidentById(id);
  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  if (
    !incident ||
    incident.organizationId !== organizationId ||
    !mayReadObject(actor, incident, teamIds)
  ) {
    throw new NotFoundError('Incident not found.');
  }
  return incident;
}

export async function listIncidentsPage(
  input: { limit: number; cursor?: string; status?: IncidentStatus; majorOnly?: boolean },
  actor: Principal,
): Promise<CursorPage<IncidentSummary>> {
  const organizationId = requireTenant(actor);
  assertAnyPermission(actor, INCIDENT_READ_PERMISSIONS);

  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  const rows = await listIncidents({
    organizationId,
    scope: resolveScope(actor),
    userId: actor.userId,
    teamIds,
    status: input.status,
    majorOnly: input.majorOnly,
    limit: input.limit,
    cursor: input.cursor,
  });

  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
  const clocks = await clockViewsFor(
    organizationId,
    ENTITY_TYPE,
    page.items.map((row) => row.id),
  );
  return {
    ...page,
    items: page.items.map((row) => toSummary(row, clocks.get(row.id) ?? null)),
  };
}

export function getIncident(id: string, actor: Principal): Promise<IncidentView> {
  return loadReadable(id, actor).then(toView);
}

// ===========================================================================
// Update (fields + priority override)
// ===========================================================================

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  impact?: IncidentImpact;
  urgency?: IncidentUrgency;
  priority?: Priority;
  reason?: string;
}

/**
 * Applies field edits (`docs/23` §10 PATCH).
 *
 * Two rules meet here:
 *   - changing impact or urgency **re-derives** priority (§12), because priority is a
 *     consequence of those inputs, not an independent fact;
 *   - setting priority explicitly is an **override** and requires the distinct
 *     `incident:priority:override` permission plus a reason (rule I1, §9).
 *
 * Both are audited with before/after so the derivation and any deviation from it are
 * always reconstructable.
 */
export async function updateIncidentFields(
  id: string,
  input: UpdateIncidentInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  const incident = await loadReadable(id, actor);
  if (!mayUpdate(actor)) {
    throw new ForbiddenError();
  }

  const data: Parameters<typeof updateIncident>[1] = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;

  const impact = input.impact ?? incident.impact;
  const urgency = input.urgency ?? incident.urgency;
  const derived = derivePriority(impact, urgency);

  if (input.impact !== undefined) data.impact = input.impact;
  if (input.urgency !== undefined) data.urgency = input.urgency;

  const isOverride = input.priority !== undefined && input.priority !== derived;
  if (isOverride) {
    assertPermission(actor, 'incident:priority:override');
    if (!input.reason) {
      throw new ValidationError([
        {
          field: 'reason',
          code: 'REQUIRED',
          message: 'A reason is required to override priority.',
        },
      ]);
    }
    data.priority = input.priority;
  } else if (input.impact !== undefined || input.urgency !== undefined) {
    data.priority = derived;
  }

  if (Object.keys(data).length === 0) {
    return toView(incident);
  }

  await runInTransaction(async (tx) => {
    await updateIncident(incident.id, data, tx);
    await writeAudit(
      {
        organizationId: incident.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: isOverride ? AUDIT_ACTION.INCIDENT_PRIORITY_OVERRIDE : AUDIT_ACTION.INCIDENT_UPDATE,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        before: { priority: incident.priority, impact: incident.impact, urgency: incident.urgency },
        after: {
          priority: data.priority ?? incident.priority,
          impact: data.impact ?? incident.impact,
          urgency: data.urgency ?? incident.urgency,
        },
        ...(input.reason ? { reason: input.reason } : {}),
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    if (isOverride) {
      // An override raises a monitoring signal so a pattern is visible (`docs/23` §3).
      await writeOutboxEvent(
        {
          organizationId: incident.organizationId,
          eventType: OUTBOX_EVENT.INCIDENT_PRIORITY_OVERRIDDEN,
          idempotencyKey: `incident.priority.override:${incident.id}:${randomUUID()}`,
          payload: { incidentId: incident.id, from: derived, to: input.priority },
        },
        tx,
      );
    }
  });

  // A priority/impact/urgency edit moves the incident counts and the major-flag figure.
  await invalidateReportCache(incident.organizationId, 'report.incidents');

  return toView((await findIncidentById(incident.id)) as IncidentWithRelations);
}

// ===========================================================================
// Assignment — triage/assign, which moves NEW → IN_PROGRESS
// ===========================================================================

/**
 * Assigns an incident and, when it is still NEW, starts work on it (`docs/23` §4:
 * "triage / assign" is the NEW → IN_PROGRESS edge, guarded by "Assignee set").
 *
 * Folding assignment and the start into one action keeps rule I2 unbreakable: an incident
 * never reaches IN_PROGRESS without an assignee, because that is the same transaction
 * that sets the assignee.
 */
export async function assignIncident(
  id: string,
  input: { assigneeId?: string | null; teamId?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  const incident = await loadReadable(id, actor);
  if (!mayUpdate(actor)) {
    throw new ForbiddenError();
  }
  if (incident.status === 'CLOSED') {
    throw new IllegalTransitionError('A closed incident cannot be reassigned.');
  }

  const organizationId = incident.organizationId;
  const data: Parameters<typeof updateIncident>[1] = {};
  let assigneeName: string | null = null;

  if (input.assigneeId !== undefined) {
    if (input.assigneeId === null) {
      data.assigneeId = null;
    } else {
      const assignee = await findUserById(input.assigneeId);
      if (!assignee || assignee.organizationId !== organizationId || assignee.status !== 'ACTIVE') {
        throw new NotFoundError('Assignee not found.');
      }
      data.assigneeId = assignee.id;
      assigneeName = assignee.displayName;
    }
  }

  if (input.teamId !== undefined) {
    if (input.teamId === null) {
      data.teamId = null;
    } else {
      const team = await findTeamById(input.teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new NotFoundError('Team not found.');
      }
      data.teamId = team.id;
    }
  }

  const nextAssigneeId = data.assigneeId ?? incident.assigneeId;
  const starting = incident.status === 'NEW' && nextAssigneeId !== null;
  if (starting) {
    data.status = 'IN_PROGRESS';
  }

  await runInTransaction(async (tx) => {
    await updateIncident(incident.id, data, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.INCIDENT_ASSIGN,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        before: {
          assigneeId: incident.assigneeId,
          teamId: incident.teamId,
          status: incident.status,
        },
        after: {
          assigneeId: nextAssigneeId,
          teamId: data.teamId ?? incident.teamId,
          status: data.status ?? incident.status,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    if (data.assigneeId) {
      await writeOutboxEvent(
        {
          organizationId,
          eventType: OUTBOX_EVENT.INCIDENT_ASSIGNED,
          idempotencyKey: `incident.assigned:${incident.id}:${data.assigneeId}:${randomUUID()}`,
          payload: { incidentId: incident.id, assigneeId: data.assigneeId, assigneeName },
        },
        tx,
      );
    }
  });

  // The assignee is a scope predicate in the incident reports (`docs/30` R3), and triage
  // moves the status to IN_PROGRESS, so the incident figures move either way.
  await invalidateReportCache(organizationId, 'report.incidents');

  return toView((await findIncidentById(incident.id)) as IncidentWithRelations);
}

// ===========================================================================
// Resolution / closure / reopen
// ===========================================================================

const TERMINAL_STATUSES: IncidentStatus[] = ['CLOSED'];

/**
 * Resolves an incident (`docs/23` §4, IN_PROGRESS → RESOLVED). The resolution summary is
 * mandatory — enforced here for a clear 422 and by a CHECK constraint for the record's
 * integrity — and stopping the clock is what makes SLA attainment measurable (§7).
 */
export async function resolveIncident(
  id: string,
  input: { resolutionSummary: string; reason?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  const incident = await loadReadable(id, actor);
  if (!mayUpdate(actor)) {
    throw new ForbiddenError();
  }
  if (incident.status === 'RESOLVED') {
    throw new IllegalTransitionError('The incident is already resolved.');
  }
  if (incident.status === 'CLOSED') {
    throw new IllegalTransitionError('A closed incident cannot be resolved; reopen it first.');
  }
  if (incident.status === 'NEW') {
    throw new IllegalTransitionError('Assign the incident before resolving it.');
  }

  const summary = input.resolutionSummary.trim();
  if (summary.length === 0) {
    throw new ValidationError([
      {
        field: 'resolutionSummary',
        code: 'REQUIRED',
        message: 'A resolution summary is required.',
      },
    ]);
  }

  // Roll-up (`docs/24` §4): an incident may not be resolved over open child tasks
  // without the override permission and a recorded reason.
  let overrodeOpenChildren = 0;
  const openChildren = await countOpenTasksForParent('INCIDENT', incident.id);
  if (openChildren > 0) {
    if (!hasPermission(actor, 'task:override') || !input.reason) {
      throw new ConflictError(
        `This incident has ${openChildren} open task(s). Complete or cancel them, or resolve with the task:override permission and a reason.`,
      );
    }
    overrodeOpenChildren = openChildren;
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    await updateIncident(
      incident.id,
      { status: 'RESOLVED', resolutionSummary: summary, resolvedAt: now, closedAt: null },
      tx,
    );
    await stopClock(ENTITY_TYPE, incident.id, now, tx);
    await writeAudit(
      {
        organizationId: incident.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.INCIDENT_RESOLVE,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        before: { status: incident.status },
        after: { status: 'RESOLVED', resolutionSummary: summary },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: incident.organizationId,
        eventType: OUTBOX_EVENT.INCIDENT_RESOLVED,
        idempotencyKey: `incident.resolved:${incident.id}:${randomUUID()}`,
        // The reporter is told the incident they raised is resolved (`docs/29` §5); the
        // payload carries the id, not an address.
        payload: {
          incidentId: incident.id,
          reference: incident.reference,
          reporterId: incident.reporterId,
        },
      },
      tx,
    );

    if (overrodeOpenChildren > 0) {
      // Audited and alerted (`docs/24` §4): closing over open children must be visible.
      await writeAudit(
        {
          organizationId: incident.organizationId,
          actorId: actor.userId,
          actorType: 'USER',
          action: AUDIT_ACTION.TASK_OVERRIDE,
          entityType: AUDIT_ENTITY.INCIDENT,
          entityId: incident.id,
          after: { openChildren: overrodeOpenChildren },
          reason: input.reason ?? null,
          correlationId: meta.correlationId,
          sourceIp: meta.sourceIp ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );
      await writeOutboxEvent(
        {
          organizationId: incident.organizationId,
          eventType: OUTBOX_EVENT.TASK_ROLLUP_OVERRIDE,
          idempotencyKey: `task.rollup.override:${incident.id}:${randomUUID()}`,
          payload: {
            parentType: 'INCIDENT',
            parentId: incident.id,
            openChildren: overrodeOpenChildren,
          },
        },
        tx,
      );
    }
  });

  // Resolution is what the incident and SLA figures measure (`docs/30` §3.3 owners `23`
  // and `25`): the status counts move and the clock stops.
  await invalidateReportCache(incident.organizationId, 'report.incidents', 'report.sla');

  return toView((await findIncidentById(incident.id)) as IncidentWithRelations);
}

/** Closes a resolved incident (`docs/23` §4, RESOLVED → CLOSED). */
export async function closeIncident(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  const incident = await loadReadable(id, actor);
  // The reporter may confirm closure; agents and leads always may (`docs/23` §4).
  const isReporter = incident.reporterId === actor.userId;
  if (!isReporter && !mayUpdate(actor)) {
    throw new ForbiddenError();
  }
  if (incident.status === 'CLOSED') {
    throw new IllegalTransitionError('The incident is already closed.');
  }
  if (incident.status !== 'RESOLVED') {
    throw new IllegalTransitionError('Only a resolved incident can be closed.');
  }

  const now = new Date();
  await runInTransaction(async (tx) => {
    await updateIncident(incident.id, { status: 'CLOSED', closedAt: now }, tx);
    await writeAudit(
      {
        organizationId: incident.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.INCIDENT_CLOSE,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        before: { status: incident.status },
        after: { status: 'CLOSED' },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  // A closure moves the status counts. The clock was stopped at resolution, so the SLA
  // class is not re-invalidated here.
  await invalidateReportCache(incident.organizationId, 'report.incidents');

  return toView((await findIncidentById(incident.id)) as IncidentWithRelations);
}

/**
 * Reopens a RESOLVED or CLOSED incident (`docs/23` §4, rule I4).
 *
 * Within the configured window the reporter, an agent or a lead may reopen freely; outside
 * it, reopening requires the wider update permission and a recorded reason. Either way the
 * reopen count is incremented (it is reported, §12) and a **new clock cycle** starts, so
 * the reopened work has its own SLA rather than inheriting a stopped one.
 */
export async function reopenIncident(
  id: string,
  input: { reason?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  const incident = await loadReadable(id, actor);

  if (incident.status !== 'RESOLVED' && incident.status !== 'CLOSED') {
    throw new IllegalTransitionError('Only a resolved or closed incident can be reopened.');
  }

  const isReporter = incident.reporterId === actor.userId;
  const agent = mayUpdate(actor);
  if (!isReporter && !agent) {
    throw new ForbiddenError();
  }

  // The window is measured from the incident's *terminal* moment — its closure for a
  // closed incident, its resolution otherwise — so a record closed long ago cannot be
  // reopened without a reason merely because it was resolved recently.
  const anchor =
    incident.status === 'CLOSED'
      ? (incident.closedAt ?? incident.resolvedAt ?? incident.updatedAt)
      : (incident.resolvedAt ?? incident.closedAt ?? incident.updatedAt);
  const windowMs = config.INCIDENT_REOPEN_WINDOW_HOURS * 60 * 60 * 1000;
  const withinWindow = Date.now() - anchor.getTime() <= windowMs;

  if (!withinWindow) {
    // Outside the window: an agent/lead override with a reason is required (rule I4).
    if (!agent) {
      throw new ForbiddenError();
    }
    if (!input.reason) {
      throw new ValidationError([
        {
          field: 'reason',
          code: 'REQUIRED',
          message: 'A reason is required to reopen outside the configured window.',
        },
      ]);
    }
  }

  const slaPolicy = await findSlaPolicyById(incident.slaPolicyId);
  if (!slaPolicy || slaPolicy.organizationId !== incident.organizationId) {
    throw new ConflictError('The incident’s SLA policy is no longer available.');
  }

  const now = new Date();
  const reopenCount = incident.reopenCount + 1;

  await runInTransaction(async (tx) => {
    await updateIncident(
      incident.id,
      { status: 'IN_PROGRESS', reopenCount, resolvedAt: null, closedAt: null },
      tx,
    );
    await startClock(
      {
        organizationId: incident.organizationId,
        entityType: ENTITY_TYPE,
        entityId: incident.id,
        slaPolicy,
        priority: incident.priority,
        startAt: now,
        cycle: reopenCount + 1,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: incident.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.INCIDENT_REOPEN,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        before: { status: incident.status, reopenCount: incident.reopenCount },
        after: { status: 'IN_PROGRESS', reopenCount, withinWindow },
        ...(input.reason ? { reason: input.reason } : {}),
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: incident.organizationId,
        eventType: OUTBOX_EVENT.INCIDENT_REOPENED,
        idempotencyKey: `incident.reopened:${incident.id}:${reopenCount}:${randomUUID()}`,
        payload: { incidentId: incident.id, reopenCount },
      },
      tx,
    );
  });

  // A reopen clears `resolvedAt` — which is what the reopen-aware MTTR reads — starts a new
  // clock cycle, and moves the status counts (`docs/30` §3.3, owner `23`).
  await invalidateReportCache(incident.organizationId, 'report.incidents', 'report.sla');

  return toView((await findIncidentById(incident.id)) as IncidentWithRelations);
}

// ===========================================================================
// Major-incident flag
// ===========================================================================

/**
 * Toggles the major-incident flag (`docs/23` §5). Audited **in both directions**: quietly
 * clearing the flag after a bad incident is exactly the change an audit trail exists to
 * reveal.
 */
export async function setIncidentMajor(
  id: string,
  input: { isMajor: boolean; reason?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentView> {
  const incident = await loadReadable(id, actor);
  if (!mayUpdate(actor)) {
    throw new ForbiddenError();
  }
  if (TERMINAL_STATUSES.includes(incident.status) && input.isMajor) {
    throw new IllegalTransitionError('A closed incident cannot be marked major.');
  }
  if (incident.isMajor === input.isMajor) {
    return toView(incident);
  }

  await runInTransaction(async (tx) => {
    await updateIncident(incident.id, { isMajor: input.isMajor }, tx);
    await writeAudit(
      {
        organizationId: incident.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: input.isMajor ? AUDIT_ACTION.INCIDENT_MAJOR_SET : AUDIT_ACTION.INCIDENT_MAJOR_CLEAR,
        entityType: AUDIT_ENTITY.INCIDENT,
        entityId: incident.id,
        before: { isMajor: incident.isMajor },
        after: { isMajor: input.isMajor },
        ...(input.reason ? { reason: input.reason } : {}),
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: incident.organizationId,
        eventType: input.isMajor
          ? OUTBOX_EVENT.INCIDENT_MAJOR_DECLARED
          : OUTBOX_EVENT.INCIDENT_MAJOR_CLEARED,
        idempotencyKey: `incident.major:${incident.id}:${String(input.isMajor)}:${randomUUID()}`,
        payload: { incidentId: incident.id, isMajor: input.isMajor },
      },
      tx,
    );
  });

  // `majorCount` is a reported figure (`docs/30` §3.3, owner `23`).
  await invalidateReportCache(incident.organizationId, 'report.incidents');

  return toView((await findIncidentById(incident.id)) as IncidentWithRelations);
}

// ===========================================================================
// Comments
// ===========================================================================

export interface IncidentCommentView {
  id: string;
  body: string;
  visibility: CommentVisibility;
  author: { id: string; displayName: string };
  createdAt: Date;
}

function toCommentView(comment: CommentWithAuthor): IncidentCommentView {
  return {
    id: comment.id,
    body: comment.body,
    visibility: comment.visibility,
    author: { id: comment.author.id, displayName: comment.author.displayName },
    createdAt: comment.createdAt,
  };
}

/**
 * Adds a comment to an incident. Audience rules are identical to requests (`docs/23` §6
 * rule I7): only agents/leads may author an internal note, and a reporter never receives
 * one.
 */
export async function addIncidentComment(
  id: string,
  input: { body: string; visibility: CommentVisibility },
  actor: Principal,
  meta: RequestMeta,
): Promise<IncidentCommentView> {
  const incident = await loadReadable(id, actor);

  if (input.visibility === 'INTERNAL' && !mayUpdate(actor)) {
    throw new ForbiddenError('Only the fulfilling team can add an internal note.');
  }

  const comment = await runInTransaction(async (tx) => {
    const created = await createComment(
      {
        organizationId: incident.organizationId,
        entityType: ENTITY_TYPE,
        entityId: incident.id,
        authorId: actor.userId,
        visibility: input.visibility,
        body: input.body,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: incident.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.COMMENT_ADD,
        entityType: AUDIT_ENTITY.COMMENT,
        entityId: created.id,
        after: { incidentId: incident.id, visibility: created.visibility },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: incident.organizationId,
        eventType: OUTBOX_EVENT.COMMENT_ADDED,
        idempotencyKey: `comment.added:${created.id}`,
        payload: { incidentId: incident.id, commentId: created.id, visibility: created.visibility },
      },
      tx,
    );
    return created;
  });

  return toCommentView((await findCommentById(comment.id)) as CommentWithAuthor);
}

export interface IncidentHistoryEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorType: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

/** The audit timeline for one incident (`docs/23` §10, `docs/31` §8). */
export async function getIncidentHistory(
  id: string,
  input: { limit: number },
  actor: Principal,
): Promise<IncidentHistoryEntry[]> {
  const incident = await loadReadable(id, actor);
  const rows = await listAuditForEntity({
    organizationId: incident.organizationId,
    entityType: ENTITY_TYPE,
    entityId: incident.id,
    limit: input.limit,
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorId: row.actorId,
    actorType: row.actorType,
    reason: row.reason,
    before: row.before,
    after: row.after,
    createdAt: row.occurredAt,
  }));
}

/**
 * Object-level visibility check for an incident, reused by child resources (tasks) so a
 * task never outlives its parent's visibility (`docs/24` rule T2).
 */
export function assertIncidentVisible(
  id: string,
  actor: Principal,
): Promise<IncidentWithRelations> {
  return loadReadable(id, actor);
}

export async function listIncidentComments(
  id: string,
  input: { limit: number; cursor?: string },
  actor: Principal,
): Promise<CursorPage<IncidentCommentView>> {
  const incident = await loadReadable(id, actor);
  const includeInternal = mayUpdate(actor);

  const rows = await listComments({
    organizationId: incident.organizationId,
    entityType: ENTITY_TYPE,
    entityId: incident.id,
    includeInternal,
    limit: input.limit,
    cursor: input.cursor,
  });

  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
  return { ...page, items: page.items.map(toCommentView) };
}
