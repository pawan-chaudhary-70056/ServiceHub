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
 * Unified search and reporting — integration tests (docs/37 §3, docs/30 §2/§3).
 *
 * The behaviour under test is the security core of `docs/30` §2.3: **search never returns a
 * record the caller cannot read**, in results, counts or suggestions, and reports are
 * scoped by the caller's authorization (`§3.2` R3). A restricted record under a broad query
 * is the canonical leak, so that is exactly what the first test exercises.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@search.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-search.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-search.test';
const ALICE_PASSWORD = 'V7kLm2-Qz9p!x';
const BOB_EMAIL = 'bob@initech-search.test';
const BOB_PASSWORD = 'H4qWn8-Zr2s!m';

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
       notification_preferences, notifications, tasks, incidents, request_field_values,
       service_requests, comments,
       reference_sequences, catalog_item_fields, catalog_items, categories, sla_targets,
       sla_policies, business_calendars, sla_clocks,
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
  return {
    cookie: `servicehub_session=${cookies['servicehub_session'] ?? ''}; servicehub_csrf=${cookies['servicehub_csrf'] ?? ''}`,
    csrf: cookies['servicehub_csrf'] ?? '',
  };
}

function login(email: string, password: string): Test {
  return request(app).post(`${BASE}/auth/login`).send({ email, password });
}

interface SearchBody {
  items: Array<{
    entityType: string;
    id: string;
    reference: string | null;
    title: string;
    snippet: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
  fallback: string | null;
  searchedTypes: string[];
}

describe('Unified search and reporting', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };
  let bob: { cookie: string; csrf: string };
  let organizationId = '';
  let itemId = '';
  let aliceReference = '';
  let bobReference = '';

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
    if (!superAdminRole) throw new Error('SUPER_ADMIN role was not seeded.');

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

