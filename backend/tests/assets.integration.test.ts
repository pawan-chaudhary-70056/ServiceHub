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
 * Asset register — integration tests (docs/28 §11, docs/37 §3).
 *
 * The invariants under test are the ones that make "who holds it, and who held it when it
 * failed" answerable: at most one open assignment (AM1, enforced by a partial unique index
 * in the database), assignment history that is never deleted (AM3), and `state` that can
 * never disagree with the open assignment (AM6).
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@assets.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-assets.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const MANAGER_EMAIL = 'manager@initech-assets.test';
const MANAGER_PASSWORD = 'V7kLm2-Qz9p!x';
const REQUESTER_EMAIL = 'requester@initech-assets.test';
const REQUESTER_PASSWORD = 'H4qWn8-Zr2s!m';

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
       article_versions, article_slug_redirects, knowledge_links, articles, article_categories,
       asset_assignments, assets, asset_types,
       tasks, incidents, request_field_values, service_requests, comments, reference_sequences,
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
  return {
    cookie: `servicehub_session=${cookies['servicehub_session'] ?? ''}; servicehub_csrf=${cookies['servicehub_csrf'] ?? ''}`,
    csrf: cookies['servicehub_csrf'] ?? '',
  };
}

function login(email: string, password: string): Test {
  return request(app).post(`${BASE}/auth/login`).send({ email, password });
}

let admin: { cookie: string; csrf: string };
let manager: { cookie: string; csrf: string; userId: string };
let requester: { cookie: string; csrf: string; userId: string };
let organizationId = '';
let teamId = '';
let assetTypeId = '';

