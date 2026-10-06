import { apiRequest } from './client';

/**
 * Incident API (docs/23 §10, docs/11 §9).
 *
 * Scope, the derivation matrix and the state machine are enforced server-side; this
 * module only shapes calls and types responses. `derivePriority` is a **UI preview** so
 * the report form can show the consequence of the chosen impact and urgency live
 * (docs/23 §11) — the server derives the authoritative value and the UI must not assume
 * its own arithmetic decided anything.
 */

export type IncidentImpact = 'EXTENSIVE' | 'SIGNIFICANT' | 'MINOR';
export type IncidentUrgency = 'HIGH' | 'MEDIUM' | 'LOW';
export type IncidentStatus = 'NEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type IncidentPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CommentVisibility = 'PUBLIC' | 'INTERNAL';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface IncidentSummary {
  id: string;
  reference: string;
  title: string;
  priority: IncidentPriority;
  status: IncidentStatus;
  isMajor: boolean;
  reporterName: string;
  assigneeName: string | null;
  teamName: string | null;
  slaPolicyName: string;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentDetail {
  id: string;
  reference: string;
  title: string;
  description: string;
  impact: IncidentImpact;
  urgency: IncidentUrgency;
  priority: IncidentPriority;
  isMajor: boolean;
  status: IncidentStatus;
  reporter: { id: string; displayName: string };
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  slaPolicy: { id: string; name: string };
  resolutionSummary: string | null;
  reopenCount: number;
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

/** The impact × urgency matrix from docs/23 §3, mirrored for a live UI preview only. */
export function derivePriority(impact: IncidentImpact, urgency: IncidentUrgency): IncidentPriority {
  const impactRank = impact === 'EXTENSIVE' ? 2 : impact === 'SIGNIFICANT' ? 1 : 0;
  const urgencyRank = urgency === 'HIGH' ? 2 : urgency === 'MEDIUM' ? 1 : 0;
  if (impactRank === 2)
    return urgencyRank === 2 ? 'CRITICAL' : urgencyRank === 1 ? 'HIGH' : 'MEDIUM';
  if (impactRank === 1) return urgencyRank === 2 ? 'HIGH' : urgencyRank === 1 ? 'MEDIUM' : 'LOW';
  return urgencyRank === 2 ? 'MEDIUM' : 'LOW';
}

export function listIncidents(
  params: { cursor?: string; limit?: number; status?: IncidentStatus; majorOnly?: boolean } = {},
  signal?: AbortSignal,
): Promise<CursorPage<IncidentSummary>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  if (params.majorOnly) query.set('majorOnly', 'true');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<IncidentSummary>>(`/incidents${suffix}`, { signal });
}

export function getIncident(
  id: string,
  signal?: AbortSignal,
): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}`, { signal });
}

export function createIncident(input: {
  title: string;
  description: string;
  impact: IncidentImpact;
  urgency: IncidentUrgency;
  teamId?: string | null;
}): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>('/incidents', { method: 'POST', body: input });
}

export function updateIncident(
  id: string,
  input: {
    title?: string;
    description?: string;
    impact?: IncidentImpact;
    urgency?: IncidentUrgency;
    priority?: IncidentPriority;
    reason?: string;
  },
): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function assignIncident(
  id: string,
  input: { assigneeId?: string | null; teamId?: string | null },
): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}/assign`, {
    method: 'POST',
    body: input,
  });
}

export function resolveIncident(
  id: string,
  resolutionSummary: string,
): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}/resolve`, {
    method: 'POST',
    body: { resolutionSummary },
  });
}

export function closeIncident(id: string): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}/close`, { method: 'POST' });
}

export function reopenIncident(id: string, reason?: string): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}/reopen`, {
    method: 'POST',
    body: { reason },
  });
}

export function setIncidentMajor(
  id: string,
  isMajor: boolean,
  reason?: string,
): Promise<{ incident: IncidentDetail }> {
  return apiRequest<{ incident: IncidentDetail }>(`/incidents/${id}/major`, {
    method: 'POST',
    body: { isMajor, reason },
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
  return apiRequest<CursorPage<CommentView>>(`/incidents/${id}/comments${suffix}`, { signal });
}

export interface HistoryEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorType: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export function getHistory(id: string, signal?: AbortSignal): Promise<{ history: HistoryEntry[] }> {
  return apiRequest<{ history: HistoryEntry[] }>(`/incidents/${id}/history`, { signal });
}

export function addComment(
  id: string,
  input: { body: string; visibility: CommentVisibility },
): Promise<{ comment: CommentView }> {
  return apiRequest<{ comment: CommentView }>(`/incidents/${id}/comments`, {
    method: 'POST',
    body: input,
  });
}
