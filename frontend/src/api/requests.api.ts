import { apiRequest } from './client';
import type { SlaClock } from './sla.api';

/**
 * Service request API (docs/22 §11, docs/11 §9).
 *
 * Scope and the state machine are enforced server-side; this module only shapes calls and
 * types responses. The UI must never assume a control is a permission — the server
 * independently refuses anything the caller may not do (docs/07 §6).
 */

export type RequestStatus =
  | 'NEW'
  | 'TRIAGED'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'IN_PROGRESS'
  | 'FULFILLED'
  | 'CLOSED'
  | 'CANCELLED';

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CommentVisibility = 'PUBLIC' | 'INTERNAL';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
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
  /**
   * The live clock, or null for a record with none (`docs/25` §12). `docs/22` §14 AC5 needs
   * the SLA state in the **list**, which is why this is on the summary and not only on the
   * detail.
   */
  sla: SlaClock | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestDetail {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  status: RequestStatus;
  priority: Priority;
  /** `requiresApproval` decides whether the approval transition is offered (docs/22 §3). */
  catalogItem: { id: string; name: string; requiresApproval: boolean };
  requester: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  slaPolicy: { id: string; name: string };
  /** The live clock (state plus time remaining), or null when the clock has stopped. */
  sla: SlaClock | null;
  fields: Array<{
    key: string;
    label: string;
    fieldType: string;
    value: unknown;
    displayOrder: number;
  }>;
  submittedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentView {
  id: string;
  body: string;
  visibility: CommentVisibility;
  author: { id: string; displayName: string };
  createdAt: string;
}

export function listRequests(
  params: { cursor?: string; limit?: number; status?: RequestStatus } = {},
  signal?: AbortSignal,
): Promise<CursorPage<RequestSummary>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<RequestSummary>>(`/requests${suffix}`, { signal });
}

export function getRequest(id: string, signal?: AbortSignal): Promise<{ request: RequestDetail }> {
  return apiRequest<{ request: RequestDetail }>(`/requests/${id}`, { signal });
}

export function createRequest(input: {
  catalogItemId: string;
  title: string;
  description?: string | null;
  fields?: Record<string, unknown>;
}): Promise<{ request: RequestDetail }> {
  return apiRequest<{ request: RequestDetail }>('/requests', { method: 'POST', body: input });
}

export function transitionRequest(
  id: string,
  input: { to: RequestStatus; reason?: string; fulfilmentNote?: string },
): Promise<{ request: RequestDetail }> {
  return apiRequest<{ request: RequestDetail }>(`/requests/${id}/transition`, {
    method: 'POST',
    body: input,
  });
}

export function assignRequest(
  id: string,
  input: { assigneeId?: string | null; teamId?: string | null },
): Promise<{ request: RequestDetail }> {
  return apiRequest<{ request: RequestDetail }>(`/requests/${id}/assign`, {
    method: 'POST',
    body: input,
  });
}

export function cancelRequest(id: string, reason?: string): Promise<{ request: RequestDetail }> {
  return apiRequest<{ request: RequestDetail }>(`/requests/${id}/cancel`, {
    method: 'POST',
    body: { reason },
  });
}

export function listComments(
  id: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CursorPage<CommentView>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<CommentView>>(`/requests/${id}/comments${suffix}`, { signal });
}

export function addComment(
  id: string,
  input: { body: string; visibility: CommentVisibility },
): Promise<{ comment: CommentView }> {
  return apiRequest<{ comment: CommentView }>(`/requests/${id}/comments`, {
    method: 'POST',
    body: input,
  });
}
