import { apiRequest } from './client';

/**
 * Task API (docs/24 §9, docs/11 §9).
 *
 * Task reads inherit the parent's visibility, so there is no task read permission to
 * model here — the server refuses a task whose parent the caller may not see (`docs/24`
 * rule T2), and the UI treats that as a 404 like any other.
 */

export type TaskParentType = 'REQUEST' | 'INCIDENT';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
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
  overdue: boolean;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  dueAt?: string | null;
}

export function listParentTasks(
  parentType: TaskParentType,
  parentId: string,
  signal?: AbortSignal,
): Promise<{ items: TaskView[] }> {
  const resource = parentType === 'REQUEST' ? 'requests' : 'incidents';
  return apiRequest<{ items: TaskView[] }>(`/${resource}/${parentId}/tasks`, { signal });
}

export function createTask(
  parentType: TaskParentType,
  parentId: string,
  input: CreateTaskInput,
): Promise<{ task: TaskView }> {
  const resource = parentType === 'REQUEST' ? 'requests' : 'incidents';
  return apiRequest<{ task: TaskView }>(`/${resource}/${parentId}/tasks`, {
    method: 'POST',
    body: input,
  });
}

export function listMyTasks(
  params: { cursor?: string; limit?: number; status?: TaskStatus } = {},
  signal?: AbortSignal,
): Promise<CursorPage<TaskView>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<TaskView>>(`/tasks${suffix}`, { signal });
}

export function getTask(id: string, signal?: AbortSignal): Promise<{ task: TaskView }> {
  return apiRequest<{ task: TaskView }>(`/tasks/${id}`, { signal });
}

export function updateTask(
  id: string,
  input: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueAt?: string | null;
  },
): Promise<{ task: TaskView }> {
  return apiRequest<{ task: TaskView }>(`/tasks/${id}`, { method: 'PATCH', body: input });
}

export function assignTask(id: string, assigneeId: string | null): Promise<{ task: TaskView }> {
  return apiRequest<{ task: TaskView }>(`/tasks/${id}/assign`, {
    method: 'POST',
    body: { assigneeId },
  });
}

export function transitionTask(
  id: string,
  input: { to: TaskStatus; blockedReason?: string; reason?: string; completionNote?: string },
): Promise<{ task: TaskView }> {
  return apiRequest<{ task: TaskView }>(`/tasks/${id}/transition`, {
    method: 'POST',
    body: input,
  });
}
