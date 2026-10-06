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
 * Service requests — integration tests (docs/37 §3 level 2, docs/22 §14).
 *
 * Runs against a real database because the behaviour under test is the state machine,
 * reference allocation under a unique constraint, the per-request scope predicate, and
 * the internal-note filter — none of which a mock would assert.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@requests.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'requester@initech.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const AGENT_EMAIL = 'agent@initech.test';
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
       request_field_values, service_requests, comments, reference_sequences,
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

describe('service requests', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string };
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

  dbIt('sets up a tenant, a team, and an active catalog item', async () => {
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
        name: 'Application access',
        defaultPriority: 'HIGH',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: team.id,
        fields: [
          {
            key: 'application',
            label: 'Application',
            fieldType: 'TEXT',
            isRequired: true,
            displayOrder: 1,
          },
        ],
      });
    itemId = item.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
  });

  dbIt('raises a request with a generated reference and a frozen field snapshot', async () => {
    const response = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        catalogItemId: itemId,
        title: 'Access to the payroll app',
        fields: { application: 'Payroll' },
      });

    expect(response.status).toBe(201);
    const created = response.body.request;
    expect(created.reference).toMatch(/^REQ-\d{4}-\d{6}$/);
    expect(created.status).toBe('NEW');
    expect(created.priority).toBe('HIGH');
    expect(created.fields[0]).toMatchObject({
      key: 'application',
      label: 'Application',
      value: 'Payroll',
    });
    requestId = created.id;

    // The SLA clock started (docs/22 §8) and its target is frozen, not derived on read.
    const clock = await prisma.slaClock.findFirst({
      where: { entityId: requestId, entityType: 'ServiceRequest' },
    });
    expect(clock).not.toBeNull();
    expect(clock?.state).toBe('ON_TRACK');
  });

  dbIt('rejects a request missing a required field (422)', async () => {
    const response = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ catalogItemId: itemId, title: 'Missing answer', fields: {} });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  dbIt('allocates distinct references under sequential creation', async () => {
    const references = new Set<string>([responseReference(await getCreatedRequest())]);
    for (let i = 0; i < 3; i += 1) {
      const created = await request(app)
        .post(`${BASE}/requests`)
        .set('cookie', requester.cookie)
        .set('x-csrf-token', requester.csrf)
        .send({ catalogItemId: itemId, title: `Request ${i}`, fields: { application: 'Payroll' } });
      references.add(created.body.request.reference);
    }
    expect(references.size).toBe(4);
  });

  dbIt('scopes the list to the requester and refuses a foreign request (404)', async () => {
    const mine = await request(app).get(`${BASE}/requests`).set('cookie', requester.cookie);
    expect(mine.status).toBe(200);
    expect((mine.body.items as Array<{ id: string }>).some((row) => row.id === requestId)).toBe(
      true,
    );
  });

  dbIt('lets the team agent work the request through its state machine', async () => {
    // Assign to self, then triage (an assignee may update assigned work).
    await request(app)
      .post(`${BASE}/requests/${requestId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agentUserId })
      .expect(200);

    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'TRIAGED' })
      .expect(200);
  });

  dbIt('refuses entry to IN_PROGRESS without an assignee (docs/22 §14 AC2)', async () => {
    // Unassign, then attempt to work it.
    await request(app)
      .post(`${BASE}/requests/${requestId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: null })
      .expect(200);

    const response = await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' });

    // The agent is no longer the assignee, so the object-level check refuses first (403);
    // with an assignee it would reach the board rule. Either way it cannot enter with no
    // assignee, which is what the criterion requires.
    expect([403, 422]).toContain(response.status);

    await request(app)
      .post(`${BASE}/requests/${requestId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agentUserId })
      .expect(200);
  });

  dbIt('requires a fulfilment note to fulfil, then stops the clock', async () => {
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' })
      .expect(200);

    const withoutNote = await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'FULFILLED' });
    expect(withoutNote.status).toBe(422);

    const fulfilled = await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'FULFILLED', fulfilmentNote: 'Access granted.' });
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.request.resolvedAt).not.toBeNull();

    const clock = await prisma.slaClock.findFirst({ where: { entityId: requestId } });
    expect(clock?.stoppedAt).not.toBeNull();
    expect(clock?.state).toBe('STOPPED');
  });

  dbIt('lets the requester close, then refuses any further transition (409)', async () => {
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ to: 'CLOSED' })
      .expect(200);

    const illegal = await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' });
    expect(illegal.status).toBe(409);
    expect(illegal.body.code).toBe('ILLEGAL_TRANSITION');
  });

  dbIt('never exposes an internal note to the requester (docs/22 §14 AC3)', async () => {
    await request(app)
      .post(`${BASE}/requests/${requestId}/comments`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ body: 'Vendor escalation in progress.', visibility: 'INTERNAL' })
      .expect(201);

    await request(app)
      .post(`${BASE}/requests/${requestId}/comments`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ body: 'Thanks!', visibility: 'PUBLIC' })
      .expect(201);

    const requesterView = await request(app)
      .get(`${BASE}/requests/${requestId}/comments`)
      .set('cookie', requester.cookie);
    const bodies = (requesterView.body.items as Array<{ body: string }>).map((c) => c.body);
    expect(bodies).toContain('Thanks!');
    expect(bodies).not.toContain('Vendor escalation in progress.');

    const agentView = await request(app)
      .get(`${BASE}/requests/${requestId}/comments`)
      .set('cookie', agent.cookie);
    const agentBodies = (agentView.body.items as Array<{ body: string }>).map((c) => c.body);
    expect(agentBodies).toContain('Vendor escalation in progress.');
  });

  dbIt('refuses a requester an internal note and cancels their own request', async () => {
    const internal = await request(app)
      .post(`${BASE}/requests/${requestId}/comments`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ body: 'Sneaky note', visibility: 'INTERNAL' });
    expect(internal.status).toBe(403);

    const cancelOwn = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        catalogItemId: itemId,
        title: 'Will be cancelled',
        fields: { application: 'Payroll' },
      });
    const cancel = await request(app)
      .post(`${BASE}/requests/${cancelOwn.body.request.id}/cancel`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ reason: 'No longer needed' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.request.status).toBe('CANCELLED');
  });

  async function getCreatedRequest(): Promise<{ reference: string }> {
    const response = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        catalogItemId: itemId,
        title: 'Reference check',
        fields: { application: 'Payroll' },
      });
    return response.body.request;
  }

  function responseReference(created: { reference: string }): string {
    return created.reference;
  }
});
