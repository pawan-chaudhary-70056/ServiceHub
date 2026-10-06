import type { Credential, Prisma, User, UserStatus } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * User, credential and entitlement queries — docs/06, docs/07.
 *
 * Two responsibilities that belong together because they are read together on every
 * authenticated request:
 *
 *   1. Identity/credential state (lockout counters, status, password hash).
 *   2. **Entitlement resolution.** Docs/06 §7 is explicit that entitlements are resolved
 *      per request from the database, never cached in the session, so revoking a role
 *      takes effect on the very next request. The join below is that resolution.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

/** Stored normalised lower-case so the unique index is case-insensitive in effect. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findUserByEmail(email: string, client: DataClient = prisma): Promise<User | null> {
  return client.user.findUnique({ where: { email: normalizeEmail(email) } });
}

export function findUserById(id: string, client: DataClient = prisma): Promise<User | null> {
  return client.user.findUnique({ where: { id } });
}

export function createUser(
  data: {
    email: string;
    displayName: string;
    organizationId: string | null;
    status?: UserStatus;
    timeZone?: string;
  },
  client: DataClient = prisma,
): Promise<User> {
  return client.user.create({
    data: { ...data, email: normalizeEmail(data.email) },
  });
}

export function setUserStatus(
  id: string,
  status: UserStatus,
  client: DataClient = prisma,
): Promise<User> {
  return client.user.update({ where: { id }, data: { status } });
}

/** A tenant user with the role keys granted to them, for the admin list (docs/11 §9). */
export type UserWithRoles = Prisma.UserGetPayload<{
  include: { userRoles: { select: { role: { select: { key: true; name: true } } } } };
}>;

/**
 * Lists a tenant's users, newest-first, cursor-paginated (`docs/11` §6).
 *
 * The mandatory tenant predicate is applied **inside** the query (`ADR-0002`), never as a
 * post-fetch filter, and roles are eager-loaded to avoid an N+1 while rendering a list.
 * Fetches `limit + 1` so `hasMore` needs no second count query.
 */
export function listUsersForOrganization(
  params: { organizationId: string; limit: number; cursor?: string },
  client: DataClient = prisma,
): Promise<UserWithRoles[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  return client.user.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(sortValue) } },
              { createdAt: new Date(sortValue), id: { lt: id } },
            ],
          }
        : {}),
    },
    include: {
      userRoles: { select: { role: { select: { key: true, name: true } } } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}

/** Platform operators belong to no organization (`ADR-0012`). */
export function listPlatformOperators(client: DataClient = prisma): Promise<User[]> {
  return client.user.findMany({
    where: { organizationId: null },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 100,
  });
}

export function countPlatformOperators(client: DataClient = prisma): Promise<number> {
  return client.user.count({ where: { organizationId: null } });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function findCredentialByUserId(
  userId: string,
  client: DataClient = prisma,
): Promise<Credential | null> {
  return client.credential.findUnique({ where: { userId } });
}

export function createCredential(
  data: { userId: string; passwordHash: string },
  client: DataClient = prisma,
): Promise<Credential> {
  return client.credential.create({ data });
}

/**
 * Upsert a credential, used by invitation acceptance and password reset where the row
 * may or may not already exist.
 */
export function upsertCredential(
  data: { userId: string; passwordHash: string },
  client: DataClient = prisma,
): Promise<Credential> {
  return client.credential.upsert({
    where: { userId: data.userId },
    create: { userId: data.userId, passwordHash: data.passwordHash },
    update: {
      passwordHash: data.passwordHash,
      passwordChangedAt: new Date(),
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
}

/**
 * Records a failed login and applies lockout once the threshold is reached.
 *
 * The counter is incremented in the database (`increment`), not read-modify-written in
 * application code, so two concurrent failures cannot both read the old value and
 * undercount — which would let an attacker land extra attempts before lockout.
 */
export async function recordFailedAttempt(
  userId: string,
  params: { maxAttempts: number; lockMinutes: number },
  client: DataClient = prisma,
): Promise<Credential> {
  const incremented = await client.credential.update({
    where: { userId },
    data: { failedAttempts: { increment: 1 } },
  });

  if (incremented.failedAttempts < params.maxAttempts) {
    return incremented;
  }

  return client.credential.update({
    where: { userId },
    data: { lockedUntil: new Date(Date.now() + params.lockMinutes * 60_000) },
  });
}

/** Clears the failure counter on a successful login (backoff resets — docs/06 §6). */
export function clearFailedAttempts(
  userId: string,
  client: DataClient = prisma,
): Promise<Credential> {
  return client.credential.update({
    where: { userId },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}

// ---------------------------------------------------------------------------
// Entitlement resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the effective permission set for a user (docs/07 §2 — roles are a union).
 *
 * Resolved per request, not stored in the session (docs/06 §7). The join is deliberately
 * narrow: only permission keys are selected, because the caller needs a set-membership
 * test, not the full role graph.
 */
export async function resolvePermissionKeys(
  userId: string,
  client: DataClient = prisma,
): Promise<Set<string>> {
  const grants = await client.userRole.findMany({
    where: { userId },
    select: {
      role: {
        select: {
          rolePermissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  });

  const keys = new Set<string>();
  for (const grant of grants) {
    for (const rolePermission of grant.role.rolePermissions) {
      keys.add(rolePermission.permission.key);
    }
  }
  return keys;
}
