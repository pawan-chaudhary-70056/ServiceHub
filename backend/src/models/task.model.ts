import type { Prisma, Task, TaskParentType, TaskStatus } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Task data access — docs/24, F-07.
 *
 * A task's parent is polymorphic (`parentType`, `parentId`), so there is deliberately no
 * foreign key to `ServiceRequest` or `Incident`; rule T1 (exactly one parent of a
 * permitted type) is enforced in the service, which also owns the parent-visibility
 * predicate (rule T2). What the database owns is the `tasks_blocked_reason_required`
 * CHECK constraint: a `BLOCKED` task must record why (`docs/24` §3).
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

export interface TaskWithPeople extends Task {
  assignee: { id: string; email: string; displayName: string } | null;
  createdBy: { id: string; email: string; displayName: string };
}

const TASK_INCLUDE = {
  assignee: { select: { id: true, email: true, displayName: true } },
  createdBy: { select: { id: true, email: true, displayName: true } },
} satisfies Prisma.TaskInclude;

/** Open = not terminal. Used for the roll-up rule (§4) and the open-task cap (T8). */
export const OPEN_TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED'];

export function createTask(
  data: {
    organizationId: string;
    parentType: TaskParentType;
    parentId: string;
    title: string;
    description: string | null;
    assigneeId: string | null;
    createdById: string;
    dueAt: Date | null;
  },
  client: DataClient = prisma,
): Promise<Task> {
  return client.task.create({ data });
}

export function findTaskById(
  id: string,
  client: DataClient = prisma,
): Promise<TaskWithPeople | null> {
  return client.task.findUnique({ where: { id }, include: TASK_INCLUDE });
}

export function listTasksForParent(
  parentType: TaskParentType,
  parentId: string,
  client: DataClient = prisma,
): Promise<TaskWithPeople[]> {
  return client.task.findMany({
    where: { parentType, parentId },
    include: TASK_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export function listTasksForAssignee(
  params: {
    organizationId: string;
    assigneeId: string;
    status?: TaskStatus;
    limit: number;
    cursor?: string;
  },
  client: DataClient = prisma,
): Promise<TaskWithPeople[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  return client.task.findMany({
    where: {
      organizationId: params.organizationId,
      assigneeId: params.assigneeId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(sortValue) } },
              { createdAt: new Date(sortValue), id: { lt: id } },
            ],
          }
        : {}),
    },
    include: TASK_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}

/**
 * The number of open children for a parent. This is the query behind the roll-up rule
 * (`docs/24` §4): a parent may not be fulfilled/resolved with open children unless an
 * override is recorded. It lives here, in the data layer, so a parent service can apply
 * the rule without depending on the task *module* (`docs/03` §4 keeps the dependency
 * direction task → parent, never the reverse).
 */
export function countOpenTasksForParent(
  parentType: TaskParentType,
  parentId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.task.count({
    where: { parentType, parentId, status: { in: OPEN_TASK_STATUSES } },
  });
}

export function updateTask(
  id: string,
  data: Partial<{
    title: string;
    description: string | null;
    status: TaskStatus;
    assigneeId: string | null;
    dueAt: Date | null;
    completedAt: Date | null;
    blockedReason: string | null;
  }>,
  client: DataClient = prisma,
): Promise<Task> {
  return client.task.update({ where: { id }, data });
}
