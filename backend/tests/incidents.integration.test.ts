import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import { derivePriority } from '../src/services';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
} from '../src/models';

/**
 * Incidents — integration tests (docs/37 §3 level 2, docs/23 §13).
 *
 * Runs against a real database because the behaviour under test is the derivation
 * matrix, the state machine, reference allocation and the `resolutionSummary` CHECK
 * constraint — none of which a mock would assert. The nine matrix cells are additionally
 * asserted as a pure unit test, because the matrix is the requirement (AC1).
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@incidents.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-incidents.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'reporter@initech-incidents.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const AGENT_EMAIL = 'agent@initech-incidents.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';

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
       incidents, request_field_values, service_requests, comments, reference_sequences,
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

describe('incidents', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string; userId: string };
  let agent: { cookie: string; csrf: string; userId: string };
  let organizationId = '';
  let agentUserId = '';
  let teamId = '';
  let incidentId = '';

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

  dbIt('sets up a tenant with an agent and a reporter', async () => {
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
    requester = await onboard(REQUESTER_EMAIL, REQUESTER_PASSWORD, 'REQUESTER', 'Initech Reporter');
    agentUserId = agent.userId;

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    teamId = team.id;
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: agentUserId, organizationId, role: 'MEMBER' },
    });
  });

  it('derives all nine priority cells from impact × urgency (docs/23 §13 AC1)', () => {
    expect(derivePriority('EXTENSIVE', 'HIGH')).toBe('CRITICAL');
    expect(derivePriority('EXTENSIVE', 'MEDIUM')).toBe('HIGH');
    expect(derivePriority('EXTENSIVE', 'LOW')).toBe('MEDIUM');
    expect(derivePriority('SIGNIFICANT', 'HIGH')).toBe('HIGH');
    expect(derivePriority('SIGNIFICANT', 'MEDIUM')).toBe('MEDIUM');
    expect(derivePriority('SIGNIFICANT', 'LOW')).toBe('LOW');
    expect(derivePriority('MINOR', 'HIGH')).toBe('MEDIUM');
    expect(derivePriority('MINOR', 'MEDIUM')).toBe('LOW');
    expect(derivePriority('MINOR', 'LOW')).toBe('LOW');
  });

  dbIt('reports an incident with a generated reference, derived priority and a clock', async () => {
    const response = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        title: 'Email is unreachable',
        description: 'No mail is flowing to the whole company.',
        impact: 'EXTENSIVE',
        urgency: 'HIGH',
        teamId,
      });

    expect(response.status).toBe(201);
    const created = response.body.incident;
    expect(created.reference).toMatch(/^INC-\d{4}-\d{6}$/);
    expect(created.status).toBe('NEW');
    expect(created.priority).toBe('CRITICAL');
    expect(created.isMajor).toBe(false);
    incidentId = created.id;

    const clock = await prisma.slaClock.findFirst({
      where: { entityId: incidentId, entityType: 'Incident' },
    });
    expect(clock).not.toBeNull();
    expect(clock?.state).toBe('ON_TRACK');
  });

  dbIt('refuses to resolve an unassigned NEW incident (docs/23 §13 AC4)', async () => {
    // Assigning only a team does not set an assignee, so the incident stays NEW.
    const teamOnly = await request(app)
      .post(`${BASE}/incidents/${incidentId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ teamId });
    expect(teamOnly.status).toBe(200);
    expect(teamOnly.body.incident.status).toBe('NEW');

    const response = await request(app)
      .post(`${BASE}/incidents/${incidentId}/resolve`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ resolutionSummary: 'Premature' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ILLEGAL_TRANSITION');
  });

  dbIt('assigning a NEW incident moves it to IN_PROGRESS (rule I2)', async () => {
    const response = await request(app)
      .post(`${BASE}/incidents/${incidentId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agentUserId });
    expect(response.status).toBe(200);
    expect(response.body.incident.status).toBe('IN_PROGRESS');
    expect(response.body.incident.assignee.id).toBe(agentUserId);
  });

  dbIt('rejects an empty resolution summary (docs/23 §13 AC3)', async () => {
    const response = await request(app)
      .post(`${BASE}/incidents/${incidentId}/resolve`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ resolutionSummary: '' });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  dbIt('resolves with a summary and stops the clock', async () => {
    const response = await request(app)
      .post(`${BASE}/incidents/${incidentId}/resolve`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ resolutionSummary: 'Mail relay restarted; delivery confirmed.' });
    expect(response.status).toBe(200);
    expect(response.body.incident.status).toBe('RESOLVED');
    expect(response.body.incident.resolvedAt).not.toBeNull();

    const clock = await prisma.slaClock.findFirst({ where: { entityId: incidentId } });
    expect(clock?.stoppedAt).not.toBeNull();
    expect(clock?.state).toBe('STOPPED');
  });

  dbIt('enforces the resolutionSummary CHECK constraint at the database (docs/23 §4)', async () => {
    await expect(
      prisma.$executeRaw`
        UPDATE incidents SET status = 'RESOLVED', resolution_summary = NULL WHERE id = ${incidentId}
      `,
    ).rejects.toThrow();
  });

  dbIt(
    'reopens within the window, counting the reopen and starting a new clock cycle',
    async () => {
      const response = await request(app)
        .post(`${BASE}/incidents/${incidentId}/reopen`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({});
      expect(response.status).toBe(200);
      expect(response.body.incident.status).toBe('IN_PROGRESS');
      expect(response.body.incident.reopenCount).toBe(1);

      const clocks = await prisma.slaClock.findMany({
        where: { entityId: incidentId },
        orderBy: { cycle: 'asc' },
      });
      expect(clocks).toHaveLength(2);
      expect(clocks[1]?.cycle).toBe(2);
      expect(clocks[1]?.stoppedAt).toBeNull();
    },
  );

  dbIt('toggles the major flag in both directions and audits each change', async () => {
    await request(app)
      .post(`${BASE}/incidents/${incidentId}/major`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ isMajor: true })
      .expect(200);
    await request(app)
      .post(`${BASE}/incidents/${incidentId}/major`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ isMajor: false, reason: 'Downgraded after vendor confirmation' })
      .expect(200);

    const actions = await prisma.auditLog.findMany({
      where: { entityType: 'Incident', entityId: incidentId },
      select: { action: true },
    });
    const values = actions.map((row) => row.action);
    expect(values).toContain('incident.major.set');
    expect(values).toContain('incident.major.clear');
  });

  dbIt(
    'rejects a priority override without a reason, then records the override with one',
    async () => {
      const withoutReason = await request(app)
        .patch(`${BASE}/incidents/${incidentId}`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ priority: 'LOW' });
      expect(withoutReason.status).toBe(422);
      expect(withoutReason.body.code).toBe('VALIDATION_FAILED');

      const override = await request(app)
        .patch(`${BASE}/incidents/${incidentId}`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ priority: 'LOW', reason: 'Business impact reassessed' });
      expect(override.status).toBe(200);
      expect(override.body.incident.priority).toBe('LOW');

      const audit = await prisma.auditLog.findFirst({
        where: { entityId: incidentId, action: 'incident.priority.override' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.reason).toBe('Business impact reassessed');
    },
  );

  dbIt('re-derives priority when impact or urgency changes (docs/23 §12)', async () => {
    const response = await request(app)
      .patch(`${BASE}/incidents/${incidentId}`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ impact: 'MINOR', urgency: 'LOW' });
    expect(response.status).toBe(200);
    expect(response.body.incident.priority).toBe('LOW');
  });

  dbIt('never exposes an internal note to the reporter (rule I7)', async () => {
    await request(app)
      .post(`${BASE}/incidents/${incidentId}/comments`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ body: 'Root cause under review.', visibility: 'INTERNAL' })
      .expect(201);
    await request(app)
      .post(`${BASE}/incidents/${incidentId}/comments`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ body: 'Mail is working again.', visibility: 'PUBLIC' })
      .expect(201);

    const requesterView = await request(app)
      .get(`${BASE}/incidents/${incidentId}/comments`)
      .set('cookie', requester.cookie);
    const bodies = (requesterView.body.items as Array<{ body: string }>).map((c) => c.body);
    expect(bodies).toContain('Mail is working again.');
    expect(bodies).not.toContain('Root cause under review.');
  });

  dbIt('refuses a reporter the ability to update or mark an incident major', async () => {
    const patch = await request(app)
      .patch(`${BASE}/incidents/${incidentId}`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ title: 'Renamed by reporter' });
    expect(patch.status).toBe(403);

    const major = await request(app)
      .post(`${BASE}/incidents/${incidentId}/major`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ isMajor: true });
    expect(major.status).toBe(403);
  });

  dbIt('exposes the audit history of the incident', async () => {
    const response = await request(app)
      .get(`${BASE}/incidents/${incidentId}/history?limit=50`)
      .set('cookie', agent.cookie);
    expect(response.status).toBe(200);
    const actions = (response.body.history as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('incident.create');
    expect(actions).toContain('incident.resolve');
  });

  dbIt('resolves, closes, then requires a reason to reopen outside the window', async () => {
    // Resolve again (it was reopened above), then close as the reporter.
    await request(app)
      .post(`${BASE}/incidents/${incidentId}/resolve`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ resolutionSummary: 'Confirmed stable.' })
      .expect(200);
    await request(app)
      .post(`${BASE}/incidents/${incidentId}/close`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .expect(200);

    // Move the close far into the past so reopening crosses the configured window.
    await prisma.incident.update({
      where: { id: incidentId },
      data: { closedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
    });

    const reporterNoReason = await request(app)
      .post(`${BASE}/incidents/${incidentId}/reopen`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({});
    expect(reporterNoReason.status).toBe(403);

    const agentNoReason = await request(app)
      .post(`${BASE}/incidents/${incidentId}/reopen`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({});
    expect(agentNoReason.status).toBe(422);

    const override = await request(app)
      .post(`${BASE}/incidents/${incidentId}/reopen`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ reason: 'Recurrence reported by users' });
    expect(override.status).toBe(200);
    expect(override.body.incident.status).toBe('IN_PROGRESS');
  });
});
