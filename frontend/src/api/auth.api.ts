import { apiRequest } from './client';

/**
 * Identity endpoints (docs/06, docs/11 §9).
 *
 * The SPA never sees, stores or sends a session token. `login` relies on the server's
 * `Set-Cookie` and every request uses `credentials: 'include'` (in the client), so the
 * session is opaque to the browser bundle and unreachable from script (`ADR-0001`).
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  organizationId: string | null;
  isPlatformOperator: boolean;
}

/** `POST /auth/login` — the created session plus the caller's effective entitlements. */
export interface SessionResponse {
  user: AuthenticatedUser;
  permissions: string[];
}

/** `GET /auth/me` — the identity, which additionally carries its current status. */
export interface MeResponse {
  user: AuthenticatedUser & { status: string };
  permissions: string[];
}

export function login(email: string, password: string): Promise<SessionResponse> {
  return apiRequest<SessionResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

export function logout(): Promise<void> {
  return apiRequest<void>('/auth/logout', { method: 'POST' });
}

export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest<MeResponse>('/auth/me', { signal });
}

/**
 * One of the caller's live sessions (`docs/06` §7). Deliberately carries no token or
 * digest: the id is enough to revoke, and nothing here should be a credential in a
 * screenshot or a log.
 */
export interface SessionView {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  sourceIp: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * `GET /auth/sessions` — the caller's own sessions.
 *
 * There is no parameter to pass a user id: the server keys the query on the
 * authenticated identity, so the UI cannot ask about anyone else.
 */
export function listSessions(signal?: AbortSignal): Promise<{ items: SessionView[] }> {
  return apiRequest<{ items: SessionView[] }>('/auth/sessions', { signal });
}

/** `DELETE /auth/sessions/{id}` — revokes one session, immediately and server-side. */
export function revokeSession(id: string): Promise<void> {
  return apiRequest<void>(`/auth/sessions/${id}`, { method: 'DELETE' });
}

/**
 * Requests a password reset. Always resolves: the server returns `202` whether or not
 * the address exists, and the UI must not imply otherwise (docs/06 §5).
 */
export function requestPasswordReset(email: string): Promise<{ status: string }> {
  return apiRequest<{ status: string }>('/auth/forgot', { method: 'POST', body: { email } });
}

export function resetPassword(token: string, password: string): Promise<void> {
  return apiRequest<void>('/auth/reset', { method: 'POST', body: { token, password } });
}

/**
 * Accepts an invitation, establishing the first credential for an invited identity
 * (docs/06 §11). The token comes from the invitation link and grants no authority on
 * its own.
 */
export function acceptInvitation(
  token: string,
  password: string,
  displayName?: string,
): Promise<void> {
  return apiRequest<void>('/auth/accept-invitation', {
    method: 'POST',
    body: displayName ? { token, password, displayName } : { token, password },
  });
}
