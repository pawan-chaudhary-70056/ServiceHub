import type { Organization } from '@prisma/client';
import { assertPermission, type Principal } from '../helpers/authorization';
import { randomToken } from '../helpers/crypto';
import { TENANT_ROLES } from '../helpers/permission-catalogue';
import { DuplicateError, ForbiddenError, NotFoundError } from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  countPlatformOperators,
  createOrganization,
  createRole,
  createUser,
  findOrganizationById,
  findOrganizationByNameKey,
  findOrganizationBySlug,
  findPermissionsByKeys,
  findRoleByKey,
  findUserByEmail,
  grantRoleToUser,
  listOrganizations,
  listPlatformOperators,
  organizationNameKey,
  organizationSlug,
  normalizeOrganizationName,
  runInTransaction,
  setOrganizationStatus,
  setRolePermissions,
  writeAudit,
  type TxClient,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';
import { issueInvitation } from './invitation.service';
import { seedTenantSlaDefaults } from './sla.service';

/**
 * Platform administration — `ADR-0012`, docs/04 §13.2, docs/07.
 *
 * Everything here is guarded by `platform:*` permissions, which only a platform
 * operator holds. The separation of duties from docs/07 §5 is the design constraint:
 * a platform operator provisions a tenant but **cannot** administer it, so this service
 * creates the organization and its first administrator and then stops.
 */

const PLATFORM_PERMISSION = 'platform:organization:manage';
const OPERATOR_PERMISSION = 'platform:operator:manage';

export interface ProvisionedOrganization {
  organization: Organization;
  administrator: { id: string; email: string; displayName: string };
  invitation: { invitationId: string; expiresAt: Date; token: string };
}

/**
 * Creates a tenant and its reference data in one transaction (docs/04 §13.2).
 *
 * The transaction is the invariant: a tenant must never exist half-configured. Roles,
 * the first administrator's role grant, the invitation and both audit records either
 * all land or none do.
 */
