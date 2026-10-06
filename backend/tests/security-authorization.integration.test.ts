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
 * Authorization matrix and IDOR sweep — the security gates of docs/20 §3/§4/§5.
 *
 * The document's premise is that a **missing object-level check on one endpoint** is the
 * failure mode that review never catches. The sweep here is table-driven: each row is a
 * `(caller, object class, expected)` triple, and the expectations encode the matrix:
 *
 *   owner → 200 · foreign user → **404, never 403** (`07` §1) · unauthenticated → 401 ·
 *   role without the permission → 403 · auditor → 403 on every mutation · administrator
 *   deciding an approval → 403 (separation of duties, `07` §5).
 *
 * It also asserts the properties §5 calls out: id substitution on reads *and* writes,
 * nested-resource ids, report/export parameters that would widen scope, and search never
 * leaking an out-of-scope record.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@sec-authz.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-authz.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const LEAD_EMAIL = 'lead@initech-authz.test';
const LEAD_PASSWORD = 'N2wRt9-Pk6v!s';
const AGENT_EMAIL = 'agent@initech-authz.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';
const APPROVER_EMAIL = 'approver@initech-authz.test';
const APPROVER_PASSWORD = 'J6tBv1-Yx4c!r';
const AUDITOR_EMAIL = 'auditor@initech-authz.test';
const AUDITOR_PASSWORD = 'M4dFs7-Qh3b!t';
const ALICE_EMAIL = 'alice@initech-authz.test';
const ALICE_PASSWORD = 'V7kLm2-Qz9p!x';
const BOB_EMAIL = 'bob@initech-authz.test';
const BOB_PASSWORD = 'M4dFs7-Qh3b!t';
const RIVAL_ADMIN_EMAIL = 'admin@umbrella-authz.test';
const RIVAL_ADMIN_PASSWORD = 'Z8mPq3-Wt5n!k';

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

