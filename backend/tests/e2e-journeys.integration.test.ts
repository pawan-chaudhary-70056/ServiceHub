import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import { drainOutbox } from '../src/services';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
} from '../src/models';

/**
 * The four end-to-end journeys of docs/37 §7, driven through the real HTTP surface against
 * a real database:
 *
 *   1. Sign in → raise a request → approval → resolution   (auth · catalog · requests · approvals · SLA)
 *   2. Raise an incident → assign → resolve → notification  (incidents · notifications)
 *   3. Search finds a restricted record only for an authorised user  (cross-cutting authz)
 *   4. Admin edits a catalog item → the previous request is unchanged  (in-flight fidelity)
 *
 * These are journeys whose **integration** is the risk, not the individual steps: each
 * crosses module boundaries, and each asserts the property the boundary exists to protect.
 *
 * The suite runs in-process against the real Express app (`docs/37` §10 puts the same
 * assertions on a deployed staging target); a deployed form would reuse these requests.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@journey.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-journey.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const AGENT_EMAIL = 'agent@initech-journey.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';
const APPROVER_EMAIL = 'approver@initech-journey.test';
const APPROVER_PASSWORD = 'N2wRt9-Pk6v!s';
const REQUESTER_EMAIL = 'requester@initech-journey.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const OUTSIDER_EMAIL = 'outsider@initech-journey.test';
const OUTSIDER_PASSWORD = 'M4dFs7-Qh3b!t';
const RIVAL_ADMIN_EMAIL = 'admin@umbrella-journey.test';
const RIVAL_ADMIN_PASSWORD = 'Z8mPq3-Wt5n!k';
const RIVAL_REQUESTER_EMAIL = 'requester@umbrella-journey.test';
const RIVAL_REQUESTER_PASSWORD = 'M4dFs7-Qh3b!t';

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
       approval_decisions, approval_step_approvers, approval_steps, approval_workflows,
       approval_templates,
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

type Session = { cookie: string; csrf: string; userId: string };

describe('docs/37 §7 end-to-end journeys', () => {
  let operator: Session;
  let admin: Session;
  let agent: Session;
  let approver: Session;
  let requester: Session;
  let outsider: Session;
  let rivalAdmin: Session;
  let rivalRequester: Session;
  let organizationId = '';

  let approvableItemId = '';
  let openItemId = '';
  let serviceDeskTeamId = '';

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

  /** Invites a user into the given tenant and returns their session. */
  async function onboard(
    adminSession: Session,
    email: string,
    password: string,
    roleKey: string,
    displayName: string,
  ): Promise<Session> {
    const roles = await request(app).get(`${BASE}/roles`).set('cookie', adminSession.cookie);
    const role = (roles.body.items as Array<{ id: string; key: string }>).find(
      (r) => r.key === roleKey,
    );
    const invited = await request(app)
      .post(`${BASE}/users`)
      .set('cookie', adminSession.cookie)
      .set('x-csrf-token', adminSession.csrf)
      .send({ email, roleId: role?.id, displayName });
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: invited.body.invitation.token, password })
      .expect(204);
    const session = sessionFrom(await login(email, password));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { ...session, userId: user.id };
  }

  async function provisionTenant(
    name: string,
    administratorEmail: string,
    administratorPassword: string,
  ): Promise<Session> {
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name,
        administratorEmail,
        administratorName: `${name} Admin`,
        defaultTimeZone: 'Europe/London',
      });
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: provisioned.body.invitation.token, password: administratorPassword })
      .expect(204);
    const session = sessionFrom(await login(administratorEmail, administratorPassword));
    const user = await prisma.user.findUniqueOrThrow({ where: { email: administratorEmail } });
    return { ...session, userId: user.id };
  }

  dbIt('sets up Initech: a team, an approvable item and an open item', async () => {
    const operatorSession = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    operator = { ...operatorSession, userId: '' };

    admin = await provisionTenant('Initech', ADMIN_EMAIL, ADMIN_PASSWORD);
    organizationId = (await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } }))
      .organizationId as string;

    agent = await onboard(admin, AGENT_EMAIL, AGENT_PASSWORD, 'AGENT', 'Initech Agent');
    approver = await onboard(
      admin,
      APPROVER_EMAIL,
      APPROVER_PASSWORD,
      'APPROVER',
      'Initech Approver',
    );
    requester = await onboard(
      admin,
      REQUESTER_EMAIL,
      REQUESTER_PASSWORD,
      'REQUESTER',
      'Initech Requester',
    );
    outsider = await onboard(
      admin,
      OUTSIDER_EMAIL,
      OUTSIDER_PASSWORD,
      'REQUESTER',
      'Initech Other',
    );

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    serviceDeskTeamId = team.id;
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: agent.userId, organizationId, role: 'MEMBER' },
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

    const approvable = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'Gated application access',
        defaultPriority: 'HIGH',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: team.id,
        requiresApproval: true,
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
    approvableItemId = approvable.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${approvableItemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    await request(app)
      .post(`${BASE}/admin/approval-templates`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        catalogItemId: approvableItemId,
        name: 'Single approval',
        steps: [{ stepOrder: 1, mode: 'ANY', approverRoleKey: 'APPROVER' }],
      })
      .expect(201);

    const open = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'Standard laptop',
        defaultPriority: 'MEDIUM',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: team.id,
        fields: [
          {
            key: 'model',
            label: 'Model',
            fieldType: 'TEXT',
            isRequired: false,
            displayOrder: 1,
          },
        ],
      });
    openItemId = open.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${openItemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
  });

  // -------------------------------------------------------------------------
  // Journey 1 — Sign in → raise a request → approval → resolution
  // -------------------------------------------------------------------------
  dbIt('journey 1: raises, approves and resolves a request across the whole stack', async () => {
    // Sign in is the entry point; the session cookie is what every later call uses.
    const loginResponse = await login(REQUESTER_EMAIL, REQUESTER_PASSWORD);
    expect(loginResponse.status).toBe(200);
    const session = sessionFrom(loginResponse);

    const raised = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .send({
        catalogItemId: approvableItemId,
        title: 'Access to the payroll application',
        fields: { application: 'Payroll' },
      });
    expect(raised.status).toBe(201);
    const requestId = raised.body.request.id as string;
    expect(raised.body.request.status).toBe('NEW');
    // The answer is stored against the item's label, not just its key (rule R9/C3).
    expect(raised.body.request.fields[0]).toMatchObject({
      key: 'application',
      label: 'Application',
      value: 'Payroll',
    });

    // An agent triages, then moves the request into approval.
    await request(app)
      .post(`${BASE}/requests/${requestId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agent.userId })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'TRIAGED' })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'APPROVAL_PENDING' })
      .expect(200);

    // Entering APPROVAL_PENDING started a workflow and paused the clock (docs/26, docs/25).
    const pausedClock = await prisma.slaClock.findFirstOrThrow({
      where: { entityId: requestId, entityType: 'ServiceRequest' },
    });
    expect(pausedClock.state).toBe('PAUSED');

    // The designated approver sees the decision; the requester may not even know it exists.
    const pending = await request(app)
      .get(`${BASE}/approvals/pending`)
      .set('cookie', approver.cookie);
    expect(pending.status).toBe(200);
    const workflow = (
      pending.body.items as Array<{
        request: { id: string };
        steps: Array<{ id: string; status: string }>;
      }>
    ).find((item) => item.request.id === requestId);
    expect(workflow).toBeDefined();
    const stepId = workflow?.steps[0]?.id as string;

    // A5 visibility: the requester is not a designated approver, so the workflow is a 404.
    const asRequester = await request(app)
      .get(`${BASE}/requests/${requestId}/approvals`)
      .set('cookie', requester.cookie);
    expect(asRequester.status).toBe(404);

    await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver.cookie)
      .set('x-csrf-token', approver.csrf)
      .send({ decision: 'APPROVE', comment: 'Within policy.' })
      .expect(200);

    const approved = await request(app)
      .get(`${BASE}/requests/${requestId}`)
      .set('cookie', agent.cookie);
    expect(approved.body.request.status).toBe('APPROVED');
    // Approval resumed the clock (the pause is excluded, not lost).
    const resumedClock = await prisma.slaClock.findFirstOrThrow({
      where: { entityId: requestId, entityType: 'ServiceRequest' },
    });
    expect(resumedClock.pausedAt).toBeNull();

    // The agent fulfils and closes the request.
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'FULFILLED', fulfilmentNote: 'Access granted in the directory.' })
      .expect(200);
    // Closing is the requester's confirmation (an agent holds `request:update.assigned`
    // but not `request:close.any`), which also exercises the requester's own-scope path.
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ to: 'CLOSED' })
      .expect(200);

    const closed = await request(app)
      .get(`${BASE}/requests/${requestId}`)
      .set('cookie', requester.cookie);
    expect(closed.body.request.status).toBe('CLOSED');

    // The SLA clock stopped at resolution (docs/25 §3).
    const stoppedClock = await prisma.slaClock.findFirstOrThrow({
      where: { entityId: requestId, entityType: 'ServiceRequest' },
    });
    expect(stoppedClock.stoppedAt).not.toBeNull();

    // Every transition left an audit record (docs/31 §4).
    const trail = await prisma.auditLog.findMany({
      where: { entityType: 'ServiceRequest', entityId: requestId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(trail.map((row) => row.action)).toContain('request.status.change');
    expect(trail.length).toBeGreaterThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Journey 2 — Raise an incident → assign → resolve → notification
  // -------------------------------------------------------------------------
  dbIt('journey 2: reports, assigns, resolves an incident and notifies the assignee', async () => {
    const reported = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        title: 'Email relay is bouncing messages',
        description: 'Outbound mail is queued and rejected.',
        impact: 'SIGNIFICANT',
        urgency: 'HIGH',
        // Routing to the service desk is what lets an agent see and take the incident.
        teamId: serviceDeskTeamId,
      });
    expect(reported.status).toBe(201);
    const incidentId = reported.body.incident.id as string;
    // Priority is derived from impact × urgency, never sent by the client (docs/23 §3).
    expect(['HIGH', 'CRITICAL']).toContain(reported.body.incident.priority);

    await request(app)
      .post(`${BASE}/incidents/${incidentId}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agent.userId })
      .expect(200);

    // The assignment wrote an outbox event (docs/29 §3) rather than sending inline.
    const assignedEvent = await prisma.outbox.findFirst({
      where: { eventType: 'notification.incident.assigned' },
    });
    expect(assignedEvent).not.toBeNull();

    // Draining the outbox delivers the in-app notification to the assignee.
    await drainOutbox();
    const notification = await prisma.notification.findFirst({
      where: {
        userId: agent.userId,
        channel: 'IN_APP',
        eventType: 'notification.incident.assigned',
      },
    });
    expect(notification).not.toBeNull();
    expect(notification?.title).toBe('An incident was assigned to you');
    expect(notification?.linkUrl).toBe(`/incidents/${incidentId}`);

    await request(app)
      .post(`${BASE}/incidents/${incidentId}/resolve`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ resolutionSummary: 'Restarted the relay and cleared the queue.' })
      .expect(200);

    const resolved = await request(app)
      .get(`${BASE}/incidents/${incidentId}`)
      .set('cookie', requester.cookie);
    expect(resolved.body.incident.status).toBe('RESOLVED');
    expect(resolved.body.incident.resolutionSummary).toBe(
      'Restarted the relay and cleared the queue.',
    );

    // Resolution queued its own notification event (the reporter/assignee channel).
    const resolvedEvent = await prisma.outbox.findFirst({
      where: { eventType: 'notification.incident.resolved' },
    });
    expect(resolvedEvent).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Journey 3 — Search finds a restricted record only for an authorised user
  // -------------------------------------------------------------------------
  dbIt(
    'journey 3: search never leaks a record across the permission or tenant boundary',
    async () => {
      // Two records in Initech (one by the requester), plus a second tenant entirely.
      const mine = await request(app)
        .post(`${BASE}/requests`)
        .set('cookie', requester.cookie)
        .set('x-csrf-token', requester.csrf)
        .send({ catalogItemId: openItemId, title: 'Laptop for the payroll team', fields: {} });
      expect(mine.status).toBe(201);
      const myReference = mine.body.request.reference as string;

      const other = await request(app)
        .post(`${BASE}/requests`)
        .set('cookie', outsider.cookie)
        .set('x-csrf-token', outsider.csrf)
        .send({ catalogItemId: openItemId, title: 'Laptop for the marketing team', fields: {} });
      expect(other.status).toBe(201);

      // A completely separate tenant, so the sweep covers the tenant boundary (ADR-0002),
      // not only the in-tenant scope.
      rivalAdmin = await provisionTenant('Umbrella', RIVAL_ADMIN_EMAIL, RIVAL_ADMIN_PASSWORD);
      rivalRequester = await onboard(
        rivalAdmin,
        RIVAL_REQUESTER_EMAIL,
        RIVAL_REQUESTER_PASSWORD,
        'REQUESTER',
        'Umbrella Requester',
      );

      // The requester searching broadly sees only their own record.
      const asRequester = await request(app)
        .get(`${BASE}/search?q=Laptop`)
        .set('cookie', requester.cookie);
      const requesterRefs = (asRequester.body.items as Array<{ reference: string | null }>).map(
        (item) => item.reference,
      );
      expect(requesterRefs).toContain(myReference);
      expect(requesterRefs).not.toContain(other.body.request.reference);

      // Searching the other user's exact reference yields nothing — not an error, not a hint.
      const restricted = await request(app)
        .get(`${BASE}/search?q=${encodeURIComponent(other.body.request.reference as string)}`)
        .set('cookie', requester.cookie);
      expect(restricted.body.items).toHaveLength(0);

      // The admin holds request:read.any, so the same query returns both.
      const asAdmin = await request(app).get(`${BASE}/search?q=Laptop`).set('cookie', admin.cookie);
      const adminRefs = (asAdmin.body.items as Array<{ reference: string | null }>).map(
        (item) => item.reference,
      );
      expect(adminRefs).toContain(myReference);
      expect(adminRefs).toContain(other.body.request.reference);

      // The rival tenant's own requester sees none of Initech's records (ADR-0002).
      const asRival = await request(app)
        .get(`${BASE}/search?q=Laptop`)
        .set('cookie', rivalRequester.cookie);
      const rivalRefs = (asRival.body.items as Array<{ reference: string | null }>).map(
        (item) => item.reference,
      );
      expect(rivalRefs).not.toContain(myReference);
      expect(rivalRefs).not.toContain(other.body.request.reference);
    },
  );

  // -------------------------------------------------------------------------
  // Journey 4 — Admin edits a catalog item → the previous request is unchanged
  // -------------------------------------------------------------------------
  dbIt(
    'journey 4: editing and retiring a catalog item leaves an in-flight request intact',
    async () => {
      const raised = await request(app)
        .post(`${BASE}/requests`)
        .set('cookie', requester.cookie)
        .set('x-csrf-token', requester.csrf)
        .send({
          catalogItemId: approvableItemId,
          title: 'Access for the fidelity check',
          fields: { application: 'Ledger' },
        });
      expect(raised.status).toBe(201);
      const requestId = raised.body.request.id as string;
      const before = raised.body.request;

      // The admin edits the item: rename a field, change the default priority and SLA policy,
      // then retire it. None of this may rewrite the request that already exists (C3/C5/C6).
      const schedules = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
      const otherPolicyId = (
        schedules.body.items as Array<{ id: string; isDefault: boolean }>
      ).filter((p) => !p.isDefault)[0]?.id;

      await request(app)
        .patch(`${BASE}/catalog/items/${approvableItemId}`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({
          name: 'Gated application access (v2)',
          defaultPriority: 'LOW',
          ...(otherPolicyId ? { defaultSlaPolicyId: otherPolicyId } : {}),
          fields: [
            {
              key: 'application',
              label: 'Application (renewed)',
              fieldType: 'TEXT',
              isRequired: true,
              displayOrder: 1,
            },
          ],
        })
        .expect(200);

      await request(app)
        .post(`${BASE}/catalog/items/${approvableItemId}/retire`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .expect(200);

      const after = await request(app)
        .get(`${BASE}/requests/${requestId}`)
        .set('cookie', requester.cookie);
      expect(after.status).toBe(200);

      // The field snapshot is frozen: the original label and value survive the edit.
      expect(after.body.request.fields[0]).toMatchObject({
        key: 'application',
        label: 'Application',
        value: 'Ledger',
      });

      // The SLA policy reference is frozen too: the request keeps the policy it started under.
      expect(after.body.request.slaPolicy.id).toBe(before.slaPolicy.id);
      expect(after.body.request.priority).toBe(before.priority);

      // A retired item is withdrawn from new requests but never invalidates history (C5).
      const retired = await request(app).get(`${BASE}/catalog/items`).set('cookie', admin.cookie);
      const retiredItem = (retired.body.items as Array<{ id: string; status: string }>).find(
        (item) => item.id === approvableItemId,
      );
      expect(retiredItem?.status).toBe('RETIRED');

      const refused = await request(app)
        .post(`${BASE}/requests`)
        .set('cookie', requester.cookie)
        .set('x-csrf-token', requester.csrf)
        .send({
          catalogItemId: approvableItemId,
          title: 'A new request on a retired item',
          fields: {},
        });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    },
  );
});
