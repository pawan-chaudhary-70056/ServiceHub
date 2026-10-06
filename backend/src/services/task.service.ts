import { randomUUID } from 'node:crypto';
import type { TaskParentType, TaskStatus } from '@prisma/client';
import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  type Principal,
} from '../helpers/authorization';
import {
  ConflictError,
  ForbiddenError,
  IllegalTransitionError,
  NotFoundError,
} from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  countOpenTasksForParent,
  createTask,
  findTaskById,
  findUserById,
  listTasksForAssignee,
  listTasksForParent,
  listTeamIdsForUser,
  runInTransaction,
  updateTask,
  writeAudit,
  writeOutboxEvent,
  type TaskWithPeople,
} from '../models';
import { assertIncidentVisible } from './incident.service';
import { assertRequestVisible } from './request.service';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Tasks — docs/24, F-07.
 *
 * A task splits a parent into assigned pieces. Three rules shape this service:
 *
 *   - **One parent, and visibility ≤ the parent's** (T1/T2). A task has no read scope of
 *     its own: every read resolves the parent through the parent service's own
 *     object-level check, so a task can never be a back door to a record the caller may
 *     not see.
 *   - **The state machine is closed** (§3): TODO → IN_PROGRESS ⇄ BLOCKED, → DONE, and any
 *     non-terminal → CANCELLED. DONE/CANCELLED are terminal (T6).
 *   - **A block must say why** (§3). The reason is required here and enforced by the
 *     `tasks_blocked_reason_required` CHECK constraint in the database.
 *
 * Roll-up (§4) is the parent's obligation and is enforced in the parent services, which
 * call `countOpenTasksForParent` from the data layer; this module never imports a parent
 * service for a rule that belongs to the parent.
 */

/** The open-task cap per parent (rule T8) — beyond this, use a checklist field. */
const MAX_OPEN_TASKS = 100;

const TERMINAL: TaskStatus[] = ['DONE', 'CANCELLED'];

/** Parent facts a task needs, resolved through the parent's own visibility rules. */
interface ParentContext {
  parentType: TaskParentType;
  parentId: string;
  organizationId: string;
  teamId: string | null;
  assigneeId: string | null;
  terminal: boolean;
  label: string;
}

async function loadParent(
  parentType: TaskParentType,
  parentId: string,
  actor: Principal,
): Promise<ParentContext> {
  if (parentType === 'REQUEST') {
    const request = await assertRequestVisible(parentId, actor);
    return {
      parentType,
      parentId: request.id,
      organizationId: request.organizationId,
      teamId: request.teamId,
      assigneeId: request.assigneeId,
      terminal: request.status === 'CLOSED' || request.status === 'CANCELLED',
      label: `${request.reference} ${request.title}`,
    };
  }
  const incident = await assertIncidentVisible(parentId, actor);
  return {
    parentType,
    parentId: incident.id,
    organizationId: incident.organizationId,
    teamId: incident.teamId,
    assigneeId: incident.assigneeId,
    terminal: incident.status === 'CLOSED',
    label: `${incident.reference} ${incident.title}`,
  };
}

/** Whether the caller may update this task (assigned-to-them, team-scoped, or any). */
async function mayUpdateTask(
  actor: Principal,
  task: TaskWithPeople,
  parent: ParentContext,
): Promise<boolean> {
  if (hasPermission(actor, 'task:update.any')) return true;
  if (task.assigneeId === actor.userId && hasPermission(actor, 'task:update.own')) return true;
  if (hasPermission(actor, 'task:update.team') && parent.teamId) {
    const teamIds = await listTeamIdsForUser(parent.organizationId, actor.userId);
    return teamIds.includes(parent.teamId);
  }
  return false;
}

