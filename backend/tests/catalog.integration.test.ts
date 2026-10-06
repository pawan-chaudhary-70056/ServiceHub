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
});
