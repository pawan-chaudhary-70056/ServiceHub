import { apiRequest } from './client';

/**
 * Team administration (docs/11 §9, docs/07 §6).
 *
 * Reading the team list needs only `catalog:read` — every member sees which teams exist to
 * route work to them. Everything that changes membership needs `user:manage`, because
 * membership is what grants team-scoped visibility over records (docs/07 §6). The server
 * enforces both and scopes every call to the caller's tenant; a team from another tenant is
 * a `404`, indistinguishable from one that does not exist (docs/17 §5).
 */

/** A team as it appears in the routing/administration list. */
export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

/** Membership role. `LEAD` is the team-level escalation role (docs/07 §6). */
export type TeamMemberRole = 'MEMBER' | 'LEAD';

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: TeamMemberRole;
  addedAt: string;
}

/** A team with its membership — the administration view. */
export interface TeamDetail extends TeamSummary {
  members: TeamMember[];
}

export function listTeams(signal?: AbortSignal): Promise<{ items: TeamSummary[] }> {
  return apiRequest<{ items: TeamSummary[] }>('/teams', { signal });
}

export function getTeam(id: string, signal?: AbortSignal): Promise<{ team: TeamDetail }> {
  return apiRequest<{ team: TeamDetail }>(`/teams/${id}/members`, { signal });
}

export function createTeam(input: {
  name: string;
  description?: string | null;
}): Promise<{ team: TeamDetail }> {
  return apiRequest<{ team: TeamDetail }>('/teams', { method: 'POST', body: input });
}

/** Adds a member, or changes an existing member's role (the server upserts — docs/07 §6). */
export function addTeamMember(
  teamId: string,
  input: { userId: string; role: TeamMemberRole },
): Promise<{ team: TeamDetail }> {
  return apiRequest<{ team: TeamDetail }>(`/teams/${teamId}/members`, {
    method: 'POST',
    body: input,
  });
}

/** Removal is idempotent server-side: removing a non-member is a recorded no-op. */
export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  return apiRequest<void>(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
}
