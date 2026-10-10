import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import { runSlaSweep } from '../src/services';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
} from '../src/models';

/**
 * SLA sweep and pause/resume — integration tests (docs/37 §3, docs/25 §3/§5/§6).
 *
 * Runs against a real database because the behaviour under test is a bulk state
 * transition with idempotency, and the pause arithmetic on the stored target instants.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@sla.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-sla.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'requester@initech-sla.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const AGENT_EMAIL = 'agent@initech-sla.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';
const APPROVER_EMAIL = 'approver@initech-sla.test';
const APPROVER_PASSWORD = 'N2wRt9-Pk6v!s';

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

describe('SLA sweep and pause/resume', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string; userId: string };
  let agent: { cookie: string; csrf: string; userId: string };
  let organizationId = '';
  let itemId = '';
  let agentUserId = '';
  let requestId = '';

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

  dbIt('sets up a tenant, an approvable item and default SLA policy', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));

    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
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

    agent = await onboard(AGENT_EMAIL, AGENT_PASSWORD, 'AGENT', 'Initech Agent');
    requester = await onboard(
      REQUESTER_EMAIL,
      REQUESTER_PASSWORD,
      'REQUESTER',
      'Initech Requester',
    );
    await onboard(APPROVER_EMAIL, APPROVER_PASSWORD, 'APPROVER', 'Initech Approver');
    agentUserId = agent.userId;

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: agentUserId, organizationId, role: 'MEMBER' },
    });

    const policies = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
    const policyId = (policies.body.items as Array<{ id: string; isDefault: boolean }>).find(
      (p) => p.isDefault,
    )?.id;

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
        name: 'Gated access',
        defaultPriority: 'HIGH',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: team.id,
        requiresApproval: true,
        fields: [],
      });
    itemId = item.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    await request(app)
      .post(`${BASE}/admin/approval-templates`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        catalogItemId: itemId,
        name: 'Single approval',
        steps: [{ stepOrder: 1, mode: 'ANY', approverRoleKey: 'APPROVER' }],
      })
      .expect(201);
  });

  async function raiseRequest(title: string): Promise<string> {
    const response = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ catalogItemId: itemId, title, fields: {} });
    expect(response.status).toBe(201);
    return response.body.request.id;
  }

  dbIt('breaches a running clock whose target has passed, and is idempotent', async () => {
    requestId = await raiseRequest('SLA breach check');

    const past = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.slaClock.updateMany({
      where: { entityId: requestId, entityType: 'ServiceRequest' },
      data: { targetAt: past, warnAt: past },
    });

    const first = await runSlaSweep(new Date());
    expect(first.breached).toBeGreaterThanOrEqual(1);

    const clock = await prisma.slaClock.findFirstOrThrow({ where: { entityId: requestId } });
    expect(clock.state).toBe('BREACHED');
    expect(clock.breachedAt).not.toBeNull();

    // A second run in the same interval must not produce a duplicate breach.
    const second = await runSlaSweep(new Date());
    expect(second.breached).toBe(0);
    const breachEvents = await prisma.outbox.count({
      where: { idempotencyKey: `sla.breached:${clock.id}` },
    });
    expect(breachEvents).toBe(1);
  });

  dbIt('marks a clock AT_RISK when it crosses the warn threshold', async () => {
    const id = await raiseRequest('SLA at-risk check');
    const past = new Date(Date.now() - 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.slaClock.updateMany({
      where: { entityId: id, entityType: 'ServiceRequest' },
      data: { warnAt: past, targetAt: future },
    });

    const result = await runSlaSweep(new Date());
    expect(result.atRisk).toBeGreaterThanOrEqual(1);

    const clock = await prisma.slaClock.findFirstOrThrow({ where: { entityId: id } });
    expect(clock.state).toBe('AT_RISK');
    expect(clock.breachedAt).toBeNull();
  });

  dbIt('pauses the clock on APPROVAL_PENDING and pushes the target out on resume', async () => {
    const id = await raiseRequest('Gated approval');
    const before = await prisma.slaClock.findFirstOrThrow({ where: { entityId: id } });

    // Reach APPROVAL_PENDING: assign to the agent, then triage.
    await request(app)
      .post(`${BASE}/requests/${id}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agentUserId })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${id}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'TRIAGED' })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${id}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'APPROVAL_PENDING' })
      .expect(200);

    const paused = await prisma.slaClock.findFirstOrThrow({ where: { entityId: id } });
    expect(paused.state).toBe('PAUSED');
    expect(paused.pausedAt).not.toBeNull();

    // Simulate an hour-long approval wait, then resume by cancelling.
    const pausedAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.slaClock.update({ where: { id: paused.id }, data: { pausedAt } });

    await request(app)
      .post(`${BASE}/requests/${id}/cancel`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ reason: 'No longer needed' })
      .expect(200);

    const resumed = await prisma.slaClock.findFirstOrThrow({ where: { id: paused.id } });
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.stoppedAt).not.toBeNull();

    // The pause excludes only the *working* minutes inside it (docs/25 §14 AC2), so the
    // shift can never exceed the wall-clock pause and can never move the target
    // backwards. This bound is calendar- and time-of-day independent by construction;
    // the exact arithmetic for a working-hours calendar is asserted with explicit
    // timestamps in `sla-worked-examples.test.ts`, which does not read the wall clock.
    const wallPauseSeconds = Math.round((Date.now() - pausedAt.getTime()) / 1000);
    const shiftMs = resumed.targetAt.getTime() - before.targetAt.getTime();
    expect(shiftMs).toBeGreaterThanOrEqual(0);
    expect(shiftMs).toBeLessThanOrEqual((wallPauseSeconds + 5) * 1000);
    expect(resumed.totalPausedSeconds).toBeGreaterThanOrEqual(0);
    expect(resumed.totalPausedSeconds).toBeLessThanOrEqual(wallPauseSeconds + 5);
  });
});
