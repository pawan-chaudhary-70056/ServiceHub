import { assertPermission, type Principal } from '../helpers/authorization';
import type { TeamMemberRole } from '@prisma/client';
import {
  addTeamMember,
  createTeam,
  findTeamByName,
  findTeamWithMembersById,
  findUserById,
  listTeamMemberUserIds,
  listTeamsForOrganization,
  removeTeamMember,
  runInTransaction,
  writeAudit,
  type TeamWithMembers,
} from '../models';
import { DuplicateError, NotFoundError, ValidationError } from '../utils/errors';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Teams — docs/07, F-02.
 *
 * Teams are the ownership and routing unit: a catalog item's fulfilment team becomes the
 * request's default owning team (docs/21 §7), and team membership is what makes
 * `request:read.team` and `request:update.assigned` resolve to a real set of records
 * (docs/07 §6). Reading the team list needs only `catalog:read`, because a requester must
 * be able to see which teams exist to route work to them. **Administration** — creating a
 * team and changing its membership — is user administration and therefore takes
 * `user:manage` (docs/07 §3, the `User manage` row): it widens who can see and update
 * records, so it is not a side effect of browsing the catalog.
 *
 * Scoping is by the caller's tenant on every path. A team from another tenant is `404`,
 * never `403` (docs/17 §5), and a member must already belong to the same tenant, so a
 * membership row can never bridge two tenants.
 */

const READ_PERMISSION = 'catalog:read';
const MANAGE_PERMISSION = 'user:manage';

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface TeamMemberView {
  userId: string;
  email: string;
  displayName: string;
  role: TeamMemberRole;
  addedAt: string;
}

export interface TeamDetail extends TeamSummary {
  members: TeamMemberView[];
}

export async function listTeams(actor: Principal): Promise<TeamSummary[]> {
  assertPermission(actor, READ_PERMISSION);
  if (!actor.organizationId) {
    throw new NotFoundError('Only a tenant member can list teams.');
  }

  const teams = await listTeamsForOrganization(actor.organizationId);
  return teams.map(toSummary);
}

/** Resolves a team inside the caller's tenant, or NOT_FOUND. */
async function loadTeam(teamId: string, actor: Principal): Promise<TeamWithMembers> {
  assertPermission(actor, MANAGE_PERMISSION);
  if (!actor.organizationId) {
    throw new NotFoundError('Only a tenant member can manage teams.');
  }

  const team = await findTeamWithMembersById(teamId, actor.organizationId);
  if (!team) {
    throw new NotFoundError('Team not found.');
  }
  return team;
}

function toSummary(team: {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}): TeamSummary {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    isActive: team.isActive,
  };
}

function toDetail(team: TeamWithMembers): TeamDetail {
  return {
    ...toSummary(team),
    members: team.members.map((member) => ({
      userId: member.userId,
      email: member.user.email,
      displayName: member.user.displayName,
      role: member.role,
      addedAt: member.createdAt.toISOString(),
    })),
  };
}

/** `GET /teams/{id}/members` — the team and its members (administration view). */
export async function getTeamMembers(teamId: string, actor: Principal): Promise<TeamDetail> {
  return toDetail(await loadTeam(teamId, actor));
}

/**
 * `POST /teams` — creates a team (docs/21 §7 needs one to route to).
 *
 * Names are unique per tenant: two teams with the same name make a routing picker
 * ambiguous, which is a correctness problem rather than a cosmetic one.
 */
export async function createTeamRecord(
  input: { name: string; description?: string | null },
  actor: Principal,
  meta: RequestMeta,
): Promise<TeamDetail> {
  assertPermission(actor, MANAGE_PERMISSION);
  if (!actor.organizationId) {
    throw new NotFoundError('Only a tenant member can create a team.');
  }
  const organizationId = actor.organizationId;

  if (await findTeamByName(organizationId, input.name)) {
    throw new DuplicateError('A team with that name already exists.');
  }

  const created = await runInTransaction(async (tx) => {
    const team = await createTeam(
      { organizationId, name: input.name, description: input.description ?? null },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.TEAM_CREATE,
        entityType: AUDIT_ENTITY.TEAM,
        entityId: team.id,
        after: { name: team.name },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return team;
  });

  return { ...toSummary(created), members: [] };
}

/**
 * `POST /teams/{id}/members` — adds or re-roles a member.
 *
 * The target must be an active member of the **same tenant**: membership is what grants
 * team-scoped visibility, so accepting a foreign user id here would be a cross-tenant
 * leak in one query (ADR-0002).
 */
export async function addMember(
  teamId: string,
  input: { userId: string; role: TeamMemberRole },
  actor: Principal,
  meta: RequestMeta,
): Promise<TeamDetail> {
  const team = await loadTeam(teamId, actor);

  const user = await findUserById(input.userId);
  if (!user || user.organizationId !== team.organizationId) {
    throw new ValidationError([
      { field: 'userId', code: 'UNKNOWN_USER', message: 'That user is not in this organization.' },
    ]);
  }
  if (user.status !== 'ACTIVE') {
    throw new ValidationError([
      {
        field: 'userId',
        code: 'INACTIVE_USER',
        message: 'A deactivated user cannot be added to a team.',
      },
    ]);
  }

  await runInTransaction(async (tx) => {
    await addTeamMember(
      { teamId: team.id, userId: user.id, organizationId: team.organizationId, role: input.role },
      tx,
    );
    await writeAudit(
      {
        organizationId: team.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.TEAM_MEMBER_ADD,
        entityType: AUDIT_ENTITY.TEAM,
        entityId: team.id,
        after: { userId: user.id, role: input.role },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  return toDetail(await loadTeam(team.id, actor));
}

/**
 * `DELETE /teams/{id}/members/{userId}` — removes a member.
 *
 * Idempotent: removing someone who is not a member succeeds, because the requested end
 * state already holds. The audit record names the removal so the change is explainable
 * afterwards even when it was a no-op.
 */
export async function removeMember(
  teamId: string,
  userId: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<void> {
  const team = await loadTeam(teamId, actor);
  const members = await listTeamMemberUserIds(team.id);
  const wasMember = members.includes(userId);

  await runInTransaction(async (tx) => {
    await removeTeamMember(team.id, userId, tx);
    await writeAudit(
      {
        organizationId: team.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.TEAM_MEMBER_REMOVE,
        entityType: AUDIT_ENTITY.TEAM,
        entityId: team.id,
        after: { userId, wasMember },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });
}
