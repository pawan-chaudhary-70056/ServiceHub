import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
} from '../src/models';

/**
 * Service catalog and SLA configuration — integration tests (docs/37 §3 level 2).
 *
 * Run against a REAL PostgreSQL instance, because the behaviour under test is database
 * behaviour: unique constraints, transactions, tenant predicates and the append-only
 * audit trigger. The acceptance criteria exercised here are docs/21 §12 (activation
 * guard, retirement invisibility, three-level category bound) and docs/25 §14 (a default
 * policy exists and is reproducible).
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@catalog.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@globex.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'requester@globex.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';

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
       catalog_item_fields, catalog_items, categories, sla_targets, sla_policies,
       business_calendars, sla_clocks,
       sessions, password_reset_tokens, invitations, user_roles, role_permissions,
       teams, team_members, audit_logs, outbox, job_records, credentials, users,
       roles, permissions, organizations
     RESTART IDENTITY CASCADE`,
  );
  await seedReferenceData();
}

function sessionFrom(response: Response): { cookie: string; csrf: string } {
  const raw = response.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('; ') : String(raw ?? '');
  const cookies = parseCookies(joined);
  const session = cookies['servicehub_session'] ?? '';
  const csrf = cookies['servicehub_csrf'] ?? '';
  return { cookie: `servicehub_session=${session}; servicehub_csrf=${csrf}`, csrf };
}

function login(email: string, password: string): Test {
  return request(app).post(`${BASE}/auth/login`).send({ email, password });
}

describe('service catalog and SLA configuration', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string };
  let organizationId = '';
  let defaultPolicyId = '';
  let fulfilmentTeamId = '';
  let rootCategoryId = '';
  let itemId = '';

  beforeAll(async () => {
    try {
      await prisma.permission.count();
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      return;
    }

    await resetDatabase();

    const superAdminRole = await findRoleByKey('SUPER_ADMIN', null);
    if (!superAdminRole) {
      throw new Error('SUPER_ADMIN role was not seeded.');
    }

    const operatorUser = await createUser({
      email: OPERATOR_EMAIL,
      displayName: 'Platform Operator',
      organizationId: null,
      status: 'ACTIVE',
    });
    await createCredential({
      userId: operatorUser.id,
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    await grantRoleToUser({
      userId: operatorUser.id,
      roleId: superAdminRole.id,
      organizationId: null,
    });
  });

  afterAll(async () => {
    await disconnectDatabase().catch(() => undefined);
  });

  dbIt('provisions a tenant, which seeds a default SLA calendar and policy', async () => {
    const operatorLogin = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);
    operator = sessionFrom(operatorLogin);

    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Globex',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Globex Admin',
        defaultTimeZone: 'Europe/London',
      });

    expect(provisioned.status).toBe(201);
    organizationId = provisioned.body.organization.id;

    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: provisioned.body.invitation.token, password: ADMIN_PASSWORD })
      .expect(204);

    const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    admin = sessionFrom(adminLogin);

    const policies = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
    expect(policies.status).toBe(200);
    const policy = (
      policies.body.items as Array<{ id: string; isDefault: boolean; targets: unknown[] }>
    ).find((candidate) => candidate.isDefault);
    expect(policy).toBeDefined();
    defaultPolicyId = policy?.id ?? '';
    // The default policy carries a target for every priority (docs/25 §2).
    expect(policy?.targets).toHaveLength(4);

    const calendars = await request(app).get(`${BASE}/sla/calendars`).set('cookie', admin.cookie);
    expect(calendars.body.items[0].timeZone).toBe('Europe/London');
    expect(calendars.body.items[0].model).toBe('WORKING_HOURS');

    const team = await prisma.team.create({
      data: { organizationId, name: 'IT Support' },
    });
    fulfilmentTeamId = team.id;
  });

  dbIt('invites and onboards a requester, who cannot manage the catalog', async () => {
    const roles = await request(app).get(`${BASE}/roles`).set('cookie', admin.cookie);
    const requesterRole = (roles.body.items as Array<{ id: string; key: string }>).find(
      (role) => role.key === 'REQUESTER',
    );
    expect(requesterRole).toBeDefined();

    const invited = await request(app)
      .post(`${BASE}/users`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ email: REQUESTER_EMAIL, roleId: requesterRole?.id, displayName: 'Globex Requester' });
    expect(invited.status).toBe(201);

    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: invited.body.invitation.token, password: REQUESTER_PASSWORD })
      .expect(204);

    const requesterLogin = await login(REQUESTER_EMAIL, REQUESTER_PASSWORD);
    requester = sessionFrom(requesterLogin);

    // Rule: management is `catalog:manage`, which a requester lacks (docs/21 §6).
    const forbidden = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ name: 'Rogue' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
  });

  dbIt('creates a category and enforces the three-level nesting bound (rule C7)', async () => {
    const root = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Hardware' });
    expect(root.status).toBe(201);
    rootCategoryId = root.body.category.id;

    const level2 = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Laptops', parentId: rootCategoryId });
    expect(level2.status).toBe(201);

    const level3 = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Windows', parentId: level2.body.category.id });
    expect(level3.status).toBe(201);

    const level4 = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Too Deep', parentId: level3.body.category.id });
    expect(level4.status).toBe(422);
    expect(level4.body.code).toBe('VALIDATION_FAILED');
  });

  dbIt('creates a DRAFT item with fields and hides it from a requester', async () => {
    const created = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: rootCategoryId,
        name: 'Standard laptop',
        description: 'A managed laptop for a new starter.',
        requiresApproval: true,
        fields: [
          {
            key: 'operating_system',
            label: 'Operating system',
            fieldType: 'SELECT',
            isRequired: true,
            options: ['Windows', 'macOS'],
            displayOrder: 1,
          },
          {
            key: 'justification',
            label: 'Justification',
            fieldType: 'LONG_TEXT',
            isRequired: false,
            displayOrder: 2,
          },
        ],
      });

    expect(created.status).toBe(201);
    expect(created.body.item.status).toBe('DRAFT');
    expect(created.body.item.fields).toHaveLength(2);
    itemId = created.body.item.id;

    // A requester cannot list or read a draft item — indistinguishable from absence.
    const list = await request(app).get(`${BASE}/catalog/items`).set('cookie', requester.cookie);
    expect((list.body.items as unknown[]).length).toBe(0);

    const detail = await request(app)
      .get(`${BASE}/catalog/items/${itemId}`)
      .set('cookie', requester.cookie);
    expect(detail.status).toBe(404);

    // The manager sees the draft.
    const adminList = await request(app).get(`${BASE}/catalog/items`).set('cookie', admin.cookie);
    expect((adminList.body.items as Array<{ id: string }>).map((row) => row.id)).toContain(itemId);
  });

  dbIt('refuses activation without an SLA policy and fulfilment team (rule C1)', async () => {
    const response = await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    const fields = (response.body.errors as Array<{ field: string }>).map((error) => error.field);
    expect(fields).toContain('defaultSlaPolicyId');
    expect(fields).toContain('fulfilmentTeamId');
  });

  dbIt('activates an item once C1 is satisfied and makes it requestable', async () => {
    const patched = await request(app)
      .patch(`${BASE}/catalog/items/${itemId}`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ defaultSlaPolicyId: defaultPolicyId, fulfilmentTeamId, defaultPriority: 'HIGH' });
    expect(patched.status).toBe(200);

    const activated = await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf);
    expect(activated.status).toBe(200);
    expect(activated.body.item.status).toBe('ACTIVE');
    expect(activated.body.item.defaultSlaPolicy.id).toBe(defaultPolicyId);
    expect(activated.body.item.fulfilmentTeam.name).toBe('IT Support');

    const list = await request(app).get(`${BASE}/catalog/items`).set('cookie', requester.cookie);
    expect((list.body.items as Array<{ id: string }>).map((row) => row.id)).toContain(itemId);

    const detail = await request(app)
      .get(`${BASE}/catalog/items/${itemId}`)
      .set('cookie', requester.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.item.fields.map((field: { key: string }) => field.key)).toEqual([
      'operating_system',
      'justification',
    ]);
  });

  dbIt('retires an item without deleting it: history stays, requesters lose access', async () => {
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/retire`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    const requesterDetail = await request(app)
      .get(`${BASE}/catalog/items/${itemId}`)
      .set('cookie', requester.cookie);
    expect(requesterDetail.status).toBe(404);

    // The row still exists for a manager and can be reactivated (C5: retirement, never delete).
    const adminDetail = await request(app)
      .get(`${BASE}/catalog/items/${itemId}`)
      .set('cookie', admin.cookie);
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.item.status).toBe('RETIRED');
  });

  dbIt('rejects a duplicate category name under the same parent (rule C4)', async () => {
    const duplicate = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Hardware' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE');
  });

  dbIt('invalidates both cached list regions on a mutation (docs/21 §12 AC5)', async () => {
    // Warm both regions through the API — the reads a browser makes on page load.
    const treeBefore = await request(app)
      .get(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie);
    expect(treeBefore.status).toBe(200);

    const requesterBefore = await request(app)
      .get(`${BASE}/catalog/items`)
      .set('cookie', requester.cookie);
    expect(requesterBefore.status).toBe(200);
    const visibleBefore = (requesterBefore.body.items as Array<{ id: string }>).map(
      (row) => row.id,
    );

    // 1. A category mutation invalidates the tree: the very next read shows the new
    //    node. Without invalidation this would be a cache hit on the warm entry.
    const created = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Software' });
    expect(created.status).toBe(201);

    const treeAfter = await request(app)
      .get(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie);
    expect((treeAfter.body.items as Array<{ name: string }>).map((row) => row.name)).toContain(
      'Software',
    );

    // 2. An item create invalidates the item region: the requester's own view is
    //    reloaded and still excludes the DRAFT row (C1: viewer class is in the key).
    const drafted = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: rootCategoryId,
        name: 'Second laptop',
        description: null,
        defaultSlaPolicyId: defaultPolicyId,
        fulfilmentTeamId,
        requiresApproval: false,
        fields: [],
      });
    expect(drafted.status).toBe(201);
    const secondItemId = drafted.body.item.id;

    const requesterMid = await request(app)
      .get(`${BASE}/catalog/items`)
      .set('cookie', requester.cookie);
    expect((requesterMid.body.items as Array<{ id: string }>).map((row) => row.id)).not.toContain(
      secondItemId,
    );

    // 3. Activation invalidates again: the requester's freshly cached page must not
    //    survive the status change. This is the assertion that fails without C3.
    const activated = await request(app)
      .post(`${BASE}/catalog/items/${secondItemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf);
    expect(activated.status).toBe(200);

    const requesterAfter = await request(app)
      .get(`${BASE}/catalog/items`)
      .set('cookie', requester.cookie);
    const visibleAfter = (requesterAfter.body.items as Array<{ id: string }>).map((row) => row.id);
    expect(visibleAfter).toContain(secondItemId);
    expect(visibleAfter).toEqual(expect.arrayContaining(visibleBefore));
  });

  dbIt(
    'versions a calendar on edit: new row, old superseded, policies moved (25 §4 rule 6)',
    async () => {
      const before = await request(app).get(`${BASE}/sla/calendars`).set('cookie', admin.cookie);
      expect(before.status).toBe(200);
      const current = (
        before.body.items as Array<{ id: string; name: string; version: number }>
      ).find((calendar) => calendar.version === 1);
      expect(current).toBeDefined();

      // A second calendar, so a rename collision has something to collide with.
      const second = await request(app)
        .post(`${BASE}/sla/calendars`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({
          name: 'Follow The Sun',
          timeZone: 'UTC',
          model: 'WALL_CLOCK',
          workingHours: { mon: [{ start: '00:00', end: '23:59' }] },
          holidays: [],
        });
      expect(second.status).toBe(201);

      // A clock row standing in for a record started under version 1: the edit below must
      // not touch it (docs/25 §4 example 5, §14 AC4).
      const inFlight = await prisma.slaClock.create({
        data: {
          organizationId,
          entityType: 'ServiceRequest',
          entityId: 'req-in-flight-cal-edit',
          slaPolicyId: defaultPolicyId,
          priority: 'HIGH',
          cycle: 1,
          startedAt: new Date('2026-10-12T09:00:00Z'),
          targetAt: new Date('2026-10-16T17:00:00Z'),
          warnAt: new Date('2026-10-16T13:00:00Z'),
        },
      });

      // 1. The edit creates version 2 of the *same* calendar — same identity, new row.
      const patched = await request(app)
        .patch(`${BASE}/sla/calendars/${current?.id}`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ timeZone: 'Europe/Paris', holidays: ['2026-12-25'] });
      expect(patched.status).toBe(200);
      expect(patched.body.calendar.id).not.toBe(current?.id);
      expect(patched.body.calendar.name).toBe(current?.name);
      expect(patched.body.calendar.version).toBe(2);
      expect(patched.body.calendar.timeZone).toBe('Europe/Paris');
      expect(patched.body.calendar.isActive).toBe(true);

      // 2. Both versions remain addressable; version 1 is superseded, not deleted.
      const after = await request(app).get(`${BASE}/sla/calendars`).set('cookie', admin.cookie);
      const lineage = (
        after.body.items as Array<{
          id: string;
          name: string;
          version: number;
          isActive: boolean;
        }>
      ).filter((calendar) => calendar.name === current?.name);
      expect(lineage).toHaveLength(2);
      expect(lineage.find((calendar) => calendar.version === 1)?.isActive).toBe(false);
      expect(lineage.find((calendar) => calendar.version === 2)?.isActive).toBe(true);

      // 3. Policies move to the successor, so *new* records use the new version (25 §13).
      const policies = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
      const defaultPolicy = (
        policies.body.items as Array<{
          id: string;
          calendar: { id: string; version: number };
        }>
      ).find((policy) => policy.id === defaultPolicyId);
      expect(defaultPolicy?.calendar.id).toBe(patched.body.calendar.id);
      expect(defaultPolicy?.calendar.version).toBe(2);

      // 4. The in-flight record's frozen instants are untouched (25 §14 AC4).
      const stillFrozen = await prisma.slaClock.findUniqueOrThrow({ where: { id: inFlight.id } });
      expect(stillFrozen.targetAt.getTime()).toBe(inFlight.targetAt.getTime());
      expect(stillFrozen.warnAt.getTime()).toBe(inFlight.warnAt.getTime());

      // 5. The edit is in the audit trail (25 §14 AC8's principle, applied here).
      const audited = await prisma.auditLog.findFirst({
        where: { action: 'sla.calendar.update' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audited).not.toBeNull();
      expect(audited?.entityId).toBe(current?.id);

      // 6. A superseded version is not editable: the client would be editing a version no
      //    new record will ever use.
      const stale = await request(app)
        .patch(`${BASE}/sla/calendars/${current?.id}`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ timeZone: 'Europe/London' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('CONFLICT');

      // 7. Renaming onto another calendar's name is refused; a version number does not
      //    make a duplicate name a different calendar.
      const rename = await request(app)
        .patch(`${BASE}/sla/calendars/${patched.body.calendar.id}`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ name: 'Follow The Sun' });
      expect(rename.status).toBe(409);
      expect(rename.body.code).toBe('DUPLICATE');

      // 8. An empty edit is not a version.
      const empty = await request(app)
        .patch(`${BASE}/sla/calendars/${patched.body.calendar.id}`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({});
      expect(empty.status).toBe(422);
      expect(empty.body.code).toBe('VALIDATION_FAILED');
    },
  );

  dbIt('refuses a calendar edit to a caller without sla:policy:manage', async () => {
    const calendars = await request(app).get(`${BASE}/sla/calendars`).set('cookie', admin.cookie);
    const current = (calendars.body.items as Array<{ id: string; version: number }>).find(
      (calendar) => calendar.version >= 2,
    );
    expect(current).toBeDefined();

    const forbidden = await request(app)
      .patch(`${BASE}/sla/calendars/${current?.id}`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ timeZone: 'UTC' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
  });
});
