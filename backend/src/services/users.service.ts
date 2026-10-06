import { assertPermission, type Principal } from '../helpers/authorization';
import { DuplicateError, ForbiddenError, NotFoundError } from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  createUser,
  findRoleById,
  findUserByEmail,
  findUserById,
  grantRoleToUser,
  listLiveSessionTokenHashes,
  listRolesForOrganization,
  listUsersForOrganization,
  runInTransaction,
  setUserStatus,
  revokeAllSessionsForUser,
  writeAudit,
  type UserWithRoles,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';
import { issueInvitation } from './invitation.service';
import { invalidateSessionCaches } from './session-cache';

/**
 * Tenant user administration — docs/06 §11, docs/07.
 *
 * These operations are tenant-scoped: the actor must hold `user:manage` **and** belong
 * to the organization the new user is created in. Stage 2 (scope) is enforced by
 * requiring `actor.organizationId` — a platform operator has none and is refused here,
 * which is the docs/07 §5 separation of duties ("a platform operator cannot administer
 * tenant work").
 */

const INVITE_PERMISSION = 'user:manage';

/** A tenant user as shown in the administration list (docs/11 §9). */
export interface TenantUserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  createdAt: Date;
}

/** A role a tenant administrator may assign. Platform roles are never included. */
export interface AssignableRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

/**
 * Lists the users in the caller's tenant (docs/11 §9).
 *
 * Tenant-scoped: the caller must hold `user:manage` **and** belong to an organization,
 * and the predicate is applied in the query (`ADR-0002`), so a platform operator sees
 * nothing here (`07` §5).
 */
export async function listTenantUsers(
  input: { limit: number; cursor?: string },
  actor: Principal,
): Promise<CursorPage<TenantUserSummary>> {
  assertPermission(actor, INVITE_PERMISSION);
  const organizationId = requireTenant(actor);

  const rows = await listUsersForOrganization({ organizationId, ...input });
  const page = buildCursorPage(rows, input.limit, (row) => row.createdAt);

  return {
    items: page.items.map(toTenantUserSummary),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/** Lists the roles a tenant administrator can assign when inviting (docs/11 §9). */
export async function listAssignableRoles(actor: Principal): Promise<AssignableRole[]> {
  assertPermission(actor, INVITE_PERMISSION);
  const organizationId = requireTenant(actor);

  const roles = await listRolesForOrganization(organizationId);
  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
  }));
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    // A platform operator must not administer a tenant (docs/07 §5).
    throw new ForbiddenError('Only a tenant administrator can manage users.');
  }
  return actor.organizationId;
}

function toTenantUserSummary(row: UserWithRoles): TenantUserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    roles: row.userRoles.map((grant) => grant.role.key),
    createdAt: row.createdAt,
  };
}

export interface InvitedUser {
  userId: string;
  email: string;
  invitationId: string;
  expiresAt: Date;
  token: string;
}

export async function inviteUser(
  input: { email: string; roleId: string; displayName?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<InvitedUser> {
  assertPermission(actor, INVITE_PERMISSION);

  const organizationId = actor.organizationId;
  if (!organizationId) {
    // A platform operator must not administer a tenant (docs/07 §5).
    throw new ForbiddenError('Only a tenant administrator can invite users.');
  }

  const role = await findRoleById(input.roleId);
  // A role from another tenant must be indistinguishable from one that does not exist
  // (docs/07 §1: 404 rather than 403 where existence is sensitive).
  if (!role || role.organizationId !== organizationId) {
    throw new NotFoundError('Role not found.');
  }

  let target = await findUserByEmail(input.email);
  if (target && target.organizationId !== organizationId) {
    // Email is globally unique; an address may belong to only one tenant.
    throw new DuplicateError('That email already belongs to another organization.');
  }

  return runInTransaction(async (tx) => {
    if (!target) {
      target = await createUser(
        {
          email: input.email,
          displayName: input.displayName ?? input.email,
          organizationId,
          status: 'INACTIVE',
        },
        tx,
      );
    }

    await grantRoleToUser({ userId: target.id, roleId: role.id, organizationId }, tx);

    const invitation = await issueInvitation(tx, {
      organizationId,
      email: target.email,
      roleId: role.id,
      invitedById: actor.userId,
      meta,
    });

    return {
      userId: target.id,
      email: target.email,
      invitationId: invitation.invitationId,
      expiresAt: invitation.expiresAt,
      token: invitation.token,
    };
  });
}

/**
 * Deactivates a user and kills their live sessions immediately (docs/06 §7, `FR-USER-001`).
 *
 * The identity is retired by status, never hard-deleted: audit-facing entities have no
 * delete path (docs/31 §3.3), and the actor of a historical record must remain resolvable.
 */
export async function deactivateUser(
  userId: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<void> {
  assertPermission(actor, 'user:manage');

  const organizationId = actor.organizationId;
  if (!organizationId) {
    throw new ForbiddenError('Only a tenant administrator can deactivate users.');
  }

  const target = await findUserById(userId);
  // Out-of-tenant access is indistinguishable from absence (docs/07 §1, docs/17).
  if (!target || target.organizationId !== organizationId) {
    throw new NotFoundError('User not found.');
  }

  if (target.id === actor.userId) {
    throw new ForbiddenError('You cannot deactivate your own account.');
  }

  // Capture live session digests before revocation so their shared cache entries can be
  // cleared once the revocation commits (docs/33 C3) — deactivation must be immediate.
  const liveSessionTokenHashes = await listLiveSessionTokenHashes(target.id);

  await runInTransaction(async (tx) => {
    await setUserStatus(target.id, 'INACTIVE', tx);
    await revokeAllSessionsForUser(target.id, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.USER_DEACTIVATED,
        entityType: AUDIT_ENTITY.USER,
        entityId: target.id,
        before: { status: target.status },
        after: { status: 'INACTIVE' },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  await invalidateSessionCaches(liveSessionTokenHashes);
}