describe('docs/20 §4/§5 authorization matrix and IDOR sweep', () => {
  let operator: Session;
  let admin: Session;
  let lead: Session;
  let agent: Session;
  let approver: Session;
  let auditor: Session;
  let alice: Session;
  let bob: Session;
  let rivalAdmin: Session;
  let organizationId = '';
  let itemId = '';
  let approvableItemId = '';
  let aliceRequestId = '';
  let aliceIncidentId = '';
  let approvalStepId = '';

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

  dbIt('sets up two tenants and a fixture of objects in the first', async () => {
    operator = { ...sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD)), userId: '' };
    admin = await provisionTenant('Initech Authz', ADMIN_EMAIL, ADMIN_PASSWORD);
    organizationId = (await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } }))
      .organizationId as string;

    lead = await onboard(admin, LEAD_EMAIL, LEAD_PASSWORD, 'TEAM_LEAD', 'Initech Lead');
    agent = await onboard(admin, AGENT_EMAIL, AGENT_PASSWORD, 'AGENT', 'Initech Agent');
    approver = await onboard(
      admin,
      APPROVER_EMAIL,
      APPROVER_PASSWORD,
      'APPROVER',
      'Initech Approver',
    );
    auditor = await onboard(admin, AUDITOR_EMAIL, AUDITOR_PASSWORD, 'AUDITOR', 'Initech Auditor');
    alice = await onboard(admin, ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');
    bob = await onboard(admin, BOB_EMAIL, BOB_PASSWORD, 'REQUESTER', 'Bob Requester');

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    for (const member of [lead, agent]) {
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: member.userId, organizationId, role: 'MEMBER' },
      });
    }

    const policies = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
    const policyId = (policies.body.items as Array<{ id: string; isDefault: boolean }>).find(
      (p) => p.isDefault,
    )?.id;
    const category = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Access' });

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
        fields: [],
      });
    itemId = open.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    const approvable = await request(app)
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

    // Alice's objects: a request (in the Service Desk team, so lead/agent may see it; Bob
    // may not) and an incident she reported.
    const aliceRequest = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: "Alice's laptop", fields: {} });
    aliceRequestId = aliceRequest.body.request.id;

    const incident = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({
        title: 'Printer on fire',
        description: 'Smoke from the third-floor printer.',
        impact: 'MINOR',
        urgency: 'HIGH',
        teamId: team.id,
      });
    aliceIncidentId = incident.body.incident.id;

    rivalAdmin = await provisionTenant('Umbrella Authz', RIVAL_ADMIN_EMAIL, RIVAL_ADMIN_PASSWORD);
  });

  // -------------------------------------------------------------------------
  // §4 — unauthenticated and permission-less callers
  // -------------------------------------------------------------------------
  dbIt('rejects every protected read without a session with 401', async () => {
    const protectedReads = [
      `${BASE}/requests`,
      `${BASE}/incidents`,
      `${BASE}/tasks`,
      `${BASE}/catalog/items`,
      `${BASE}/users`,
      `${BASE}/roles`,
      `${BASE}/sla/policies`,
      `${BASE}/search?q=laptop`,
      `${BASE}/notifications`,
      `${BASE}/me/notification-preferences`,
      `${BASE}/approvals/pending`,
      `${BASE}/platform/organizations`,
    ];
    for (const path of protectedReads) {
      const response = await request(app).get(path);
      expect(response.status, `GET ${path}`).toBe(401);
    }
  });

  dbIt('returns 403, not 404, when the caller simply lacks the permission', async () => {
    // A requester may read their own work but may not administer the tenant.
    const cases: Array<{ method: 'get' | 'post'; path: string; session: Session }> = [
      { method: 'get', path: `${BASE}/users`, session: alice },
      { method: 'post', path: `${BASE}/users`, session: alice },
      { method: 'get', path: `${BASE}/roles`, session: alice },
      { method: 'get', path: `${BASE}/sla/policies`, session: alice },
      { method: 'post', path: `${BASE}/catalog/items`, session: alice },
      { method: 'post', path: `${BASE}/admin/approval-templates`, session: alice },
      { method: 'post', path: `${BASE}/approvals/${aliceRequestId}/decide`, session: alice },
      { method: 'post', path: `${BASE}/requests/${aliceRequestId}/assign`, session: bob },
    ];
    for (const entry of cases) {
      const client = request(app);
      const response = await client[entry.method](entry.path)
        .set('cookie', entry.session.cookie)
        .set('x-csrf-token', entry.session.csrf)
        .send({});
      expect(response.status, `${entry.method} ${entry.path}`).toBe(403);
    }
  });

  dbIt(
    'lets the administrator configure but not decide an approval (separation of duties)',
    async () => {
      // Move Alice's approvable request into APPROVAL_PENDING so a real step exists.
      const raised = await request(app)
        .post(`${BASE}/requests`)
        .set('cookie', alice.cookie)
        .set('x-csrf-token', alice.csrf)
        .send({ catalogItemId: approvableItemId, title: 'Gated request', fields: {} });
      const gatedId = raised.body.request.id as string;

      await request(app)
        .post(`${BASE}/requests/${gatedId}/transition`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ to: 'TRIAGED' })
        .expect(200);
      await request(app)
        .post(`${BASE}/requests/${gatedId}/transition`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ to: 'APPROVAL_PENDING' })
        .expect(200);

      const pending = await request(app)
        .get(`${BASE}/approvals/pending`)
        .set('cookie', approver.cookie);
      const workflow = (
        pending.body.items as Array<{ request: { id: string }; steps: Array<{ id: string }> }>
      ).find((item) => item.request.id === gatedId);
      approvalStepId = workflow?.steps[0]?.id as string;
      expect(approvalStepId).toBeTruthy();

      // The administrator may read pending approvals and reassign, but deciding is refused:
      // a person who can change the system must not also sign off their own configuration.
      const decided = await request(app)
        .post(`${BASE}/approvals/${approvalStepId}/decide`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ decision: 'APPROVE' });
      expect(decided.status).toBe(403);

      // The designated approver can decide.
      await request(app)
        .post(`${BASE}/approvals/${approvalStepId}/decide`)
        .set('cookie', approver.cookie)
        .set('x-csrf-token', approver.csrf)
        .send({ decision: 'APPROVE' })
        .expect(200);
    },
  );

  dbIt('refuses every mutation from an auditor (read-only role)', async () => {
    const mutations: Array<{ method: 'post' | 'patch'; path: string; body: object }> = [
      {
        method: 'post',
        path: `${BASE}/requests`,
        body: { catalogItemId: itemId, title: 'nope', fields: {} },
      },
      {
        method: 'post',
        path: `${BASE}/incidents`,
        body: { title: 'nope', description: 'nope', impact: 'MINOR', urgency: 'LOW' },
      },
      { method: 'post', path: `${BASE}/catalog/items`, body: { name: 'nope' } },
      {
        method: 'post',
        path: `${BASE}/users`,
        body: { email: 'nope@initech-authz.test', roleId: 'x' },
      },
      {
        method: 'post',
        path: `${BASE}/requests/${aliceRequestId}/assign`,
        body: { assigneeId: auditor.userId },
      },
      {
        method: 'post',
        path: `${BASE}/requests/${aliceRequestId}/transition`,
        body: { to: 'CANCELLED' },
      },
      { method: 'post', path: `${BASE}/sla/calendars`, body: { name: 'nope' } },
      { method: 'post', path: `${BASE}/platform/organizations`, body: { name: 'nope' } },
      { method: 'patch', path: `${BASE}/catalog/items/${itemId}`, body: { name: 'nope' } },
    ];
    for (const entry of mutations) {
      const client = request(app);
      const response = await client[entry.method](entry.path)
        .set('cookie', auditor.cookie)
        .set('x-csrf-token', auditor.csrf)
        .send(entry.body);
      expect(response.status, `${entry.method} ${entry.path}`).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // §4/§5 — object-level scope: foreign and cross-tenant access is 404
  // -------------------------------------------------------------------------
  dbIt('gives a foreign same-tenant caller 404 for an object they may not see', async () => {
    // Bob is a requester with own-scope only: Alice's request and incident are invisible.
    const requestRead = await request(app)
      .get(`${BASE}/requests/${aliceRequestId}`)
      .set('cookie', bob.cookie);
    expect(requestRead.status).toBe(404);

    const incidentRead = await request(app)
      .get(`${BASE}/incidents/${aliceIncidentId}`)
      .set('cookie', bob.cookie);
    expect(incidentRead.status).toBe(404);

    // The lead holds team scope and is in the Service Desk team, so the same object is 200.
    const asLead = await request(app)
      .get(`${BASE}/requests/${aliceRequestId}`)
      .set('cookie', lead.cookie);
    expect(asLead.status).toBe(200);

    // The owner can read their own record.
    const asOwner = await request(app)
      .get(`${BASE}/requests/${aliceRequestId}`)
      .set('cookie', alice.cookie);
    expect(asOwner.status).toBe(200);
  });

  dbIt('gives a foreign caller 404 for a nested resource of a record they cannot see', async () => {
    const nested = [
      `${BASE}/requests/${aliceRequestId}/comments`,
      `${BASE}/requests/${aliceRequestId}/tasks`,
      `${BASE}/requests/${aliceRequestId}/approvals`,
      `${BASE}/incidents/${aliceIncidentId}/comments`,
      `${BASE}/incidents/${aliceIncidentId}/history`,
      `${BASE}/incidents/${aliceIncidentId}/tasks`,
    ];
    for (const path of nested) {
      const response = await request(app).get(path).set('cookie', bob.cookie);
      expect(response.status, `GET ${path}`).toBe(404);
    }
  });

  dbIt(
    'gives a cross-tenant caller 404 for an object id from another tenant (ADR-0002)',
    async () => {
      // The rival administrator holds request:read.any and incident:read.any in *their*
      // tenant; the tenant predicate must still make Alice's records invisible.
      const requestRead = await request(app)
        .get(`${BASE}/requests/${aliceRequestId}`)
        .set('cookie', rivalAdmin.cookie);
      expect(requestRead.status).toBe(404);

      const incidentRead = await request(app)
        .get(`${BASE}/incidents/${aliceIncidentId}`)
        .set('cookie', rivalAdmin.cookie);
      expect(incidentRead.status).toBe(404);

      const itemRead = await request(app)
        .get(`${BASE}/catalog/items/${itemId}`)
        .set('cookie', rivalAdmin.cookie);
      expect(itemRead.status).toBe(404);
    },
  );

  dbIt('refuses an IDOR write and leaves the foreign record unchanged', async () => {
    const before = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: aliceRequestId } });

    const write = await request(app)
      .post(`${BASE}/requests/${aliceRequestId}/transition`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf)
      .send({ to: 'CANCELLED' });
    expect(write.status).toBe(404);

    const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: aliceRequestId } });
    expect(after.status).toBe(before.status);
    expect(after.status).not.toBe('CANCELLED');

    // A cross-tenant write is refused the same way.
    const crossTenantWrite = await request(app)
      .post(`${BASE}/requests/${aliceRequestId}/transition`)
      .set('cookie', rivalAdmin.cookie)
      .set('x-csrf-token', rivalAdmin.csrf)
      .send({ to: 'CANCELLED' });
    expect(crossTenantWrite.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // §5/§8 — scope-widening parameters, reports and self-service escalation
  // -------------------------------------------------------------------------
  dbIt('does not let a caller widen their scope through report or export parameters', async () => {
    // A requester's report is scoped to their own work; a cross-team metric is refused.
    const ownReport = await request(app)
      .get(`${BASE}/reports/requests.summary`)
      .set('cookie', alice.cookie);
    expect(ownReport.status).toBe(200);
    expect(ownReport.body.report.scope).toBe('own');

    const crossTeam = await request(app)
      .get(`${BASE}/reports/sla.attainment`)
      .set('cookie', alice.cookie);
    expect(crossTeam.status).toBe(403);

    // The export surface enforces the same scope and refuses a wider metric.
    const deniedExport = await request(app)
      .post(`${BASE}/reports/sla.attainment/export`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf)
      .send({});
    expect(deniedExport.status).toBe(403);

    // A requester without `report:export` cannot queue any export at all.
    const noPermission = await request(app)
      .post(`${BASE}/reports/requests.summary/export`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({});
    expect(noPermission.status).toBe(403);
  });

  dbIt('does not let a caller escalate their own privileges through self-service', async () => {
    // There is no route to grant one's own roles; the administration surfaces are the
    // only path and they require `user:manage` (docs/07 §5).
    const invite = await request(app)
      .post(`${BASE}/users`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf)
      .send({ email: BOB_EMAIL, roleId: 'anything', displayName: 'Bob' });
    expect(invite.status).toBe(403);

    const deactivateOther = await request(app)
      .post(`${BASE}/users/${alice.userId}/deactivate`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf);
    expect(deactivateOther.status).toBe(403);

    // A deactivation attempt also cannot be aimed at a user the caller cannot manage.
    const crossTenantDeactivate = await request(app)
      .post(`${BASE}/users/${alice.userId}/deactivate`)
      .set('cookie', rivalAdmin.cookie)
      .set('x-csrf-token', rivalAdmin.csrf);
    expect(crossTenantDeactivate.status).toBe(404);

    // Permissions are unchanged after the attempts.
    const aliceRoles = await prisma.userRole.count({ where: { userId: alice.userId } });
    expect(aliceRoles).toBe(1);
  });

  dbIt('never returns a search result the caller may not read (docs/30 §2.3)', async () => {
    const aliceRef = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: aliceRequestId },
    });
    const asBob = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(aliceRef.reference)}`)
      .set('cookie', bob.cookie);
    expect(asBob.status).toBe(200);
    expect(asBob.body.items).toHaveLength(0);

    const asRival = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(aliceRef.reference)}`)
      .set('cookie', rivalAdmin.cookie);
    expect(asRival.body.items).toHaveLength(0);
  });

  dbIt('rejects a tampered pagination cursor with 422 (fails closed)', async () => {
    const response = await request(app)
      .get(`${BASE}/requests?cursor=not-a-real-cursor`)
      .set('cookie', admin.cookie);
    expect(response.status).toBe(422);
  });

  // -------------------------------------------------------------------------
  // §9 — audit immutability and completeness
  // -------------------------------------------------------------------------
  dbIt('cannot update or delete an audit record through any application path', async () => {
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'ServiceRequest', entityId: aliceRequestId },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET action = 'tampered' WHERE id = '${auditRow.id}'`,
      ),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${auditRow.id}'`),
    ).rejects.toThrow();

    const stillThere = await prisma.auditLog.findUniqueOrThrow({ where: { id: auditRow.id } });
    expect(stillThere.action).toBe(auditRow.action);
  });

  dbIt('leaves exactly one audit record for a single mutation (docs/20 §9)', async () => {
    const created = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf)
      .send({ catalogItemId: itemId, title: 'Audit completeness check', fields: {} });
    expect(created.status).toBe(201);
    const requestId = created.body.request.id as string;

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'ServiceRequest', entityId: requestId, action: 'request.create' },
    });
    expect(rows).toHaveLength(1);
  });
});
