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
 * Integration configuration administration — integration tests (`docs/37` §3, `docs/32` §11/§12).
 *
 * The security core of this surface is what it must **refuse**:
 *
 *   - a caller without `admin:config` cannot change configuration, even one who can read it;
 *   - a request that tries to persist a **credential value** in `credentialRef` is rejected —
 *     credentials are runtime-injected and never stored (`17` §3);
 *   - an unknown integration key is a 404, not a silent free-form row.
 *
 * The positive path asserts the audit record exists and carries the reference but never a
 * secret, and that an override is merged over the catalogue defaults rather than replacing
 * them.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@integration-config.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-config.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'req@initech-config.test';
const REQUESTER_PASSWORD = 'R3quester-Passphrase!';

interface IntegrationRow {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, number>;
  defaults: Record<string, number>;
  credentialRef: string | null;
  usesCredential: boolean;
  testable: boolean;
  lastTestStatus: string | null;
}

let databaseAvailable = false;

function dbIt(name: string, fn: () => Promise<void> | void): void {
  it(name, async (ctx) => {
    if (!databaseAvailable) ctx.skip();
    await fn();
  });
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

describe('Integration configuration administration', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string };
  let organizationId = '';

  beforeAll(async () => {
    try {
      await prisma.permission.count();
      databaseAvailable = true;
    } catch {
      databaseAvailable = false;
      return;
    }

    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE
         integration_settings, webhook_deliveries, webhook_subscriptions, webhook_fanout_states,
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

  dbIt('provisions a tenant with an administrator and a requester', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Config',
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
    requester = await onboard(REQUESTER_EMAIL, REQUESTER_PASSWORD, 'REQUESTER', 'Rita Requester');
  });

  dbIt(
    'lists the catalogue with defaults and refuses a caller without integration:read',
    async () => {
      const listed = await request(app)
        .get(`${BASE}/admin/integrations/config`)
        .set('cookie', admin.cookie)
        .expect(200);

      const rows = listed.body.integrations as IntegrationRow[];
      // The catalogue is the single source of truth for "which integrations exist", so it is
      // asserted exactly: an integration that appears without an entry here would be
      // invisible to an administrator, and one that disappears silently would be worse.
      // `antivirus` was added with the asynchronous scan step (`docs/19` §7.2).
      expect(rows.map((row) => row.key).sort()).toEqual([
        'antivirus',
        'directory',
        'email',
        'inbound_webhooks',
        'webhooks',
      ]);
      const email = rows.find((row) => row.key === 'email');
      expect(email?.config.breakerFailureThreshold).toBe(email?.defaults.breakerFailureThreshold);
      expect(email?.enabled).toBe(true);

      // A requester holds no `integration:*` grant, so the whole surface is out of reach.
      await request(app)
        .get(`${BASE}/admin/integrations/config`)
        .set('cookie', requester.cookie)
        .expect(403);
      await request(app)
        .patch(`${BASE}/admin/integrations/config/email`)
        .set('cookie', requester.cookie)
        .set('x-csrf-token', requester.csrf)
        .send({ enabled: false })
        .expect(403);
    },
  );

  dbIt('persists an override and merges it over the catalogue defaults', async () => {
    const patched = await request(app)
      .patch(`${BASE}/admin/integrations/config/email`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ enabled: false, config: { breakerFailureThreshold: 9 } })
      .expect(200);

    const email = patched.body.integration as IntegrationRow;
    expect(email.enabled).toBe(false);
    expect(email.config.breakerFailureThreshold).toBe(9);
    // Untouched knobs keep their default; the override never replaces the whole object.
    expect(email.config.timeoutMs).toBe(email.defaults.timeoutMs);

    // Re-read proves it was stored, not merely echoed.
    const reread = await request(app)
      .get(`${BASE}/admin/integrations/config`)
      .set('cookie', admin.cookie)
      .expect(200);
    const stored = (reread.body.integrations as IntegrationRow[]).find(
      (row) => row.key === 'email',
    );
    expect(stored?.enabled).toBe(false);
    expect(stored?.config.breakerFailureThreshold).toBe(9);
  });

  dbIt('rejects a credential value and accepts a credential reference', async () => {
    const rejected = await request(app)
      .patch(`${BASE}/admin/integrations/config/email`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ credentialRef: 'SG.super-secret-api-key-value' })
      // 422, not 400: the request parsed and failed validation (docs/11 §3).
      .expect(422);
    expect(rejected.body.errors?.[0]?.field).toBe('credentialRef');

    const accepted = await request(app)
      .patch(`${BASE}/admin/integrations/config/email`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ credentialRef: 'env:SENDGRID_API_KEY' })
      .expect(200);
    expect((accepted.body.integration as IntegrationRow).credentialRef).toBe(
      'env:SENDGRID_API_KEY',
    );
  });

  dbIt('records the change in the audit log without ever storing the secret', async () => {
    const entries = await prisma.auditLog.findMany({
      where: { organizationId, action: 'integration.config.update' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    // The reference is auditable; a credential value never is.
    expect(serialized).toContain('env:SENDGRID_API_KEY');
    expect(serialized).not.toContain('SG.super-secret-api-key-value');
  });

  dbIt('treats an unknown integration key as not found', async () => {
    await request(app)
      .patch(`${BASE}/admin/integrations/config/not_a_real_integration`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ enabled: true })
      .expect(404);
  });

  dbIt('tests a testable integration and skips one with no global endpoint', async () => {
    const email = await request(app)
      .post(`${BASE}/admin/integrations/config/email/test`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
    // The test environment uses the logging adapter, which is a real (non-unsupported) adapter.
    expect(email.body.result.status).toBe('OK');

    const webhooks = await request(app)
      .post(`${BASE}/admin/integrations/config/webhooks/test`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
    expect(webhooks.body.result.status).toBe('SKIPPED');
  });
});