  async function onboard(
    email: string,
    password: string,
    roleKey: string,
    displayName: string,
  ): Promise<{ cookie: string; csrf: string }> {
    const roles = await request(app).get(`${BASE}/roles`).set('cookie', admin.cookie);
    const role = (roles.body.items as Array<{ id: string; key: string }>).find(
      (r) => r.key === roleKey,
    );
    const invited = await request(app)
      .post(`${BASE}/users`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ email, roleId: role?.id, displayName });
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: invited.body.invitation.token, password })
      .expect(204);
    return sessionFrom(await login(email, password));
  }

  dbIt('sets up a tenant with a requester, a second requester and an admin', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Search',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Initech Admin',
        defaultTimeZone: 'Europe/London',
      });
    organizationId = provisioned.body.organization.id;
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: provisioned.body.invitation.token, password: ADMIN_PASSWORD })
      .expect(204);
    admin = sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD));

    alice = await onboard(ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');
    bob = await onboard(BOB_EMAIL, BOB_PASSWORD, 'REQUESTER', 'Bob Requester');

    const policies = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
    const policyId = (policies.body.items as Array<{ id: string; isDefault: boolean }>).find(
      (p) => p.isDefault,
    )?.id;

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });

    const category = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Access' });
    const item = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'Laptop Request',
        defaultPriority: 'MEDIUM',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: team.id,
        fields: [],
      });
    itemId = item.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    // A draft item that a requester must never see in search.
    await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'Secret Project Tool',
        defaultPriority: 'LOW',
        defaultSlaPolicyId: policyId,
        fields: [],
      });
  });

  dbIt('raises one request for each requester', async () => {
    const a = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'VPN access for Alice', fields: {} });
    expect(a.status).toBe(201);
    aliceReference = a.body.request.reference;

    const b = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf)
      .send({ catalogItemId: itemId, title: 'VPN access for Bob', fields: {} });
    expect(b.status).toBe(201);
    bobReference = b.body.request.reference;
  });

  dbIt('never returns a record the caller cannot read (docs/30 §2.3 S1)', async () => {
    // Alice's own scope: a broad query must return only her request.
    const aliceSearch = await request(app).get(`${BASE}/search?q=VPN`).set('cookie', alice.cookie);
    expect(aliceSearch.status).toBe(200);
    const aliceBody = aliceSearch.body as SearchBody;
    const aliceRequests = aliceBody.items.filter((i) => i.entityType === 'REQUEST');
    expect(aliceRequests).toHaveLength(1);
    expect(aliceRequests[0]?.title).toBe('VPN access for Alice');
    expect(aliceBody.items.map((i) => i.reference)).not.toContain(bobReference);

    // Searching Bob's exact reference as Alice yields nothing — not an error, not a hint.
    const restricted = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(bobReference)}`)
      .set('cookie', alice.cookie);
    expect(restricted.status).toBe(200);
    expect((restricted.body as SearchBody).items).toHaveLength(0);

    // The admin holds `request:read.any`, so the same query returns both.
    const adminSearch = await request(app).get(`${BASE}/search?q=VPN`).set('cookie', admin.cookie);
    const adminRequests = (adminSearch.body as SearchBody).items.filter(
      (i) => i.entityType === 'REQUEST',
    );
    expect(adminRequests).toHaveLength(2);
  });

  dbIt('ranks an exact reference match first (docs/30 §2.1)', async () => {
    const exact = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(aliceReference)}`)
      .set('cookie', admin.cookie);
    const body = exact.body as SearchBody;
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]?.reference).toBe(aliceReference);
  });

  dbIt('hides a draft catalog item from a requester but shows it to a manager', async () => {
    const asAlice = await request(app).get(`${BASE}/search?q=Secret`).set('cookie', alice.cookie);
    expect((asAlice.body as SearchBody).items).toHaveLength(0);

    const asAdmin = await request(app).get(`${BASE}/search?q=Secret`).set('cookie', admin.cookie);
    const draft = (asAdmin.body as SearchBody).items.find(
      (i) => i.entityType === 'CATALOG_ITEM' && i.title === 'Secret Project Tool',
    );
    expect(draft).toBeDefined();
  });

  dbIt('searches users only for a caller with user:manage', async () => {
    const asAlice = await request(app).get(`${BASE}/search?q=Bob`).set('cookie', alice.cookie);
    expect((asAlice.body as SearchBody).searchedTypes).not.toContain('USER');
    expect((asAlice.body as SearchBody).items.some((i) => i.entityType === 'USER')).toBe(false);

    const asAdmin = await request(app).get(`${BASE}/search?q=Bob`).set('cookie', admin.cookie);
    const users = (asAdmin.body as SearchBody).items.filter((i) => i.entityType === 'USER');
    expect(users.some((i) => i.title === 'Bob Requester')).toBe(true);
  });

  dbIt(
    'scopes reports to the caller and reserves cross-team reports (docs/30 §3.2 R3)',
    async () => {
      const aliceReport = await request(app)
        .get(`${BASE}/reports/requests.summary`)
        .set('cookie', alice.cookie);
      expect(aliceReport.status).toBe(200);
      expect(aliceReport.body.report.scope).toBe('own');
      const aliceByStatus = aliceReport.body.report.figures.byStatus as Record<string, number>;
      expect(Object.values(aliceByStatus).reduce((sum, n) => sum + n, 0)).toBe(1);

      const adminReport = await request(app)
        .get(`${BASE}/reports/requests.summary`)
        .set('cookie', admin.cookie);
      expect(adminReport.body.report.scope).toBe('any');
      const adminByStatus = adminReport.body.report.figures.byStatus as Record<string, number>;
      expect(Object.values(adminByStatus).reduce((sum, n) => sum + n, 0)).toBe(2);

      // SLA attainment is cross-team: refused for a requester, allowed for the admin.
      const denied = await request(app)
        .get(`${BASE}/reports/sla.attainment`)
        .set('cookie', alice.cookie);
      expect(denied.status).toBe(403);

      const allowed = await request(app)
        .get(`${BASE}/reports/sla.attainment`)
        .set('cookie', admin.cookie);
      expect(allowed.status).toBe(200);
      expect(allowed.body.report.figures.totalClocks).toBeGreaterThanOrEqual(2);

      const unknown = await request(app)
        .get(`${BASE}/reports/does.not.exist`)
        .set('cookie', admin.cookie);
      expect(unknown.status).toBe(404);
    },
  );

  dbIt('uses PostgreSQL full-text search with highlighting (docs/30 §2.2/§2.4)', async () => {
    const response = await request(app).get(`${BASE}/search?q=VPN`).set('cookie', admin.cookie);
    const body = response.body as SearchBody;
    const requestItem = body.items.find((i) => i.entityType === 'REQUEST');
    expect(requestItem).toBeDefined();
    // `ts_headline` wraps the matched term, so a title match carries markup.
    expect(requestItem?.snippet).toMatch(/<b>VPN<\/b>/i);
  });

  dbIt('treats a multi-term query as a conjunction (FTS AND)', async () => {
    const response = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent('VPN Bob')}`)
      .set('cookie', admin.cookie);
    const requests = (response.body as SearchBody).items.filter((i) => i.entityType === 'REQUEST');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.title).toBe('VPN access for Bob');
  });

  dbIt('registers the GIN full-text indexes (docs/30 §2.2)', async () => {
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_search_idx'`,
    );
    const names = indexes.map((row) => row.indexname).sort();
    expect(names).toEqual([
      'catalog_items_search_idx',
      'incidents_search_idx',
      'service_requests_search_idx',
      'users_search_idx',
    ]);
  });
});
