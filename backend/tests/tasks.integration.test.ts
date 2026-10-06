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
 * Tasks — integration tests (docs/37 §3 level 2, docs/24 §12).
 *
 * Runs against a real database because the behaviour under test is the state machine,
 * the `blocked_reason` CHECK constraint, the parent roll-up rule and per-parent
 * visibility — none of which a mock would assert.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@tasks.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-tasks.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'reporter@initech-tasks.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const OUTSIDER_EMAIL = 'outsider@initech-tasks.test';
const OUTSIDER_PASSWORD = 'Z8mPq3-Wt5n!k';
const AGENT_EMAIL = 'agent@initech-tasks.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';
const LEAD_EMAIL = 'lead@initech-tasks.test';
const LEAD_PASSWORD = 'J6tBv1-Yx4c!r';

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

describe('tasks', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string; userId: string };
  let outsider: { cookie: string; csrf: string; userId: string };
  let agent: { cookie: string; csrf: string; userId: string };
  let lead: { cookie: string; csrf: string; userId: string };
  let organizationId = '';
  let teamId = '';
  let agentUserId = '';
  let incidentId = '';
  let taskId = '';

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

  async function reportIncident(): Promise<string> {
    const response = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        title: 'Mail relay down',
        description: 'Delivery failing for the whole company.',
        impact: 'SIGNIFICANT',
        urgency: 'MEDIUM',
        teamId,
      });
    expect(response.status).toBe(201);
    return response.body.incident.id;
  }

  dbIt('sets up a tenant with a team, an agent and a lead', async () => {
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
    lead = await onboard(LEAD_EMAIL, LEAD_PASSWORD, 'TEAM_LEAD', 'Initech Lead');
    requester = await onboard(REQUESTER_EMAIL, REQUESTER_PASSWORD, 'REQUESTER', 'Initech Reporter');
    outsider = await onboard(OUTSIDER_EMAIL, OUTSIDER_PASSWORD, 'REQUESTER', 'Initech Outsider');
    agentUserId = agent.userId;

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    teamId = team.id;
    for (const userId of [agentUserId, lead.userId]) {
      await prisma.teamMember.create({
        data: { teamId, userId, organizationId, role: 'MEMBER' },
      });
    }
  });

  dbIt('creates a task on a visible parent and lists it', async () => {
    incidentId = await reportIncident();

    const created = await request(app)
      .post(`${BASE}/incidents/${incidentId}/tasks`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ title: 'Restart the relay', description: 'Bounce the mail relay service.' });
    expect(created.status).toBe(201);
    expect(created.body.task.status).toBe('TODO');
    expect(created.body.task.assignee).toBeNull();
    taskId = created.body.task.id;

    const list = await request(app)
      .get(`${BASE}/incidents/${incidentId}/tasks`)
      .set('cookie', agent.cookie);
    expect(list.status).toBe(200);
    expect((list.body.items as Array<{ id: string }>).some((t) => t.id === taskId)).toBe(true);
  });

  dbIt('refuses task creation to a caller without task:create', async () => {
    const response = await request(app)
      .post(`${BASE}/incidents/${incidentId}/tasks`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ title: 'Reporter task' });
    expect(response.status).toBe(403);
  });

  dbIt('refuses a task the caller cannot see, via the parent (rule T2)', async () => {
    const response = await request(app)
      .get(`${BASE}/tasks/${taskId}`)
      .set('cookie', outsider.cookie);
    expect(response.status).toBe(404);
  });

  dbIt('refuses to start an unassigned task, then starts it once assigned', async () => {
    const unassigned = await request(app)
      .post(`${BASE}/tasks/${taskId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' });
    expect(unassigned.status).toBe(403);

    await request(app)
      .post(`${BASE}/tasks/${taskId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agentUserId })
      .expect(200);

    const started = await request(app)
      .post(`${BASE}/tasks/${taskId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' });
    expect(started.status).toBe(200);
    expect(started.body.task.status).toBe('IN_PROGRESS');
  });

  dbIt('requires a reason to block, then clears it on unblock (docs/24 §12 AC2)', async () => {
    const withoutReason = await request(app)
      .post(`${BASE}/tasks/${taskId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'BLOCKED' });
    expect(withoutReason.status).toBe(409);
    expect(withoutReason.body.code).toBe('CONFLICT');

    const blocked = await request(app)
      .post(`${BASE}/tasks/${taskId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'BLOCKED', blockedReason: 'Waiting on the vendor' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.task.blockedReason).toBe('Waiting on the vendor');

    const unblocked = await request(app)
      .post(`${BASE}/tasks/${taskId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' });
    expect(unblocked.status).toBe(200);
    expect(unblocked.body.task.blockedReason).toBeNull();
  });

  dbIt('enforces the blocked_reason CHECK constraint at the database (docs/24 §3)', async () => {
    await expect(
      prisma.$executeRaw`
        UPDATE tasks SET status = 'BLOCKED', blocked_reason = NULL WHERE id = ${taskId}
      `,
    ).rejects.toThrow();
  });

  dbIt(
    'completes a task (setting completedAt) and treats DONE as terminal (docs/24 §12 AC1)',
    async () => {
      const done = await request(app)
        .post(`${BASE}/tasks/${taskId}/transition`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ to: 'DONE', completionNote: 'Relay bounced.' });
      expect(done.status).toBe(200);
      expect(done.body.task.completedAt).not.toBeNull();

      const illegal = await request(app)
        .post(`${BASE}/tasks/${taskId}/transition`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ to: 'IN_PROGRESS' });
      expect(illegal.status).toBe(409);
      expect(illegal.body.code).toBe('ILLEGAL_TRANSITION');
    },
  );

  dbIt(
    'blocks resolving a parent over open tasks without the override (docs/24 §12 AC3)',
    async () => {
      const parentId = await reportIncident();
      await request(app)
        .post(`${BASE}/incidents/${parentId}/tasks`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ title: 'Open work', assigneeId: agentUserId })
        .expect(201);

      // Assign and start the incident so it can be resolved.
      await request(app)
        .post(`${BASE}/incidents/${parentId}/assign`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ assigneeId: agentUserId })
        .expect(200);

      // The agent may resolve incidents but does not hold `task:override`.
      const denied = await request(app)
        .post(`${BASE}/incidents/${parentId}/resolve`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ resolutionSummary: 'Done', reason: 'Moving on' });
      expect(denied.status).toBe(409);
      expect(denied.body.code).toBe('CONFLICT');

      // The lead holds `task:override` and can resolve with a reason.
      const overridden = await request(app)
        .post(`${BASE}/incidents/${parentId}/resolve`)
        .set('cookie', lead.cookie)
        .set('x-csrf-token', lead.csrf)
        .send({ resolutionSummary: 'Resolved with open work', reason: 'Handled as a follow-up' });
      expect(overridden.status).toBe(200);
      expect(overridden.body.incident.status).toBe('RESOLVED');

      const audit = await prisma.auditLog.findFirst({
        where: { entityId: parentId, action: 'task.rollup.override' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.reason).toBe('Handled as a follow-up');
    },
  );

  dbIt('lists the caller’s assigned tasks', async () => {
    const response = await request(app).get(`${BASE}/tasks`).set('cookie', agent.cookie);
    expect(response.status).toBe(200);
    expect((response.body.items as Array<{ id: string }>).some((t) => t.id === taskId)).toBe(true);
  });

  dbIt('requires the cancel permission and a reason to cancel a task', async () => {
    const created = await request(app)
      .post(`${BASE}/incidents/${incidentId}/tasks`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ title: 'Will be cancelled', assigneeId: agentUserId });
    const cancelId = created.body.task.id;

    // The assignee (agent) lacks `task:cancel`.
    const noPermission = await request(app)
      .post(`${BASE}/tasks/${cancelId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'CANCELLED', reason: 'Not needed' });
    expect(noPermission.status).toBe(403);

    // The lead holds `task:cancel` but must supply a reason.
    const noReason = await request(app)
      .post(`${BASE}/tasks/${cancelId}/transition`)
      .set('cookie', lead.cookie)
      .set('x-csrf-token', lead.csrf)
      .send({ to: 'CANCELLED' });
    expect(noReason.status).toBe(409);

    const cancelled = await request(app)
      .post(`${BASE}/tasks/${cancelId}/transition`)
      .set('cookie', lead.cookie)
      .set('x-csrf-token', lead.csrf)
      .send({ to: 'CANCELLED', reason: 'Superseded by a checklist field' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task.status).toBe('CANCELLED');
  });
});
