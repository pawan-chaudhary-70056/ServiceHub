import { apiRequest } from './client';

/**
 * Platform administration endpoints (`ADR-0012`, docs/11 §9).
 *
 * These are reachable only by a platform operator, and the server enforces that
 * independently of any UI. The SPA's job is to render what the caller is entitled to
 * see and to surface a denial clearly — never to assume a hidden button is a control.
 */

export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED';

export interface OrganizationSummary {
  id: string;
  name: string;
  nameKey: string;
  slug: string;
  status: OrganizationStatus;
  defaultTimeZone: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformOperator {
  id: string;
  email: string;
  displayName: string;
  status: string;
  createdAt: string;
}

/** Cursor page, mirroring the server's shape (docs/11 §6). The cursor is opaque. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CreatedOrganization {
  organization: OrganizationSummary;
  administrator: { id: string; email: string; displayName: string };
  invitation: {
    invitationId: string;
    expiresAt: string;
    /**
     * Present only outside production (`support.mayDiscloseToken`). In production the
     * link travels solely in the queued email, so the UI must treat it as optional.
     */
    token?: string;
  };
}

export interface CreateOrganizationInput {
  name: string;
  defaultTimeZone?: string;
  administratorEmail: string;
  administratorName: string;
}

export function listOrganizations(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CursorPage<OrganizationSummary>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';

  return apiRequest<CursorPage<OrganizationSummary>>(`/platform/organizations${suffix}`, {
    signal,
  });
}

export function createOrganization(input: CreateOrganizationInput): Promise<CreatedOrganization> {
  return apiRequest<CreatedOrganization>('/platform/organizations', {
    method: 'POST',
    body: input,
  });
}

export function suspendOrganization(id: string): Promise<{ organization: OrganizationSummary }> {
  return apiRequest<{ organization: OrganizationSummary }>(
    `/platform/organizations/${id}/suspend`,
    { method: 'POST' },
  );
}

export function activateOrganization(id: string): Promise<{ organization: OrganizationSummary }> {
  return apiRequest<{ organization: OrganizationSummary }>(
    `/platform/organizations/${id}/activate`,
    { method: 'POST' },
  );
}

export function listOperators(signal?: AbortSignal): Promise<{ items: PlatformOperator[] }> {
  return apiRequest<{ items: PlatformOperator[] }>('/platform/operators', { signal });
}
