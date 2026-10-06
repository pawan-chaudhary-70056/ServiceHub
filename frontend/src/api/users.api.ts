import { apiRequest } from './client';

/**
 * Tenant user administration (docs/11 §9, docs/06 §11, docs/07 §5).
 *
 * All of these are tenant-scoped on the server: the caller must hold `user:manage` **and**
 * belong to an organization. A platform operator is refused, so the SPA must not present
 * this surface to one — the route guard hides it, and the server enforces it regardless.
 */

export interface TenantUser {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'INACTIVE';
  /** Role keys granted to the user (union — docs/07 §2). */
  roles: string[];
  createdAt: string;
}

/** Cursor page, mirroring the server shape (docs/11 §6). */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** A role a tenant administrator may assign. Platform roles are never returned. */
export interface AssignableRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export interface InvitedUser {
  user: { id: string; email: string };
  invitation: {
    invitationId: string;
    expiresAt: string;
    /** Present only outside production; in production it travels in the email. */
    token?: string;
  };
}

export function listUsers(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CursorPage<TenantUser>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';

  return apiRequest<CursorPage<TenantUser>>(`/users${suffix}`, { signal });
}

export function listAssignableRoles(signal?: AbortSignal): Promise<{ items: AssignableRole[] }> {
  return apiRequest<{ items: AssignableRole[] }>('/roles', { signal });
}

export function inviteUser(input: {
  email: string;
  roleId: string;
  displayName?: string;
}): Promise<InvitedUser> {
  return apiRequest<InvitedUser>('/users', { method: 'POST', body: input });
}

export function deactivateUser(id: string): Promise<void> {
  return apiRequest<void>(`/users/${id}/deactivate`, { method: 'POST' });
}
