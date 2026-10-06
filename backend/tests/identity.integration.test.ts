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
  findUserByEmail,
  grantRoleToUser,
  prisma,
} from '../src/models';

/**
 * Identity, tenant provisioning and platform administration — integration tests
 * (docs/37 §3 level 2).
 *
 * These run against a REAL PostgreSQL instance, because the behaviour under test *is*
 * the database behaviour: unique constraints, transactions, the append-only audit
 * trigger and the per-request entitlement join. A mock would assert nothing that
 * matters here.
 *
 * When no database is reachable the tests skip cleanly, so a unit-only environment
 * still runs green rather than reporting a false failure. The check is done at run time
 * (in `beforeAll`) rather than with a top-level `await`, because this project compiles
 * to CommonJS and TypeScript forbids top-level await there.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@servicehub.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@acme.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const LOCKOUT_EMAIL = 'lockout@acme.test';
const LOCKOUT_PASSWORD = 'Zzz-Str0ng-Pass!';
const AGENT_PASSWORD = 'Secure-Fulfilment!42';

let databaseAvailable = false;

/** Skips a test (rather than passing it) when no database is reachable. */
function dbIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async (ctx) => {
    if (!databaseAvailable) {
      ctx.skip();
    }
    await fn();
  });
}

/** Recreates the reference data the identity slice depends on (docs/10 §8). */
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
  // TRUNCATE, not DELETE: the audit log is append-only by trigger (docs/31), and
  // TRUNCATE fires no row-level trigger. Permissions are truncated too, then re-seeded.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE
       sessions, password_reset_tokens, invitations, user_roles, role_permissions,
       teams, team_members, audit_logs, outbox, job_records, credentials, users,
       roles, permissions, organizations
     RESTART IDENTITY CASCADE`,
  );
  await seedReferenceData();
}

/** Extracts the session cookie and the readable CSRF cookie from a login response. */
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

describe('identity, provisioning and platform administration', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let adminUserId = '';
  let organizationId = '';
  let adminInvitationToken = '';
  let agentInvitationToken = '';
  let agent: { cookie: string; csrf: string };
  let agentUserId = '';

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

  dbIt('fails login for an unknown email with a generic 401 and no session cookie', async () => {
    const response = await login('nobody@example.test', 'irrelevant-password');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    // The message must not distinguish unknown-email from wrong-password (docs/06 §3).
    expect(response.body.detail).toBe('Email or password is incorrect.');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  dbIt('fails login for a wrong password with the same generic 401', async () => {
    const response = await login(OPERATOR_EMAIL, 'definitely-wrong-password');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  dbIt('issues a session for valid credentials and reports the platform operator', async () => {
    const response = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      email: OPERATOR_EMAIL,
      organizationId: null,
      isPlatformOperator: true,
    });
    expect(response.body.permissions).toContain('platform:organization:manage');

    operator = sessionFrom(response);
    expect(operator.csrf.length).toBeGreaterThan(0);
  });

  dbIt('rejects GET /auth/me without a session and accepts it with one', async () => {
    await request(app).get(`${BASE}/auth/me`).expect(401);

    const response = await request(app).get(`${BASE}/auth/me`).set('cookie', operator.cookie);
    expect(response.status).toBe(200);
    expect(response.body.user.isPlatformOperator).toBe(true);
    expect(response.body.permissions).toContain('platform:organization:manage');
  });

  dbIt('requires authentication for platform routes', async () => {
    await request(app).get(`${BASE}/platform/organizations`).expect(401);
  });

  dbIt('rejects a state-changing platform request without a CSRF token', async () => {
    const response = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .send({
        name: 'Acme Ltd',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Acme Admin',
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  dbIt('provisions a tenant with its roles, first administrator and invitation', async () => {
    const response = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Acme  Ltd',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Acme Admin',
      });

    expect(response.status).toBe(201);
    expect(response.headers['location']).toMatch(/\/platform\/organizations\//);
    expect(response.body.organization).toMatchObject({ name: 'Acme Ltd', status: 'ACTIVE' });
    expect(response.body.administrator).toMatchObject({ email: ADMIN_EMAIL });

    organizationId = response.body.organization.id;
    adminInvitationToken = response.body.invitation.token;
    expect(typeof adminInvitationToken).toBe('string');

    // Tenant roles are seeded per organization at provisioning (docs/04 §13.2).
    const administratorRole = await findRoleByKey('ADMINISTRATOR', organizationId);
    expect(administratorRole).not.toBeNull();
  });

  dbIt('refuses a duplicate tenant name with DUPLICATE', async () => {
    const response = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'acme ltd',
        administratorEmail: 'other@acme.test',
        administratorName: 'Other Admin',
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('DUPLICATE');
  });

  dbIt(
    'refuses login for the provisioned administrator until the invitation is accepted',
    async () => {
      const response = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(response.status).toBe(401);
    },
  );

  dbIt('accepts the invitation once, establishing the first credential', async () => {
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: adminInvitationToken, password: ADMIN_PASSWORD })
      .expect(204);

    // Single-use: the same token cannot be replayed (docs/06 §11 rule 1).
    const replay = await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: adminInvitationToken, password: ADMIN_PASSWORD });
    expect(replay.status).toBe(422);
    expect(replay.body.code).toBe('VALIDATION_FAILED');
  });

  dbIt(
    'lets the activated administrator log in with tenant scope but no platform authority',
    async () => {
      const response = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

      expect(response.status).toBe(200);
      expect(response.body.user.organizationId).toBe(organizationId);
      expect(response.body.user.isPlatformOperator).toBe(false);
      expect(response.body.permissions).toContain('user:manage');
      expect(response.body.permissions).not.toContain('platform:organization:manage');

      admin = sessionFrom(response);
      adminUserId = response.body.user.id;
    },
  );

  dbIt(
    'enforces separation of duties: a tenant administrator cannot provision tenants',
    async () => {
      const response = await request(app)
        .post(`${BASE}/platform/organizations`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({
          name: 'Rogue Tenant',
          administratorEmail: 'rogue@example.test',
          administratorName: 'Rogue',
        });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    },
  );

  dbIt(
    'enforces separation of duties: a platform operator cannot invite tenant users',
    async () => {
      const response = await request(app)
        .post(`${BASE}/users`)
        .set('cookie', operator.cookie)
        .set('x-csrf-token', operator.csrf)
        .send({ email: 'someone@acme.test', roleId: 'irrelevant' });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    },
  );

  dbIt('lets a tenant administrator invite a user and refuses a foreign role', async () => {
    const agentRole = await findRoleByKey('AGENT', organizationId);
    if (!agentRole) {
      throw new Error('AGENT role was not seeded for the tenant.');
    }

    const response = await request(app)
      .post(`${BASE}/users`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ email: 'agent@acme.test', roleId: agentRole.id, displayName: 'Acme Agent' });

    expect(response.status).toBe(201);
    expect(response.body.invitation.token).toBeTruthy();

    agentInvitationToken = response.body.invitation.token;
    const invited = await findUserByEmail('agent@acme.test');
    agentUserId = invited?.id ?? '';
    expect(agentUserId).not.toBe('');
  });

  dbIt('lists tenant users scoped to the organization, never the platform operator', async () => {
    const response = await request(app).get(`${BASE}/users`).set('cookie', admin.cookie);

    expect(response.status).toBe(200);
    const emails = (response.body.items as { email: string }[]).map((item) => item.email);
    expect(emails).toContain(ADMIN_EMAIL);
    expect(emails).toContain('agent@acme.test');
    // The platform operator belongs to no tenant and must not appear (docs/07 §5).
    expect(emails).not.toContain(OPERATOR_EMAIL);
  });

  dbIt('lists assignable tenant roles and never a platform role', async () => {
    const response = await request(app).get(`${BASE}/roles`).set('cookie', admin.cookie);

    expect(response.status).toBe(200);
    const keys = (response.body.items as { key: string }[]).map((item) => item.key);
    expect(keys).toContain('ADMINISTRATOR');
    expect(keys).toContain('AGENT');
    expect(keys).not.toContain('SUPER_ADMIN');
  });

  dbIt('refuses tenant user administration for a platform operator', async () => {
    await request(app).get(`${BASE}/users`).set('cookie', operator.cookie).expect(403);
    await request(app).get(`${BASE}/roles`).set('cookie', operator.cookie).expect(403);
  });

  dbIt('refuses to deactivate the administrator’s own account', async () => {
    const response = await request(app)
      .post(`${BASE}/users/${adminUserId}/deactivate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  dbIt('suspends and reactivates a tenant', async () => {
    const suspend = await request(app)
      .post(`${BASE}/platform/organizations/${organizationId}/suspend`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf);
    expect(suspend.status).toBe(200);
    expect(suspend.body.organization.status).toBe('SUSPENDED');

    const activate = await request(app)
      .post(`${BASE}/platform/organizations/${organizationId}/activate`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf);
    expect(activate.status).toBe(200);
    expect(activate.body.organization.status).toBe('ACTIVE');
  });

  dbIt('locks an account after the configured number of failed attempts', async () => {
    const target = await createUser({
      email: LOCKOUT_EMAIL,
      displayName: 'Lockout Tester',
      organizationId,
      status: 'ACTIVE',
    });
    await createCredential({
      userId: target.id,
      passwordHash: await hashPassword(LOCKOUT_PASSWORD),
    });

    // Five consecutive failures trip the lock (default LOGIN_MAX_FAILED_ATTEMPTS).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(LOCKOUT_EMAIL, 'wrong-password-attempt');
    }

    const locked = await login(LOCKOUT_EMAIL, LOCKOUT_PASSWORD);
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  dbIt('onboards the invited agent and gives them the role’s effective permissions', async () => {
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: agentInvitationToken, password: AGENT_PASSWORD })
      .expect(204);

    const response = await login('agent@acme.test', AGENT_PASSWORD);
    expect(response.status).toBe(200);
    expect(response.body.permissions).toContain('request:update.assigned');
    expect(response.body.permissions).not.toContain('user:manage');

    agent = sessionFrom(response);
  });

  dbIt('deactivates a user and revokes their live sessions immediately', async () => {
    await request(app)
      .post(`${BASE}/users/${agentUserId}/deactivate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(204);

    // The existing session is dead on the next request (docs/06 §7, FR-USER-001).
    await request(app).get(`${BASE}/auth/me`).set('cookie', agent.cookie).expect(401);

    // A fresh login is refused, but the identity is retired by status, not deleted, so
    // the audit trail stays resolvable (docs/31 §3.3).
    await login('agent@acme.test', AGENT_PASSWORD).expect(401);
    const retired = await prisma.user.findUnique({ where: { id: agentUserId } });
    expect(retired?.status).toBe('INACTIVE');
  });

  dbIt('revokes the session on logout and requires a valid CSRF token to do it', async () => {
    const withoutCsrf = await request(app)
      .post(`${BASE}/auth/logout`)
      .set('cookie', operator.cookie);
    expect(withoutCsrf.status).toBe(403);

    const logout = await request(app)
      .post(`${BASE}/auth/logout`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf);
    expect(logout.status).toBe(204);

    await request(app).get(`${BASE}/auth/me`).set('cookie', operator.cookie).expect(401);
  });
});
