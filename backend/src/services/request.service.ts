import { randomUUID } from 'node:crypto';
import type { CommentVisibility, Priority, RequestStatus } from '@prisma/client';
import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  REQUEST_READ_PERMISSIONS,
  type Principal,
} from '../helpers/authorization';
import type { Prisma } from '@prisma/client';
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
  countRequestsForCatalogItem,
  createComment,
  createRequestFieldValues,
  createServiceRequest,
  findCatalogItemById,
  findCommentById,
  findRequestById,
  findSlaPolicyById,
  findTeamById,
  findUserById,
  listComments,
  listRequests,
  listTeamIdsForUser,
  reserveReferenceValue,
  runInTransaction,
  updateServiceRequest,
  writeAudit,
  writeOutboxEvent,
  type CommentWithAuthor,
  type RequestFieldSnapshot,
  type RequestScope,
  type RequestWithRelations,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import { cancelWorkflowForRequest, instantiateWorkflowForRequest } from './approval.service';
import { invalidateReportCache } from './report-cache';
import type { RequestMeta } from './context';
import {
  clockViewFor,
  clockViewsFor,
  pauseClockIfPolicy,
  resumeClock,
  startClock,
  stopClock,
  type SlaClockView,
} from './sla-clock.service';

/**
 * Service requests — docs/22, F-05.
 *
 * This service owns the request **state machine** (docs/22 §3, authoritative). Three
 * rules shape nearly every method here:
 *
 *   - **Object-level scope.** Read scope is resolved from the caller's permissions
 *     (`request:read.own/team/any`) and applied inside the query (docs/22 §10). A caller
 *     who may not see a record receives NOT_FOUND, never FORBIDDEN (docs/17).
 *   - **The field snapshot is frozen at creation** (rule R9, C3): answers are validated
 *     against the item as it is now and then stored with their labels, so a later catalog
 *     edit cannot rewrite the meaning of an existing request.
 *   - **The SLA policy is frozen at creation** and the clock's target instants are
 *     computed once (§8, docs/25 §4 example 5).
 */

const ENTITY_TYPE = 'ServiceRequest';

/** Read scope for the caller: `any` > `team` > `own` (docs/22 §10). */
function resolveScope(actor: Principal): RequestScope {
  if (hasPermission(actor, 'request:read.any')) return 'any';
  if (hasPermission(actor, 'request:read.team')) return 'team';
  return 'own';
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can work with requests.');
  }
  return actor.organizationId;
}

/** Whether the caller may update the given record (assigned to them, or any). */
function mayUpdate(actor: Principal, request: RequestWithRelations): boolean {
  if (hasPermission(actor, 'request:update.any')) return true;
  if (!hasPermission(actor, 'request:update.assigned')) return false;
  return request.assigneeId === actor.userId;
}

function mayReadObject(
  actor: Principal,
  request: RequestWithRelations,
  teamIds: string[],
): boolean {
  const scope = resolveScope(actor);
  if (scope === 'any') return true;
  if (request.requesterId === actor.userId) return true;
  if (scope === 'team') {
    return (
      request.assigneeId === actor.userId ||
      (request.teamId !== null && teamIds.includes(request.teamId))
    );
  }
  return false;
}