export interface TaskView {
  id: string;
  parentType: TaskParentType;
  parentId: string;
  parentLabel: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: { id: string; displayName: string } | null;
  createdBy: { id: string; displayName: string };
  blockedReason: string | null;
  /** Derived, never stored (`docs/24` §6). */
  overdue: boolean;
  dueAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toView(task: TaskWithPeople, parentLabel: string): TaskView {
  return {
    id: task.id,
    parentType: task.parentType,
    parentId: task.parentId,
    parentLabel,
    title: task.title,
    description: task.description,
    status: task.status,
    assignee: task.assignee
      ? { id: task.assignee.id, displayName: task.assignee.displayName }
      : null,
    createdBy: { id: task.createdBy.id, displayName: task.createdBy.displayName },
    blockedReason: task.blockedReason,
    overdue: isOverdue(task),
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** Overdue is derived from `dueAt` and terminal state, never stored (`docs/24` §6). */
function isOverdue(task: TaskWithPeople): boolean {
  if (!task.dueAt || TERMINAL.includes(task.status)) return false;
  return task.dueAt.getTime() < Date.now();
}

async function validateAssignee(organizationId: string, assigneeId: string | null): Promise<void> {
  if (assigneeId === null) return;
  const assignee = await findUserById(assigneeId);
  if (!assignee || assignee.organizationId !== organizationId || assignee.status !== 'ACTIVE') {
    throw new NotFoundError('Assignee not found.');
  }
}

// ===========================================================================
// Creation and reads
// ===========================================================================

export interface CreateTaskInput {
  title: string;
  description: string | null;
  assigneeId?: string | null;
  dueAt?: string | null;
}

export async function createTaskOnParent(
  parentType: TaskParentType,
  parentId: string,
  input: CreateTaskInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<TaskView> {
  assertPermission(actor, 'task:create');
  const parent = await loadParent(parentType, parentId, actor);
  if (parent.terminal) {
    throw new ConflictError('A task cannot be added to a closed or cancelled parent.');
  }

  const assigneeId = input.assigneeId ?? null;
  await validateAssignee(parent.organizationId, assigneeId);

  const open = await countOpenTasksForParent(parent.parentType, parent.parentId);
  if (open >= MAX_OPEN_TASKS) {
    throw new ConflictError(
      `A parent may have at most ${MAX_OPEN_TASKS} open tasks; use a checklist field beyond that.`,
    );
  }

  const created = await runInTransaction(async (tx) => {
    const task = await createTask(
      {
        organizationId: parent.organizationId,
        parentType: parent.parentType,
        parentId: parent.parentId,
        title: input.title,
        description: input.description,
        assigneeId,
        createdById: actor.userId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: parent.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.TASK_CREATE,
        entityType: AUDIT_ENTITY.TASK,
        entityId: task.id,
        after: { parentType: parent.parentType, parentId: parent.parentId, title: task.title },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    await writeOutboxEvent(
      {
        organizationId: parent.organizationId,
        eventType: OUTBOX_EVENT.TASK_CREATED,
        idempotencyKey: `task.created:${task.id}`,
        payload: {
          taskId: task.id,
          parentType: parent.parentType,
          parentId: parent.parentId,
          assigneeId,
        },
      },
      tx,
    );
    return task;
  });

  return toView((await findTaskById(created.id)) as TaskWithPeople, parent.label);
}

export async function listParentTasks(
  parentType: TaskParentType,
  parentId: string,
  actor: Principal,
): Promise<TaskView[]> {
  const parent = await loadParent(parentType, parentId, actor);
  const rows = await listTasksForParent(parent.parentType, parent.parentId);
  return rows.map((task) => toView(task, parent.label));
}

export async function listMyTasksPage(
  input: { limit: number; cursor?: string; status?: TaskStatus },
  actor: Principal,
): Promise<CursorPage<TaskView>> {
  if (!actor.organizationId) {
    throw new ForbiddenError('Only a tenant member can have tasks.');
  }
  assertAnyPermission(actor, ['task:update.own', 'task:update.team', 'task:update.any']);

  const rows = await listTasksForAssignee({
    organizationId: actor.organizationId,
    assigneeId: actor.userId,
    status: input.status,
    limit: input.limit,
    cursor: input.cursor,
  });

  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);
  return {
    ...page,
    items: page.items.map((task) => toView(task, parentLabelFor(task))),
  };
}

export async function getTask(id: string, actor: Principal): Promise<TaskView> {
  const task = await findTaskById(id);
  if (!task) {
    throw new NotFoundError('Task not found.');
  }
  // Resolving the parent enforces the parent's visibility (rule T2); a caller who may not
  // see the parent cannot see the task, and receives NOT_FOUND.
  const parent = await loadParent(task.parentType, task.parentId, actor);
  return toView(task, parent.label);
}

/** A compact parent label for the cross-parent "my tasks" view. */
function parentLabelFor(task: TaskWithPeople): string {
  return `${task.parentType} · ${task.parentId.slice(0, 8)}`;
}

// ===========================================================================
// Update, assignment, transition
// ===========================================================================

async function loadMutable(
  id: string,
  actor: Principal,
): Promise<{ task: TaskWithPeople; parent: ParentContext }> {
  const task = await findTaskById(id);
  if (!task) {
    throw new NotFoundError('Task not found.');
  }
  const parent = await loadParent(task.parentType, task.parentId, actor);
  if (!(await mayUpdateTask(actor, task, parent))) {
    throw new ForbiddenError();
  }
  if (TERMINAL.includes(task.status)) {
    throw new IllegalTransitionError('A completed or cancelled task cannot be changed.');
  }
  return { task, parent };
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  assigneeId?: string | null;
  dueAt?: string | null;
}

export async function updateTaskFields(
  id: string,
  input: UpdateTaskInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<TaskView> {
  const { task, parent } = await loadMutable(id, actor);

  const data: Parameters<typeof updateTask>[1] = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.assigneeId !== undefined) {
    await validateAssignee(parent.organizationId, input.assigneeId);
    data.assigneeId = input.assigneeId;
  }

  await runInTransaction(async (tx) => {
    await updateTask(task.id, data, tx);
    await writeAudit(
      {
        organizationId: parent.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.TASK_UPDATE,
        entityType: AUDIT_ENTITY.TASK,
        entityId: task.id,
        before: { title: task.title, dueAt: task.dueAt, assigneeId: task.assigneeId },
        after: {
          title: data.title ?? task.title,
          dueAt: data.dueAt ?? task.dueAt,
          assigneeId: data.assigneeId ?? task.assigneeId,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return toView((await findTaskById(task.id)) as TaskWithPeople, parent.label);
}

/** Assigns or reassigns a task (rule T5: the assignee need not be on the parent's team). */
export async function assignTask(
  id: string,
  input: { assigneeId: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<TaskView> {
  const { task, parent } = await loadMutable(id, actor);
  await validateAssignee(parent.organizationId, input.assigneeId);

  await runInTransaction(async (tx) => {
    await updateTask(task.id, { assigneeId: input.assigneeId }, tx);
    await writeAudit(
      {
        organizationId: parent.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.TASK_ASSIGN,
        entityType: AUDIT_ENTITY.TASK,
        entityId: task.id,
        before: { assigneeId: task.assigneeId },
        after: { assigneeId: input.assigneeId },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    if (input.assigneeId) {
      await writeOutboxEvent(
        {
          organizationId: parent.organizationId,
          eventType: OUTBOX_EVENT.TASK_ASSIGNED,
          idempotencyKey: `task.assigned:${task.id}:${input.assigneeId}:${randomUUID()}`,
          payload: { taskId: task.id, assigneeId: input.assigneeId },
        },
        tx,
      );
    }
  });

  return toView((await findTaskById(task.id)) as TaskWithPeople, parent.label);
}

/** The transition table (`docs/24` §3). Every pair not listed returns 409. */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['BLOCKED', 'DONE', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

export interface TransitionTaskInput {
  to: TaskStatus;
  blockedReason?: string;
  reason?: string;
  completionNote?: string;
}

export async function transitionTask(
  id: string,
  input: TransitionTaskInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<TaskView> {
  const { task, parent } = await loadMutable(id, actor);
  const from = task.status;

  if (!ALLOWED_TRANSITIONS[from].includes(input.to)) {
    throw new IllegalTransitionError(`A task cannot move from ${from} to ${input.to}.`);
  }

  const data: Parameters<typeof updateTask>[1] = { status: input.to };

  if (input.to === 'IN_PROGRESS') {
    if (!task.assigneeId) {
      throw new ForbiddenError('Assign the task before starting it.');
    }
    // Leaving BLOCKED clears the block; the reason was recorded in its audit entry.
    data.blockedReason = null;
  }
  if (input.to === 'BLOCKED') {
    if (!input.blockedReason) {
      throw new ConflictError('A blocked task must record why it is blocked.');
    }
    data.blockedReason = input.blockedReason;
  }
  if (input.to === 'DONE') {
    data.completedAt = new Date();
  }
  if (input.to === 'CANCELLED') {
    // Cancellation is a lead action and must carry a reason (`docs/24` §3).
    assertPermission(actor, 'task:cancel');
    if (!input.reason) {
      throw new ConflictError('A reason is required to cancel a task.');
    }
  }

  await runInTransaction(async (tx) => {
    await updateTask(task.id, data, tx);
    await writeAudit(
      {
        organizationId: parent.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action:
          input.to === 'CANCELLED'
            ? AUDIT_ACTION.TASK_CANCEL
            : input.to === 'BLOCKED'
              ? AUDIT_ACTION.TASK_BLOCK
              : AUDIT_ACTION.TASK_TRANSITION,
        entityType: AUDIT_ENTITY.TASK,
        entityId: task.id,
        before: { status: from },
        after: { status: input.to, note: input.completionNote ?? null },
        ...((input.reason ?? input.blockedReason)
          ? { reason: input.reason ?? input.blockedReason }
          : {}),
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    const eventType =
      input.to === 'DONE'
        ? OUTBOX_EVENT.TASK_COMPLETED
        : input.to === 'BLOCKED'
          ? OUTBOX_EVENT.TASK_BLOCKED
          : input.to === 'CANCELLED'
            ? OUTBOX_EVENT.TASK_CANCELLED
            : OUTBOX_EVENT.TASK_ASSIGNED;
    await writeOutboxEvent(
      {
        organizationId: parent.organizationId,
        eventType,
        idempotencyKey: `task.status:${task.id}:${from}:${input.to}:${randomUUID()}`,
        payload: { taskId: task.id, from, to: input.to, parentId: parent.parentId },
      },
      tx,
    );
  });

  return toView((await findTaskById(task.id)) as TaskWithPeople, parent.label);
}