export async function provisionOrganization(
  input: {
    name: string;
    defaultTimeZone: string;
    administratorEmail: string;
    administratorName: string;
  },
  actor: Principal,
  meta: RequestMeta,
): Promise<ProvisionedOrganization> {
  assertPermission(actor, PLATFORM_PERMISSION);

  const name = normalizeOrganizationName(input.name);
  const nameKey = organizationNameKey(input.name);

  return runInTransaction(async (tx) => {
    if (await findOrganizationByNameKey(nameKey, tx)) {
      throw new DuplicateError('An organization with that name already exists.');
    }

    // Emails are globally unique, so a second tenant cannot claim an existing identity.
    if (await findUserByEmail(input.administratorEmail, tx)) {
      throw new DuplicateError('That administrator email is already in use.');
    }

    const organization = await createOrganization(
      {
        name,
        nameKey,
        slug: await uniqueSlug(name, tx),
        defaultTimeZone: input.defaultTimeZone,
      },
      tx,
    );

    await seedTenantRoles(organization.id, tx);
    // Seed a default calendar and policy so the tenant can activate catalog items
    // immediately (rule C1 needs an SLA policy to exist; docs/25 §8 fallback).
    await seedTenantSlaDefaults(organization.id, organization.defaultTimeZone, tx);

    const administratorRole = await findRoleByKey('ADMINISTRATOR', organization.id, tx);
    if (!administratorRole) {
      // Only possible if seeding above failed to create it, which should be impossible.
      throw new NotFoundError('The tenant administrator role could not be created.');
    }

    // Created INACTIVE: the identity holds nothing until the invitation is accepted and
    // a credential exists (docs/06 §11 rule 5).
    const administrator = await createUser(
      {
        email: input.administratorEmail,
        displayName: input.administratorName,
        organizationId: organization.id,
        status: 'INACTIVE',
      },
      tx,
    );

    await grantRoleToUser(
      { userId: administrator.id, roleId: administratorRole.id, organizationId: organization.id },
      tx,
    );

    const invitation = await issueInvitation(tx, {
      organizationId: organization.id,
      email: administrator.email,
      roleId: administratorRole.id,
      invitedById: actor.userId,
      meta,
    });

    await writeAudit(
      {
        organizationId: organization.id,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ORGANIZATION_CREATE,
        entityType: AUDIT_ENTITY.ORGANIZATION,
        entityId: organization.id,
        after: { name: organization.name, slug: organization.slug },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );

    return {
      organization,
      administrator: {
        id: administrator.id,
        email: administrator.email,
        displayName: administrator.displayName,
      },
      invitation: {
        invitationId: invitation.invitationId,
        expiresAt: invitation.expiresAt,
        token: invitation.token,
      },
    };
  });
}

export function listOrganizationsPage(
  input: { limit: number; cursor?: string },
  actor: Principal,
): Promise<CursorPage<Organization>> {
  assertPermission(actor, PLATFORM_PERMISSION);
  return listOrganizations(input).then((rows) =>
    buildCursorPage(rows, input.limit, (row) => row.createdAt),
  );
}

export function suspendOrganization(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<Organization> {
  return changeOrganizationStatus(id, 'SUSPENDED', actor, meta);
}

export function activateOrganization(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<Organization> {
  return changeOrganizationStatus(id, 'ACTIVE', actor, meta);
}

export async function listOperators(
  actor: Principal,
): Promise<
  Array<{ id: string; email: string; displayName: string; status: string; createdAt: Date }>
> {
  assertPermission(actor, OPERATOR_PERMISSION);
  const operators = await listPlatformOperators();
  return operators.map((operator) => ({
    id: operator.id,
    email: operator.email,
    displayName: operator.displayName,
    status: operator.status,
    createdAt: operator.createdAt,
  }));
}

/** Whether the platform has been bootstrapped yet — used by the first-run screen. */
export async function platformStatus(): Promise<{ hasOperator: boolean; operatorCount: number }> {
  const operatorCount = await countPlatformOperators();
  return { hasOperator: operatorCount > 0, operatorCount };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function changeOrganizationStatus(
  id: string,
  status: 'ACTIVE' | 'SUSPENDED',
  actor: Principal,
  meta: RequestMeta,
): Promise<Organization> {
  assertPermission(actor, PLATFORM_PERMISSION);

  const organization = await findOrganizationById(id);
  if (!organization) {
    throw new NotFoundError('Organization not found.');
  }

  return runInTransaction(async (tx) => {
    const updated = await setOrganizationStatus(id, status, tx);
    await writeAudit(
      {
        organizationId: id,
        actorId: actor.userId,
        actorType: 'USER',
        action:
          status === 'SUSPENDED'
            ? AUDIT_ACTION.ORGANIZATION_SUSPEND
            : AUDIT_ACTION.ORGANIZATION_ACTIVATE,
        entityType: AUDIT_ENTITY.ORGANIZATION,
        entityId: id,
        before: { status: organization.status },
        after: { status },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return updated;
  });
}

/**
 * Seeds the tenant's default roles and their permission grants (docs/07 §3).
 *
 * Seeded per organization, not globally, so a tenant may adjust its own matrix without
 * affecting others (docs/07 §3, `ADR-0012`).
 */
async function seedTenantRoles(organizationId: string, tx: TxClient): Promise<void> {
  for (const definition of TENANT_ROLES) {
    const role = await createRole(
      {
        organizationId,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
      tx,
    );

    const permissions = await findPermissionsByKeys(definition.permissions, tx);
    if (permissions.length !== definition.permissions.length) {
      // A missing permission means the seeded catalogue is out of step with the database.
      // Failing loudly beats provisioning a tenant with silently-reduced roles.
      const found = new Set(permissions.map((permission) => permission.key));
      const missing = definition.permissions.filter((key) => !found.has(key));
      throw new NotFoundError(
        `Permission catalogue is incomplete; missing: ${missing.join(', ')}.`,
      );
    }

    await setRolePermissions(
      role.id,
      permissions.map((permission) => permission.id),
      tx,
    );
  }
}

async function uniqueSlug(name: string, tx: TxClient): Promise<string> {
  const base = organizationSlug(name) || 'tenant';
  if (!(await findOrganizationBySlug(base, tx))) {
    return base;
  }
  // The unique index is the real guarantee; this only avoids a collision the common case.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${base}-${randomToken(4).toLowerCase()}`.slice(0, 70);
    if (!(await findOrganizationBySlug(candidate, tx))) {
      return candidate;
    }
  }
  throw new ForbiddenError('Could not allocate a unique organization slug.');
}