export interface RequestView {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  status: RequestStatus;
  priority: Priority;
  /** `requiresApproval` is carried so the client can offer the approval transition; the
   * model already loads it (`request.model.ts`), and the server re-checks the rule. */
  catalogItem: { id: string; name: string; requiresApproval: boolean };
  requester: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  slaPolicy: { id: string; name: string };
  /**
   * The live clock, or null when the record has none (`docs/25` §12). The SLA indicator
   * renders from this: state plus the time remaining to the frozen target, so the header
   * answers "is this urgent?" without a second request.
   */
  sla: SlaClockView | null;
  fields: Array<{
    key: string;
    label: string;
    fieldType: string;
    value: unknown;
    displayOrder: number;
  }>;
  submittedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestSummary {
  id: string;
  reference: string;
  title: string;
  status: RequestStatus;
  priority: Priority;
  catalogItemName: string;
  requesterName: string;
  assigneeName: string | null;
  slaPolicyName: string;
  /** The live clock (`docs/22` §14 AC5: SLA state is visible in the list, not only on the
   * record). One batched query covers the whole page, so no row costs a query of its own. */
  sla: SlaClockView | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRequestInput {
  catalogItemId: string;
  title: string;
  description: string | null;
  priority?: Priority;
  fields: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Projects a request for a response.
 *
 * Async because it attaches the live clock, and it loads the clock here rather than at
 * each call site so **every** path that returns a request — create, read, assign,
 * transition, cancel — shows the current SLA state. A transition response that omitted the
 * clock would leave the UI showing a stale countdown after the very action that changed it
 * (fulfilment stops the clock; entering an approval may pause it).
 */
async function toView(request: RequestWithRelations): Promise<RequestView> {
  const sla = await clockViewFor(request.organizationId, ENTITY_TYPE, request.id);
  return {
    id: request.id,
    reference: request.reference,
    title: request.title,
    description: request.description,
    status: request.status,
    priority: request.priority,
    catalogItem: {
      id: request.catalogItem.id,
      name: request.catalogItem.name,
      requiresApproval: request.catalogItem.requiresApproval,
    },
    requester: { id: request.requester.id, displayName: request.requester.displayName },
    assignee: request.assignee
      ? { id: request.assignee.id, displayName: request.assignee.displayName }
      : null,
    team: request.team ? { id: request.team.id, name: request.team.name } : null,
    slaPolicy: { id: request.slaPolicy.id, name: request.slaPolicy.name },
    sla,
    fields: request.fieldValues.map((value) => ({
      key: value.fieldKey,
      label: value.fieldLabel,
      fieldType: value.fieldType,
      value: value.value,
      displayOrder: value.displayOrder,
    })),
    submittedAt: request.submittedAt,
    resolvedAt: request.resolvedAt,
    closedAt: request.closedAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function toSummary(request: RequestWithRelations, sla: SlaClockView | null): RequestSummary {
  return {
    id: request.id,
    reference: request.reference,
    title: request.title,
    status: request.status,
    priority: request.priority,
    catalogItemName: request.catalogItem.name,
    requesterName: request.requester.displayName,
    assigneeName: request.assignee?.displayName ?? null,
    slaPolicyName: request.slaPolicy.name,
    sla,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

// ===========================================================================
// Creation
// ===========================================================================

export async function createRequest(
  input: CreateRequestInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<RequestView> {
  assertPermission(actor, 'request:create');
  const organizationId = requireTenant(actor);

  const item = await findCatalogItemById(input.catalogItemId);
  // A cross-tenant item is indistinguishable from a missing one; a non-ACTIVE item is a
  // 409 because it exists but is no longer requestable (docs/21 §11, docs/22).
  if (!item || item.organizationId !== organizationId) {
    throw new NotFoundError('Catalog item not found.');
  }
  if (item.status !== 'ACTIVE') {
    throw new ConflictError('This service is no longer available.');
  }

  const priority = input.priority ?? item.defaultPriority;
  const fieldValues = buildFieldSnapshot(item.fields, input.fields);

  const slaPolicyId = item.defaultSlaPolicyId;
  if (!slaPolicyId) {
    throw new ConflictError('This service has no SLA policy and cannot be requested.');
  }
  const slaPolicy = await findSlaPolicyById(slaPolicyId);
  if (!slaPolicy || slaPolicy.organizationId !== organizationId) {
    throw new ConflictError('This service has no usable SLA policy and cannot be requested.');
  }

  const now = new Date();
  const year = now.getUTCFullYear();

  const created = await runInTransaction(async (tx) => {
    const sequence = await reserveReferenceValue(organizationId, 'REQ', String(year), tx);
    const reference = `REQ-${year}-${String(sequence).padStart(6, '0')}`;

    const request = await createServiceRequest(
      {
        organizationId,
        reference,
        catalogItemId: item.id,
        requesterId: actor.userId,
        teamId: item.fulfilmentTeamId,
        priority,
        title: input.title,
        description: input.description,
        slaPolicyId: item.defaultSlaPolicyId as string,
        fieldSnapshot: fieldValues as unknown as Prisma.InputJsonValue,
      },
      tx,
    );

    await createRequestFieldValues(request.id, fieldValues, tx);

    await startClock(
      {
        organizationId,
        entityType: ENTITY_TYPE,
        entityId: request.id,
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
        action: AUDIT_ACTION.REQUEST_CREATE,
        entityType: AUDIT_ENTITY.REQUEST,
        entityId: request.id,
        after: { reference, status: request.status, priority },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    await writeOutboxEvent(
      {
        organizationId,
        eventType: OUTBOX_EVENT.REQUEST_CREATED,
        idempotencyKey: `request.created:${request.id}`,
        payload: { requestId: request.id, reference, teamId: item.fulfilmentTeamId },
      },
      tx,
    );

    return request;
  });

  // After the commit (`docs/30` §3.4): a new request moves the request figures and starts
  // an SLA clock, so both classes are invalidated.
  await invalidateReportCache(organizationId, 'report.requests', 'report.sla');

  return toView((await findRequestById(created.id)) as RequestWithRelations);
}

/**
 * Validates the caller's answers against the item's field definitions and produces the
 * frozen snapshot (rules C3/C4/R9). Required fields are enforced server-side; client
 * validation is UX only (docs/12).
 */
function buildFieldSnapshot(
  definitions: Array<{
    key: string;
    label: string;
    fieldType: string;
    isRequired: boolean;
    options: unknown;
    displayOrder: number;
  }>,
  values: Record<string, unknown>,
): RequestFieldSnapshot[] {
  const errors: Array<{ field: string; message: string; code: string }> = [];
  const snapshot: RequestFieldSnapshot[] = [];

  for (const definition of definitions) {
    const provided = values[definition.key];
    const empty = provided === undefined || provided === null || provided === '';

    if (definition.isRequired && empty) {
      errors.push({
        field: `fields.${definition.key}`,
        code: 'REQUIRED',
        message: `${definition.label} is required.`,
      });
      continue;
    }
    if (empty) {
      snapshot.push({
        fieldKey: definition.key,
        fieldLabel: definition.label,
        fieldType: definition.fieldType as RequestFieldSnapshot['fieldType'],
        value: null,
        displayOrder: definition.displayOrder,
      });
      continue;
    }

    const options = Array.isArray(definition.options) ? (definition.options as string[]) : [];
    if (
      (definition.fieldType === 'SELECT' || definition.fieldType === 'MULTI_SELECT') &&
      options.length > 0
    ) {
      const chosen = Array.isArray(provided) ? provided : [provided];
      const invalid = chosen.filter(
        (value) => typeof value !== 'string' || !options.includes(value),
      );
      if (invalid.length > 0) {
        errors.push({
          field: `fields.${definition.key}`,
          code: 'INVALID_OPTION',
          message: `${definition.label} contains an option that is not offered.`,
        });
        continue;
      }
    }

    snapshot.push({
      fieldKey: definition.key,
      fieldLabel: definition.label,
      fieldType: definition.fieldType as RequestFieldSnapshot['fieldType'],
      value: provided as Prisma.InputJsonValue,
      displayOrder: definition.displayOrder,
    });
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
  return snapshot;
}

// ===========================================================================
// Reads
// ===========================================================================

export async function listRequestsPage(
  input: { limit: number; cursor?: string; status?: RequestStatus },
  actor: Principal,
): Promise<CursorPage<RequestSummary>> {
  const organizationId = requireTenant(actor);
  assertAnyPermission(actor, REQUEST_READ_PERMISSIONS);

  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  const rows = await listRequests({
    organizationId,
    scope: resolveScope(actor),
    userId: actor.userId,
    teamIds,
    status: input.status,
    limit: input.limit,
    cursor: input.cursor,
  });

  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
  // One query for the page's clocks (`docs/25` §12): an indicator per row must not become
  // an N+1.
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

export async function getRequest(id: string, actor: Principal): Promise<RequestView> {
  const organizationId = requireTenant(actor);
  assertAnyPermission(actor, REQUEST_READ_PERMISSIONS);

  const request = await findRequestById(id);
  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  // Cross-tenant or out-of-scope both read as NOT_FOUND (docs/17).
  if (
    !request ||
    request.organizationId !== organizationId ||
    !mayReadObject(actor, request, teamIds)
  ) {
    throw new NotFoundError('Request not found.');
  }
  return toView(request);
}

// ===========================================================================
// Transitions, assignment, cancellation, comments
// ===========================================================================

/**
 * The transition table, transcribed from docs/22 §3. Terminal states have no outgoing
 * edges (rule R7), and every pair not listed here returns `409 ILLEGAL_TRANSITION`.
 */
const ALLOWED_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  NEW: ['TRIAGED', 'CANCELLED'],
  TRIAGED: ['APPROVAL_PENDING', 'IN_PROGRESS', 'CANCELLED'],
  APPROVAL_PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS'],
  REJECTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['FULFILLED', 'CANCELLED'],
  FULFILLED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

const TERMINAL: RequestStatus[] = ['CLOSED', 'CANCELLED'];

export interface TransitionInput {
  to: RequestStatus;
  reason?: string;
  fulfilmentNote?: string;
}

async function loadReadable(id: string, actor: Principal): Promise<RequestWithRelations> {
  const organizationId = requireTenant(actor);
  assertAnyPermission(actor, REQUEST_READ_PERMISSIONS);
  const request = await findRequestById(id);
  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  if (
    !request ||
    request.organizationId !== organizationId ||
    !mayReadObject(actor, request, teamIds)
  ) {
    throw new NotFoundError('Request not found.');
  }
  return request;
}

/**
 * Applies a state-machine transition (docs/22 §3). Illegality is checked first, then the
 * actor's right to make the move, then the guards the target state imposes — so the
 * error a caller receives names the real obstacle.
 */
export async function transitionRequest(
  id: string,
  input: TransitionInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<RequestView> {
  const request = await loadReadable(id, actor);
  const from = request.status;

  if (!ALLOWED_TRANSITIONS[from].includes(input.to)) {
    throw new IllegalTransitionError(`A request cannot move from ${from} to ${input.to}.`);
  }
  if (TERMINAL.includes(from)) {
    throw new IllegalTransitionError('A closed or cancelled request cannot be changed.');
  }

  assertTransitionPermission(actor, request, input, from);

  const organizationId = request.organizationId;
  const data: Parameters<typeof updateServiceRequest>[1] = { status: input.to };
  const now = new Date();

  if (input.to === 'IN_PROGRESS' && !request.assigneeId) {
    // Rule: a request must be assigned before or at entry to IN_PROGRESS (docs/22 §7).
    throw new ValidationError([
      { field: 'assigneeId', code: 'UNASSIGNED', message: 'Assign the request before working it.' },
    ]);
  }
  let overrodeOpenChildren = 0;
  if (input.to === 'FULFILLED') {
    if (!input.fulfilmentNote) {
      throw new ValidationError([
        { field: 'fulfilmentNote', code: 'REQUIRED', message: 'A fulfilment note is required.' },
      ]);
    }
    // Roll-up (`docs/24` §4): a request may not be fulfilled over open child tasks
    // without the override permission and a recorded reason. The check reads the task
    // table directly — the roll-up rule belongs to the parent, so no dependency on the
    // tasks *module* is introduced (`docs/03` §4).
    const openChildren = await countOpenTasksForParent('REQUEST', request.id);
    if (openChildren > 0) {
      if (!hasPermission(actor, 'task:override') || !input.reason) {
        throw new ConflictError(
          `This request has ${openChildren} open task(s). Complete or cancel them, or fulfil with the task:override permission and a reason.`,
        );
      }
      overrodeOpenChildren = openChildren;
    }
    data.resolvedAt = now;
  }
  if (input.to === 'CLOSED') {
    data.closedAt = now;
  }

  await runInTransaction(async (tx) => {
    await updateServiceRequest(request.id, data, tx);

    // Pause/resume the clock around an approval (`docs/25` §3, `docs/22` §3). The pause
    // is policy-driven: a policy without `APPROVAL_PENDING` in its pause states keeps the
    // clock running, which is a deliberate, surfaced choice (`docs/26` §13).
    if (input.to === 'APPROVAL_PENDING') {
      // Instantiate the approval workflow in the same transaction as the status change, so
      // the request can never sit in APPROVAL_PENDING with nothing to decide (`docs/26` §4).
      await instantiateWorkflowForRequest(
        {
          organizationId,
          requestId: request.id,
          catalogItemId: request.catalogItemId,
          requesterId: request.requesterId,
        },
        tx,
        meta,
      );
      const policy = await findSlaPolicyById(request.slaPolicyId);
      if (policy) {
        await pauseClockIfPolicy(ENTITY_TYPE, request.id, 'APPROVAL_PENDING', policy, now, tx);
      }
    }
    if (from === 'APPROVAL_PENDING') {
      await resumeClock(ENTITY_TYPE, request.id, now, tx);
    }

    if (input.to === 'FULFILLED' || input.to === 'CANCELLED') {
      await stopClock(ENTITY_TYPE, request.id, now, tx);
    }

    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action:
          input.to === 'CANCELLED' ? AUDIT_ACTION.REQUEST_CANCEL : AUDIT_ACTION.REQUEST_TRANSITION,
        entityType: AUDIT_ENTITY.REQUEST,
        entityId: request.id,
        before: { status: from },
        after: { status: input.to, reason: input.reason ?? null },
        ...(input.reason ? { reason: input.reason } : {}),
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    await writeOutboxEvent(
      {
        organizationId,
        eventType: OUTBOX_EVENT.REQUEST_STATUS_CHANGED,
        // Unique per event instance: a request may legitimately revisit a state, and a
        // repeated key would collide on the outbox's unique constraint.
        idempotencyKey: `request.status:${request.id}:${from}:${input.to}:${randomUUID()}`,
        payload: { requestId: request.id, from, to: input.to },
      },
      tx,
    );

    if (overrodeOpenChildren > 0) {
      // A parent closed over open children is a source of "work quietly lost", so the
      // override is both audited and alerted on (`docs/24` §4).
      await writeAudit(
        {
          organizationId,
          actorId: actor.userId,
          actorType: 'USER',
          action: AUDIT_ACTION.TASK_OVERRIDE,
          entityType: AUDIT_ENTITY.REQUEST,
          entityId: request.id,
          after: { openChildren: overrodeOpenChildren, to: input.to },
          reason: input.reason ?? null,
          correlationId: meta.correlationId,
          sourceIp: meta.sourceIp ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );
      await writeOutboxEvent(
        {
          organizationId,
          eventType: OUTBOX_EVENT.TASK_ROLLUP_OVERRIDE,
          idempotencyKey: `task.rollup.override:${request.id}:${randomUUID()}`,
          payload: {
            parentType: 'REQUEST',
            parentId: request.id,
            openChildren: overrodeOpenChildren,
          },
        },
        tx,
      );
    }
  });

  // A cancelled request voids any pending workflow so no approver is left holding a
  // decision for work that no longer exists (`docs/26` §13).
  if (input.to === 'CANCELLED') {
    await cancelWorkflowForRequest(request.id, actor, meta);
  }

  // The status change moves the request figures, the same transaction paused/resumed or
  // stopped the clock, and entering or leaving APPROVAL_PENDING raised or decided a
  // workflow (`docs/30` §3.4).
  await invalidateReportCache(organizationId, 'report.requests', 'report.sla', 'report.approvals');

  return toView((await findRequestById(request.id)) as RequestWithRelations);
}

function assertTransitionPermission(
  actor: Principal,
  request: RequestWithRelations,
  input: TransitionInput,
  from: RequestStatus,
): void {
  const isRequester = request.requesterId === actor.userId;

  if (input.to === 'APPROVED' || input.to === 'REJECTED') {
    // Approval outcomes are recorded by the approvals service through a designated
    // approver's decision, never by a direct transition (`docs/26` §5).
    throw new IllegalTransitionError(
      'Approval outcomes are recorded through the approvals API, not a direct transition.',
    );
  }
  if (input.to === 'CLOSED') {
    if (!isRequester && !hasPermission(actor, 'request:close.any')) {
      throw new ForbiddenError();
    }
    return;
  }
  if (input.to === 'CANCELLED') {
    if (isRequester && hasPermission(actor, 'request:cancel.own')) return;
    if (hasPermission(actor, 'request:close.any')) return;
    throw new ForbiddenError();
  }
  if (input.to === 'APPROVAL_PENDING') {
    if (!request.catalogItem.requiresApproval) {
      throw new IllegalTransitionError('This request does not require approval.');
    }
    if (!mayUpdate(actor, request)) throw new ForbiddenError();
    return;
  }
  if (input.to === 'IN_PROGRESS' && from === 'REJECTED') {
    // Re-working a rejected request is an override: it needs the wider permission and a
    // recorded reason (docs/22 §3, rule R8).
    if (!hasPermission(actor, 'request:update.any')) throw new ForbiddenError();
    if (!input.reason) {
      throw new ValidationError([
        {
          field: 'reason',
          code: 'REQUIRED',
          message: 'A reason is required to re-work a rejected request.',
        },
      ]);
    }
    return;
  }
  if (!mayUpdate(actor, request)) {
    throw new ForbiddenError();
  }
}

/**
 * Assigns or reassigns a request (docs/22 §7). The assignee must be an active member of
 * the tenant and the team must belong to it, so a client-supplied id cannot route work
 * outside the tenant. Reassignment records both sides in the audit trail.
 */
export async function assignRequest(
  id: string,
  input: { assigneeId?: string | null; teamId?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<RequestView> {
  const request = await loadReadable(id, actor);
  assertPermission(actor, 'request:assign');

  const organizationId = request.organizationId;
  const data: Parameters<typeof updateServiceRequest>[1] = {};

  if (input.assigneeId !== undefined) {
    if (input.assigneeId === null) {
      data.assigneeId = null;
    } else {
      const assignee = await findUserById(input.assigneeId);
      if (!assignee || assignee.organizationId !== organizationId || assignee.status !== 'ACTIVE') {
        throw new NotFoundError('Assignee not found.');
      }
      data.assigneeId = assignee.id;
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

  await runInTransaction(async (tx) => {
    await updateServiceRequest(request.id, data, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.REQUEST_ASSIGN,
        entityType: AUDIT_ENTITY.REQUEST,
        entityId: request.id,
        before: { assigneeId: request.assigneeId, teamId: request.teamId },
        after: {
          assigneeId: data.assigneeId ?? request.assigneeId,
          teamId: data.teamId ?? request.teamId,
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
          eventType: OUTBOX_EVENT.REQUEST_ASSIGNED,
          idempotencyKey: `request.assigned:${request.id}:${data.assigneeId}:${randomUUID()}`,
          payload: { requestId: request.id, assigneeId: data.assigneeId },
        },
        tx,
      );
    }
  });

  // Reassignment changes whose work this is, and the assignee is a scope predicate in the
  // request reports (`docs/30` R3): the previous and the new assignee's figures both move.
  await invalidateReportCache(organizationId, 'report.requests');

  return toView((await findRequestById(request.id)) as RequestWithRelations);
}

export async function cancelRequest(
  id: string,
  input: { reason?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<RequestView> {
  return transitionRequest(id, { to: 'CANCELLED', reason: input.reason }, actor, meta);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface CommentView {
  id: string;
  body: string;
  visibility: CommentVisibility;
  author: { id: string; displayName: string };
  createdAt: Date;
}

function toCommentView(comment: CommentWithAuthor): CommentView {
  return {
    id: comment.id,
    body: comment.body,
    visibility: comment.visibility,
    author: { id: comment.author.id, displayName: comment.author.displayName },
    createdAt: comment.createdAt,
  };
}

/**
 * Adds a comment. An `INTERNAL` note requires the caller to be an agent — a requester
 * can never author one, and can never receive one (docs/22 §6).
 */
export async function addComment(
  id: string,
  input: { body: string; visibility: CommentVisibility },
  actor: Principal,
  meta: RequestMeta,
): Promise<CommentView> {
  const request = await loadReadable(id, actor);

  if (
    input.visibility === 'INTERNAL' &&
    !mayUpdate(actor, request) &&
    !hasPermission(actor, 'request:read.any')
  ) {
    throw new ForbiddenError('Only the fulfilling team can add an internal note.');
  }

  const comment = await runInTransaction(async (tx) => {
    const created = await createComment(
      {
        organizationId: request.organizationId,
        entityType: ENTITY_TYPE,
        entityId: request.id,
        authorId: actor.userId,
        visibility: input.visibility,
        body: input.body,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: request.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.COMMENT_ADD,
        entityType: AUDIT_ENTITY.COMMENT,
        entityId: created.id,
        after: { requestId: request.id, visibility: created.visibility },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: request.organizationId,
        eventType: OUTBOX_EVENT.COMMENT_ADDED,
        idempotencyKey: `comment.added:${created.id}`,
        payload: { requestId: request.id, commentId: created.id, visibility: created.visibility },
      },
      tx,
    );
    return created;
  });

  const withAuthor = await findCommentById(comment.id);
  return toCommentView(withAuthor as CommentWithAuthor);
}

/** Lists a request's comments, excluding internal notes from a requester (docs/22 §5 R5). */
export async function listRequestComments(
  id: string,
  input: { limit: number; cursor?: string },
  actor: Principal,
): Promise<CursorPage<CommentView>> {
  const request = await loadReadable(id, actor);
  const includeInternal = mayUpdate(actor, request) || hasPermission(actor, 'request:read.any');

  const rows = await listComments({
    organizationId: request.organizationId,
    entityType: ENTITY_TYPE,
    entityId: request.id,
    includeInternal,
    limit: input.limit,
    cursor: input.cursor,
  });

  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
  return { ...page, items: page.items.map(toCommentView) };
}

/** Number of requests raised from an item — used before removing a field definition. */
export function countRequestsForItem(catalogItemId: string): Promise<number> {
  return countRequestsForCatalogItem(catalogItemId);
}

/**
 * Object-level visibility check for a request, reused by child resources (tasks) so a
 * task never outlives its parent's visibility (`docs/24` rule T2). A caller who may not
 * see the parent receives NOT_FOUND, exactly as a direct read would.
 */
export function assertRequestVisible(id: string, actor: Principal): Promise<RequestWithRelations> {
  return loadReadable(id, actor);
}
