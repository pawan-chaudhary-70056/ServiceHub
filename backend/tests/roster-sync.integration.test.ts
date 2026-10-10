import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { createFakeDirectoryAdapter } from '../src/integrations/directory';
import { createUser, disconnectDatabase, findUserById, prisma } from '../src/models';
import { createOrganization } from '../src/models/organization.model';
import { syncRoster } from '../src/services/roster-sync.service';

/**
 * Roster sync — integration tests (docs/37 §3, docs/32 §6).
 *
 * The reconciliation rules are the test surface, because each is a way a directory integration
 * can lose or corrupt user data:
 *
 *   - identity is keyed on the **immutable external id**, not email;
 *   - a person missing from the roster is **deactivated, never deleted**;
 *   - the **drift guard** refuses a large removal instead of applying it;
 *   - a run is **idempotent**, so it is safe to run on a schedule.
 *
 * The domain adapter is injected, so the run is exercised without a directory (`docs/37` §3).
 */

let databaseAvailable = false;

function dbIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async (ctx) => {
    if (!databaseAvailable) {
      ctx.skip();
    }
    await fn();
  });
}

async function seedReferenceData(): Promise<void> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {
        resource: permission.resource,
        action: permission.action,
        description: permission.description,
      },
      create: permission,
    });
  }
  for (const role of PLATFORM_ROLES) {
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, key: role.key },
    });
    const row = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: role.name, description: role.description, isSystem: true },
        })
      : await prisma.role.create({
          data: {
            organizationId: null,
            key: role.key,
            name: role.name,
            description: role.description,
            isSystem: true,
          },
        });
    for (const key of role.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: row.id, permissionId: permission.id } },
        update: {},
        create: { roleId: row.id, permissionId: permission.id },
      });
    }
  }
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE
       directory_user_mappings, directory_sync_states,
       inbound_webhook_events, inbound_webhook_endpoints,
       webhook_deliveries, webhook_subscriptions, webhook_fanout_states,
       report_exports, notification_preferences, notifications, tasks, incidents,
       request_field_values, service_requests, comments,
       reference_sequences, catalog_item_fields, catalog_items, categories, sla_targets,
       sla_policies, business_calendars, sla_clocks,
       sessions, password_reset_tokens, invitations, user_roles, role_permissions,
       teams, team_members, audit_logs, outbox, job_records, credentials, users,
       roles, permissions, organizations
     RESTART IDENTITY CASCADE`,
  );
  await seedReferenceData();
}

describe('Roster sync', () => {
  let organizationId = '';

  beforeAll(async () => {
    try {
      await prisma.permission.count();
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      return;
    }
    await resetDatabase();
    const organization = await createOrganization({
      name: 'Initech Roster',
      nameKey: 'initech roster',
      slug: 'initech-roster',
      defaultTimeZone: 'Europe/London',
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await disconnectDatabase().catch(() => undefined);
  });

  const ANA = {
    externalId: 'dir-1',
    email: 'ana@initech-roster.test',
    displayName: 'Ana Alvarez',
    active: true,
  };
  const BEN = {
    externalId: 'dir-2',
    email: 'ben@initech-roster.test',
    displayName: 'Ben Brown',
    active: true,
  };
  const CAT = {
    externalId: 'dir-3',
    email: 'cat@initech-roster.test',
    displayName: 'Cat Chen',
    active: true,
  };

  dbIt('creates users and mappings on the first run, keyed on the external id', async () => {
    const { adapter } = createFakeDirectoryAdapter([ANA, BEN, CAT]);
    const result = await syncRoster({ organizationId, adapter });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.seen).toBe(3);
    expect(result.created).toBe(3);

    const mappings = await prisma.directoryUserMapping.findMany({ where: { organizationId } });
    expect(mappings.map((m) => m.externalId).sort()).toEqual(['dir-1', 'dir-2', 'dir-3']);

    const ana = await prisma.user.findUniqueOrThrow({ where: { email: ANA.email } });
    expect(ana.displayName).toBe('Ana Alvarez');
    expect(ana.status).toBe('ACTIVE');
  });

  dbIt('is idempotent: a second identical run changes nothing', async () => {
    const { adapter } = createFakeDirectoryAdapter([ANA, BEN, CAT]);
    const result = await syncRoster({ organizationId, adapter });

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      created: 0,
      adopted: 0,
      updated: 0,
      deactivated: 0,
    });
    const count = await prisma.user.count({ where: { organizationId } });
    expect(count).toBe(3);
  });

  dbIt('updates the display name the roster owns, and never touches email', async () => {
    const renamed = { ...ANA, displayName: 'Ana A. Alvarez' };
    const { adapter } = createFakeDirectoryAdapter([renamed, BEN, CAT]);
    const result = await syncRoster({ organizationId, adapter });

    expect(result.updated).toBe(1);
    const ana = await prisma.user.findUniqueOrThrow({ where: { email: ANA.email } });
    expect(ana.displayName).toBe('Ana A. Alvarez');
    // Email is not the roster's to own; an existing address is left alone.
    expect(ana.email).toBe(ANA.email);
  });

  dbIt('deactivates a person the directory marks inactive — never deletes them', async () => {
    const benGone = { ...BEN, active: false };
    const { adapter } = createFakeDirectoryAdapter([ANA, benGone, CAT]);
    const result = await syncRoster({ organizationId, adapter });

    expect(result.deactivated).toBe(1);
    const ben = await prisma.user.findUniqueOrThrow({ where: { email: BEN.email } });
    expect(ben.status).toBe('INACTIVE');
    // The row and the mapping both survive.
    expect(
      await prisma.directoryUserMapping.findUnique({
        where: { organizationId_externalId: { organizationId, externalId: BEN.externalId } },
      }),
    ).not.toBeNull();
  });

  dbIt('aborts a run that would remove most of the roster, leaving access untouched', async () => {
    // Only Ana remains of three known people: 2/3 removed, far past the 20% guard.
    const { adapter } = createFakeDirectoryAdapter([{ ...ANA, displayName: 'Ana A. Alvarez' }]);
    const result = await syncRoster({ organizationId, adapter });

    expect(result.status).toBe('ABORTED');
    expect(result.absent).toBe(2);
    expect(result.deactivated).toBe(0);

    // Cat is still active: an aborted run applies nothing.
    const cat = await prisma.user.findUniqueOrThrow({ where: { email: CAT.email } });
    expect(cat.status).toBe('ACTIVE');

    const state = await prisma.directorySyncState.findUniqueOrThrow({ where: { organizationId } });
    expect(state.status).toBe('ABORTED');
    expect(state.lastError).toContain('Refused to deactivate');
  });

  dbIt('applies the removal once the operator confirms the drift', async () => {
    const { adapter } = createFakeDirectoryAdapter([{ ...ANA, displayName: 'Ana A. Alvarez' }]);
    const result = await syncRoster({ organizationId, adapter, confirmDrift: true });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.deactivated).toBeGreaterThanOrEqual(1);

    const cat = await prisma.user.findUniqueOrThrow({ where: { email: CAT.email } });
    expect(cat.status).toBe('INACTIVE');
  });

  dbIt('does not resurrect a locally deactivated account from the directory', async () => {
    // The directory says Cat is active again; the sync must not reactivate her.
    const { adapter } = createFakeDirectoryAdapter([ANA, { ...CAT, active: true }]);
    await syncRoster({ organizationId, adapter, confirmDrift: true });

    const cat = await prisma.user.findUniqueOrThrow({ where: { email: CAT.email } });
    expect(cat.status).toBe('INACTIVE');
  });

  dbIt(
    'adopts an existing local account instead of duplicating it, and never crosses tenants',
    async () => {
      // A local account with a matching email but no mapping yet.
      const local = await createUser({
        email: 'dee@initech-roster.test',
        displayName: 'Dee Local',
        organizationId,
        status: 'ACTIVE',
      });

      const otherOrg = await createOrganization({
        name: 'Other Roster Co',
        nameKey: 'other roster co',
        slug: 'other-roster-co',
        defaultTimeZone: 'UTC',
      });
      await createUser({
        email: 'eve@other-roster.test',
        displayName: 'Eve Other',
        organizationId: otherOrg.id,
        status: 'ACTIVE',
      });

      const dee = {
        externalId: 'dir-4',
        email: 'dee@initech-roster.test',
        displayName: 'Dee Directory',
        active: true,
      };
      const eve = {
        externalId: 'dir-5',
        email: 'eve@other-roster.test',
        displayName: 'Eve Directory',
        active: true,
      };
      const { adapter } = createFakeDirectoryAdapter([{ ...CAT, active: true }, dee, eve]);
      const result = await syncRoster({ organizationId, adapter, confirmDrift: true });

      // Dee is adopted; her local account is updated, not replaced.
      expect(result.adopted).toBe(1);
      const deeUser = await findUserById(local.id);
      expect(deeUser?.displayName).toBe('Dee Directory');
      expect(await prisma.user.count({ where: { email: 'dee@initech-roster.test' } })).toBe(1);

      // Eve's email belongs to another tenant: no mapping is created for her here.
      expect(
        await prisma.directoryUserMapping.findUnique({
          where: { organizationId_externalId: { organizationId, externalId: 'dir-5' } },
        }),
      ).toBeNull();
    },
  );
});
