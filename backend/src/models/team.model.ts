import type { Team, TeamMember, TeamMemberRole } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Team queries — docs/07, F-02.
 *
 * A team is the ownership and routing unit: a request's fulfilling team drives default
 * assignment and team-scoped visibility (docs/07 §6). The catalog references teams as
 * fulfilment owners, so this module exists to validate that reference inside the tenant
 * rather than trusting a client-supplied id.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface TeamWithMembers extends Team {
  members: Array<TeamMember & { user: { id: string; email: string; displayName: string } }>;
}

export function findTeamById(id: string, client: DataClient = prisma): Promise<Team | null> {
  return client.team.findUnique({ where: { id } });
}

export function listTeamsForOrganization(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Team[]> {
  return client.team.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

export function listTeamsWithMembers(
  organizationId: string,
  client: DataClient = prisma,
): Promise<TeamWithMembers[]> {
  return client.team.findMany({
    where: { organizationId },
    include: {
      members: {
        include: { user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

/**
 * One team with its members, scoped to the tenant **inside the query** (ADR-0002).
 *
 * Used by the membership surface rather than loading every team and filtering afterwards:
 * a post-fetch filter is the shape that eventually returns another tenant's row.
 */
export function findTeamWithMembersById(
  id: string,
  organizationId: string,
  client: DataClient = prisma,
): Promise<TeamWithMembers | null> {
  return client.team.findFirst({
    where: { id, organizationId },
    include: {
      members: {
        include: { user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

export function createTeam(
  data: { organizationId: string; name: string; description: string | null },
  client: DataClient = prisma,
): Promise<Team> {
  return client.team.create({ data });
}

export function findTeamByName(
  organizationId: string,
  name: string,
  client: DataClient = prisma,
): Promise<Team | null> {
  return client.team.findFirst({ where: { organizationId, name } });
}

export function addTeamMember(
  data: { teamId: string; userId: string; organizationId: string; role: TeamMemberRole },
  client: DataClient = prisma,
): Promise<TeamMember> {
  return client.teamMember.upsert({
    where: { teamId_userId: { teamId: data.teamId, userId: data.userId } },
    update: { role: data.role },
    create: data,
  });
}

export function removeTeamMember(
  teamId: string,
  userId: string,
  client: DataClient = prisma,
): Promise<void> {
  return client.teamMember
    .delete({ where: { teamId_userId: { teamId, userId } } })
    .then(() => undefined)
    .catch(() => undefined);
}

export function listTeamIdsForUser(
  organizationId: string,
  userId: string,
  client: DataClient = prisma,
): Promise<string[]> {
  return client.teamMember
    .findMany({ where: { organizationId, userId }, select: { teamId: true } })
    .then((rows) => rows.map((row) => row.teamId));
}

/**
 * The user ids on one team.
 *
 * Used by the audit explorer to resolve a lead's scope to the **members** of their teams;
 * it is a predicate for that query, never a post-fetch filter (`docs/31` §5).
 */
export function listTeamMemberUserIds(
  teamId: string,
  client: DataClient = prisma,
): Promise<string[]> {
  return client.teamMember
    .findMany({ where: { teamId }, select: { userId: true } })
    .then((rows) => rows.map((row) => row.userId));
}