describe('Asset register', () => {
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
    const operator = await createUser({
      email: OPERATOR_EMAIL,
      displayName: 'Platform Operator',
      organizationId: null,
      status: 'ACTIVE',
    });
    await createCredential({
      userId: operator.id,
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    await grantRoleToUser({
      userId: operator.id,
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
  ): Promise<{ cookie: string; csrf: string; userId: string }> {
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
    const session = sessionFrom(await login(email, password));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { ...session, userId: user.id };
  }

  dbIt('sets up a tenant, an asset type and a team', async () => {
    const operatorSession = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));

    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operatorSession.cookie)
      .set('x-csrf-token', operatorSession.csrf)
      .send({
        name: 'Initech',
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

    manager = await onboard(
      MANAGER_EMAIL,
      MANAGER_PASSWORD,
      'ASSET_MANAGER',
      'Initech Asset Manager',
    );
    requester = await onboard(
      REQUESTER_EMAIL,
      REQUESTER_PASSWORD,
      'REQUESTER',
      'Initech Requester',
    );

    const team = await prisma.team.create({ data: { organizationId, name: 'Field Services' } });
    teamId = team.id;

    // The type carries a required attribute, so AM7 has something to enforce.
    const created = await request(app)
      .post(`${BASE}/admin/asset-types`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        key: 'laptop',
        name: 'Laptop',
        attributeSchema: { required: ['cpu'] },
      })
      .expect(201);
    assetTypeId = created.body.assetType.id;
    expect(organizationId).not.toBe('');
  });

  async function register(
    overrides: Record<string, unknown> = {},
    session = manager,
  ): Promise<{ id: string; tag: string }> {
    const response = await request(app)
      .post(`${BASE}/assets`)
      .set('cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .send({
        assetTypeId,
        name: 'ThinkPad X1',
        serialNumber: `SN-${Math.random().toString(36).slice(2, 10)}`,
        state: 'IN_STOCK',
        attributes: { cpu: 'i7' },
        ...overrides,
      });
    expect(response.status).toBe(201);
    return { id: response.body.asset.id, tag: response.body.asset.tag };
  }

  dbIt('AM7: a required type attribute must be present on create', async () => {
    const response = await request(app)
      .post(`${BASE}/assets`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ assetTypeId, name: 'Incomplete laptop', attributes: {} });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
  });

  dbIt('AM2: the tag is server-allocated and the serial number is unique', async () => {
    const first = await register({ serialNumber: 'SN-UNIQUE-1' });
    expect(first.tag).toMatch(/^AST-\d{6}$/);

    const duplicate = await request(app)
      .post(`${BASE}/assets`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({
        assetTypeId,
        name: 'Second laptop',
        serialNumber: 'SN-UNIQUE-1',
        attributes: { cpu: 'i5' },
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE');
  });

  dbIt('AC6: a holder reads their own asset; another asset is 404, not 403', async () => {
    const mine = await register();
    const other = await register();

    await request(app)
      .post(`${BASE}/assets/${mine.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);

    const holderView = await request(app)
      .get(`${BASE}/assets/${mine.id}`)
      .set('cookie', requester.cookie)
      .expect(200);
    expect(holderView.body.asset.tag).toBe(mine.tag);

    // Not entitled to the other asset, and the API does not disclose that it exists.
    const foreign = await request(app)
      .get(`${BASE}/assets/${other.id}`)
      .set('cookie', requester.cookie);
    expect(foreign.status).toBe(404);

    // The holder's own list contains only the assets they hold.
    const list = await request(app)
      .get(`${BASE}/assets`)
      .set('cookie', requester.cookie)
      .expect(200);
    const ids = (list.body.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
  });

  dbIt('AM1/AC1: a second open assignment is refused by the service and by the index', async () => {
    const asset = await register();
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);

    const second = await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'TEAM', teamId });
    expect(second.status).toBe(409);

    // The database is the backstop: even a direct insert cannot create two open intervals.
    await expect(
      prisma.assetAssignment.create({
        data: {
          organizationId,
          assetId: asset.id,
          holderType: 'TEAM',
          teamId,
          assignedAt: new Date(),
          assignedById: manager.userId,
        },
      }),
    ).rejects.toThrow();
  });

  dbIt('AC2/AM3: returning closes the interval and keeps the row as history', async () => {
    const asset = await register();
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId, notes: 'Loan for the audit' })
      .expect(200);

    const returned = await request(app)
      .post(`${BASE}/assets/${asset.id}/return`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ notes: 'Returned in good condition' })
      .expect(200);
    expect(returned.body.asset.state).toBe('IN_STOCK');
    expect(returned.body.asset.holder.type).toBeNull();

    const assignments = await request(app)
      .get(`${BASE}/assets/${asset.id}/assignments`)
      .set('cookie', manager.cookie)
      .expect(200);
    const rows = assignments.body.items as Array<{
      returnedAt: string | null;
      userId: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(requester.userId);
    expect(rows[0]?.returnedAt).not.toBeNull();

    // Returning again has nothing to close.
    await request(app)
      .post(`${BASE}/assets/${asset.id}/return`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({})
      .expect(409);
  });

  dbIt('AM8: a transfer is close-then-open, so both intervals stay visible', async () => {
    const asset = await register();
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'TEAM', teamId })
      .expect(200);
    await request(app)
      .post(`${BASE}/assets/${asset.id}/return`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({})
      .expect(200);
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);

    const assignments = await request(app)
      .get(`${BASE}/assets/${asset.id}/assignments`)
      .set('cookie', manager.cookie)
      .expect(200);
    const rows = assignments.body.items as Array<{ holderType: string; returnedAt: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.returnedAt === null)).toHaveLength(1);
  });

  dbIt('AC4/AM6: state and the open assignment cannot disagree through any API path', async () => {
    const asset = await register();

    // A field edit cannot declare the asset ASSIGNED — that is a transition, not a field.
    const direct = await request(app)
      .patch(`${BASE}/assets/${asset.id}`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ state: 'ASSIGNED' });
    expect(direct.status).toBe(422);

    // Assigning sets both, atomically.
    const assigned = await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);
    expect(assigned.body.asset.state).toBe('ASSIGNED');
    expect(assigned.body.asset.openAssignment).not.toBeNull();

    // And while assigned, the state cannot be moved out from under the holder.
    await request(app)
      .patch(`${BASE}/assets/${asset.id}`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ state: 'IN_REPAIR' })
      .expect(409);
  });

  dbIt('AC3/AM4/AM5: retirement closes assignments, leaves counts and stays readable', async () => {
    const asset = await register();
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);

    const retired = await request(app)
      .post(`${BASE}/assets/${asset.id}/retire`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ reason: 'End of life' })
      .expect(200);
    expect(retired.body.asset.state).toBe('RETIRED');
    expect(retired.body.asset.holder.type).toBeNull();

    // The open assignment was closed in the same operation (AM4), not orphaned.
    const open = await prisma.assetAssignment.count({
      where: { assetId: asset.id, returnedAt: null },
    });
    expect(open).toBe(0);

    // Excluded from the IN_STOCK/ASSIGNED counts (AC3)...
    const stats = await request(app)
      .get(`${BASE}/assets/stats`)
      .set('cookie', manager.cookie)
      .expect(200);
    const byState = stats.body.byState as Array<{ state: string; count: number }>;
    const assignedCount = byState.find((row) => row.state === 'ASSIGNED')?.count ?? 0;
    expect(await prisma.asset.count({ where: { organizationId, state: 'ASSIGNED' } })).toBe(
      assignedCount,
    );

    // ...but still readable (AM5 — retired, never deleted).
    const readable = await request(app)
      .get(`${BASE}/assets/${asset.id}`)
      .set('cookie', manager.cookie)
      .expect(200);
    expect(readable.body.asset.state).toBe('RETIRED');

    // A retired asset cannot be assigned again.
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(409);

    // Only a retired asset may be disposed.
    const inStock = await register();
    await request(app)
      .post(`${BASE}/assets/${inStock.id}/dispose`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({})
      .expect(409);
    await request(app)
      .post(`${BASE}/assets/${asset.id}/dispose`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ reason: 'Recycled' })
      .expect(200);
  });

  dbIt('AC5: every assignment, return, retirement and disposal is audited', async () => {
    const asset = await register();
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);
    await request(app)
      .post(`${BASE}/assets/${asset.id}/return`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({})
      .expect(200);
    await request(app)
      .post(`${BASE}/assets/${asset.id}/retire`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ reason: 'Faulty' })
      .expect(200);
    await request(app)
      .post(`${BASE}/assets/${asset.id}/dispose`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ reason: 'Recycled' })
      .expect(200);

    const entries = await prisma.auditLog.findMany({ where: { entityId: asset.id } });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain('asset.create');
    expect(actions).toContain('asset.assign');
    expect(actions).toContain('asset.return');
    expect(actions).toContain('asset.retire');
    expect(actions).toContain('asset.dispose');
  });

  dbIt("docs/30 §2.1: the register is searchable, scoped to the caller's holdings", async () => {
    const unique = `Zebra-${Math.random().toString(36).slice(2, 8)}`;
    const mine = await register({ name: `${unique} laptop` });
    const other = await register({ name: `${unique} spare dock` });

    await request(app)
      .post(`${BASE}/assets/${mine.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);

    // A manager sees both register entries.
    const managerSearch = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(unique)}`)
      .set('cookie', manager.cookie)
      .expect(200);
    const managerIds = (managerSearch.body.items as Array<{ entityType: string; id: string }>)
      .filter((item) => item.entityType === 'ASSET')
      .map((item) => item.id);
    expect(managerIds).toContain(mine.id);
    expect(managerIds).toContain(other.id);

    // A holder searching sees only what they hold — the scope is a SQL predicate, not a
    // post-filter (docs/30 §2.3 S1).
    const holderSearch = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(unique)}`)
      .set('cookie', requester.cookie)
      .expect(200);
    const holderIds = (holderSearch.body.items as Array<{ entityType: string; id: string }>)
      .filter((item) => item.entityType === 'ASSET')
      .map((item) => item.id);
    expect(holderIds).toContain(mine.id);
    expect(holderIds).not.toContain(other.id);
  });

  dbIt('rejects an assignment to a deactivated holder (docs/28 §10)', async () => {
    const asset = await register();
    const roles = await request(app).get(`${BASE}/roles`).set('cookie', admin.cookie);
    const requesterRole = (roles.body.items as Array<{ id: string; key: string }>).find(
      (role) => role.key === 'REQUESTER',
    );
    await request(app)
      .post(`${BASE}/users`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        email: 'leaver@initech-assets.test',
        displayName: 'Leaver',
        roleId: requesterRole?.id,
      })
      .expect(201);
    const leaver = await prisma.user.findFirstOrThrow({
      where: { email: 'leaver@initech-assets.test' },
    });
    await prisma.user.update({ where: { id: leaver.id }, data: { status: 'INACTIVE' } });

    const response = await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: leaver.id });
    expect(response.status).toBe(409);

    // The asset stays in stock, with no open assignment.
    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.state).toBe('IN_STOCK');
    expect(reread.assignedToUserId).toBeNull();
  });

  dbIt('docs/31 §5: a holder reads the asset history; a non-holder receives its 404', async () => {
    const asset = await register();
    await request(app)
      .post(`${BASE}/assets/${asset.id}/assign`)
      .set('cookie', manager.cookie)
      .set('x-csrf-token', manager.csrf)
      .send({ holderType: 'USER', userId: requester.userId })
      .expect(200);

    // The holder may read the asset, so its own trail is theirs (record half of §5).
    const holderView = await request(app)
      .get(`${BASE}/audit/records/Asset/${asset.id}`)
      .set('cookie', requester.cookie)
      .expect(200);
    const actions = (holderView.body.history as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toContain('asset.create');
    expect(actions).toContain('asset.assign');

    // `asset:read.any` widens the history to the register's managers.
    await request(app)
      .get(`${BASE}/audit/records/Asset/${asset.id}`)
      .set('cookie', manager.cookie)
      .expect(200);

    // Another requester neither holds the asset nor holds `asset:read.any`, so the
    // projection refuses with the asset's own NOT_FOUND — never a back door.
    const other = await onboard(
      'other-holder@initech-assets.test',
      'N2wRt9-Pk6v!s',
      'REQUESTER',
      'Other Requester',
    );
    await request(app).get(`${BASE}/assets/${asset.id}`).set('cookie', other.cookie).expect(404);
    await request(app)
      .get(`${BASE}/audit/records/Asset/${asset.id}`)
      .set('cookie', other.cookie)
      .expect(404);
  });
});
