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
import { processQueuedExports } from '../src/services/report-export.service';

/**
 * Async report exports — integration tests (docs/37 §3, docs/30 §3.4/§5, F-14).
 *
 * The behaviour under test is the security core of an export: it runs **as the requester**
 * (`docs/30` §3.2 R3), is **audited with its filters** (`R5`), and produces a
 * **time-limited** download that only the requester may fetch. Each of those is a leak
 * class if it regresses, so each gets an assertion.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@report-export.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-export.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const LEAD_EMAIL = 'lead@initech-export.test';
const LEAD_PASSWORD = 'N2wRt9-Pk6v!s';
const ALICE_EMAIL = 'alice@initech-export.test';
const ALICE_PASSWORD = 'V7kLm2-Qz9p!x';

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

interface ExportBody {
  export: {
    id: string;
    metric: string;
    status: string;
    rowCount: number;
    downloadUrl: string | null;
    expiresAt: string | null;
  };
}

describe('Async report exports', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let lead: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };
  let organizationId = '';
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

  dbIt('sets up a tenant with an admin, a lead and a requester', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Exports',
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

    lead = await onboard(LEAD_EMAIL, LEAD_PASSWORD, 'TEAM_LEAD', 'Initech Lead');
    alice = await onboard(ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');

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

    await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'Laptop for Alice', fields: {} })
      .expect(201);
  });

  dbIt('queues an export and returns 202 with a QUEUED job (docs/30 §5)', async () => {
    const response = await request(app)
      .post(`${BASE}/reports/requests.summary/export`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({});
    expect(response.status).toBe(202);
    const body = response.body as ExportBody;
    expect(body.export.status).toBe('QUEUED');
    expect(body.export.metric).toBe('requests.summary');
    expect(body.export.downloadUrl).toBeNull();
  });

  dbIt('refuses an export the caller may not request (route permission)', async () => {
    // A requester has `report:read` but not `report:export` (docs/30 §4).
    const response = await request(app)
      .post(`${BASE}/reports/requests.summary/export`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({});
    expect(response.status).toBe(403);
  });

  dbIt('records the export request and completion in the audit trail (R5)', async () => {
    await request(app)
      .post(`${BASE}/reports/requests.summary/export`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' })
      .expect(202);

    const result = await processQueuedExports();
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const requested = await prisma.auditLog.findMany({
      where: { entityType: 'ReportExport', action: 'report.export.requested' },
    });
    expect(requested.length).toBeGreaterThanOrEqual(1);

    const completed = await prisma.auditLog.findMany({
      where: { entityType: 'ReportExport', action: 'report.export.completed' },
    });
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  dbIt(
    'runs the job as the requester and exposes a time-limited download (docs/30 §3.4)',
    async () => {
      const created = await request(app)
        .post(`${BASE}/reports/requests.summary/export`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({});
      const id = (created.body as ExportBody).export.id;

      // Before the worker runs, the job is queued and has no download link.
      const pending = await request(app)
        .get(`${BASE}/reports/jobs/${id}`)
        .set('cookie', admin.cookie);
      expect(pending.status).toBe(200);
      expect(pending.body.export.status).toBe('QUEUED');

      await processQueuedExports();

      const done = await request(app).get(`${BASE}/reports/jobs/${id}`).set('cookie', admin.cookie);
      expect(done.status).toBe(200);
      const job = (done.body as ExportBody).export;
      expect(job.status).toBe('SUCCEEDED');
      expect(job.rowCount).toBeGreaterThan(0);
      expect(job.downloadUrl).toBe(`/api/v1/reports/jobs/${id}/download`);
      expect(job.expiresAt).not.toBeNull();

      const download = await request(app)
        .get(`${BASE}/reports/jobs/${id}/download`)
        .set('cookie', admin.cookie);
      expect(download.status).toBe(200);
      expect(download.headers['content-type']).toContain('text/csv');
      expect(download.headers['content-disposition']).toContain('attachment');
      expect(download.text).toContain('# metric,requests.summary');
      expect(download.text).toContain('category,key,value');
      // The report ran with the admin's cross-team scope (R3): tenure shows the scope.
      expect(download.text).toContain('# scope,any');
    },
  );

  dbIt('limits the job and its download to the requester (docs/30 §3.1)', async () => {
    const created = await request(app)
      .post(`${BASE}/reports/requests.summary/export`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({});
    const id = (created.body as ExportBody).export.id;
    await processQueuedExports();

    // The lead holds `report:export`, so the route lets them through — the service scopes
    // the export to its requester and answers 404, not a leak.
    const other = await request(app).get(`${BASE}/reports/jobs/${id}`).set('cookie', lead.cookie);
    expect(other.status).toBe(404);

    const download = await request(app)
      .get(`${BASE}/reports/jobs/${id}/download`)
      .set('cookie', lead.cookie);
    expect(download.status).toBe(404);
  });

  dbIt('rejects an expired download so a stale link cannot leak (docs/30 §5)', async () => {
    const created = await request(app)
      .post(`${BASE}/reports/requests.summary/export`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({});
    const id = (created.body as ExportBody).export.id;
    await processQueuedExports();

    await prisma.reportExport.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const download = await request(app)
      .get(`${BASE}/reports/jobs/${id}/download`)
      .set('cookie', admin.cookie);
    expect(download.status).toBe(404);
  });

  dbIt('rejects an unknown metric at request time (docs/30 §3.3)', async () => {
    const response = await request(app)
      .post(`${BASE}/reports/does.not.exist/export`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({});
    expect(response.status).toBe(404);
  });
});
