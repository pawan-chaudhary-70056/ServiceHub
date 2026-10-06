import type { Permission, Role } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Role, permission and grant queries — docs/07.
 *
 * Permissions are **data, not literals** (docs/07 §1): a service asks whether the caller
 * holds a permission key, and the mapping lives in these tables. Roles are scoped by
 * `organizationId` — null means a platform-scoped role (Super Admin, `ADR-0012`), and a
 * tenant role is seeded per organization at provisioning (docs/04 §13.2).
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export function findRoleByKey(
  key: string,
  organizationId: string | null,
  client: DataClient = prisma,
): Promise<Role | null> {
  return client.role.findFirst({ where: { key, organizationId } });
}

export function findRoleById(id: string, client: DataClient = prisma): Promise<Role | null> {
  return client.role.findUnique({ where: { id } });
}

export function createRole(
  data: {
    organizationId: string | null;
    key: string;
    name: string;
    description?: string | null;
    isSystem?: boolean;
  },
  client: DataClient = prisma,
): Promise<Role> {
  return client.role.create({ data });
}

/**
 * Lists the roles that belong to one tenant, for the invite role picker (`docs/11` §9).
 *
 * Scoped to the organization by predicate, so platform-scoped roles (`organizationId`
 * null) can never be selected by a tenant administrator (`ADR-0012`, `07` §5).
 */
export function listRolesForOrganization(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Role[]> {
  return client.role.findMany({
    where: { organizationId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

/** Looks up the permission ids for a set of keys, for role seeding. */
export function findPermissionsByKeys(
  keys: readonly string[],
  client: DataClient = prisma,
): Promise<Permission[]> {
  return client.permission.findMany({ where: { key: { in: [...keys] } } });
}

/** Replaces a role's permission set (docs/11 §9 `PUT /roles/{id}/permissions`). */
export async function setRolePermissions(
  roleId: string,
  permissionIds: readonly string[],
  client: DataClient = prisma,
): Promise<number> {
  await client.rolePermission.deleteMany({ where: { roleId } });
  if (permissionIds.length === 0) {
    return 0;
  }
  const result = await client.rolePermission.createMany({
    data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Grants a role to a user. Idempotent on the `(userId, roleId)` unique constraint, so a
 * repeated grant is a no-op rather than a duplicate row (roles are a union — docs/07 §2).
 */
export function grantRoleToUser(
  data: { userId: string; roleId: string; organizationId: string | null },
  client: DataClient = prisma,
): Promise<void> {
  return client.userRole
    .create({ data })
    .then(() => undefined)
    .catch((error: unknown) => {
      // P2002 = unique constraint. A second identical grant is not an error.
      if (isUniqueViolation(error)) {
        return;
      }
      throw error;
    });
}

/**
 * Active user ids holding a given role key in one tenant.
 *
 * Used to **snapshot** approvers at workflow instantiation (`docs/26` rule A2): the
 * resolution happens once, at that moment, so a later role edit cannot silently change
 * who was asked to approve.
 */
export async function listActiveUserIdsWithRoleKey(
  organizationId: string,
  roleKey: string,
  client: DataClient = prisma,
): Promise<string[]> {
  const rows = await client.userRole.findMany({
    where: {
      organizationId,
      user: { status: 'ACTIVE' },
      role: { key: roleKey, organizationId },
    },
    select: { userId: true },
  });
  return [...new Set(rows.map((row) => row.userId))];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
