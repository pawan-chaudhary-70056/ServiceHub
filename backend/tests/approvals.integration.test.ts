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
 * Approvals — integration tests (docs/37 §3, docs/26 §14).
 *
 * Runs against a real database because the behaviour under test is the workflow state, the
 * insert-only decision trigger, concurrent step advancement, and the SLA pause/resume
 * around the approval.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@approvals.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-approvals.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'requester@initech-approvals.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const AGENT_EMAIL = 'agent@initech-approvals.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';
const APPROVER1_EMAIL = 'approver1@initech-approvals.test';
const APPROVER1_PASSWORD = 'N2wRt9-Pk6v!s';
const APPROVER2_EMAIL = 'approver2@initech-approvals.test';
const APPROVER2_PASSWORD = 'M4dFs7-Qh3b!t';

let databaseAvailable = false;

function dbIt(name: string, fn: () => Promise<void> | void, timeout?: number): void {
  it(
    name,
    async (ctx) => {
      if (!databaseAvailable) {
        ctx.skip();
      }
      await fn();
    },
    timeout,
  );
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
       approval_decisions, approval_step_approvers, approval_steps, approval_workflows,
       approval_template_steps, approval_templates,
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

describe('approvals', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let requester: { cookie: string; csrf: string; userId: string };
  let agent: { cookie: string; csrf: string; userId: string };
  let approver1: { cookie: string; csrf: string; userId: string };
  let approver2: { cookie: string; csrf: string; userId: string };
  let organizationId = '';
  let teamId = '';
  let policyId = '';
  let agentUserId = '';
  let anyItemId = '';
  let allItemId = '';

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

  async function createItem(name: string): Promise<string> {
    const category = await request(app)
      .post(`${BASE}/catalog/categories`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: `Cat-${name}` });
    const item = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name,
        defaultPriority: 'HIGH',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: teamId,
        requiresApproval: true,
        fields: [],
      });
    const itemId = item.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
    return itemId;
  }

  async function raiseRequest(itemId: string, title: string): Promise<string> {
    const created = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ catalogItemId: itemId, title, fields: {} });
    expect(created.status).toBe(201);
    const id = created.body.request.id;
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
    return id;
  }

  async function activeStepId(requestId: string): Promise<string> {
    const view = await request(app)
      .get(`${BASE}/requests/${requestId}/approvals`)
      .set('cookie', admin.cookie);
    expect(view.status).toBe(200);
    const step = (view.body.workflow.steps as Array<{ id: string; status: string }>).find(
      (s) => s.status === 'ACTIVE',
    );
    if (!step) throw new Error('No active approval step.');
    return step.id;
  }

  dbIt('sets up a tenant, approvers, and two approvable items', async () => {
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
    approver1 = await onboard(APPROVER1_EMAIL, APPROVER1_PASSWORD, 'APPROVER', 'Ava Approver');
    approver2 = await onboard(APPROVER2_EMAIL, APPROVER2_PASSWORD, 'APPROVER', 'Ben Approver');
    agentUserId = agent.userId;

    // The requester also holds APPROVER, to prove self-approval is impossible (AC2).
    const approverRole = await findRoleByKey('APPROVER', organizationId);
    await grantRoleToUser({
      userId: requester.userId,
      roleId: approverRole!.id,
      organizationId,
    });

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    teamId = team.id;
    await prisma.teamMember.create({
      data: { teamId, userId: agentUserId, organizationId, role: 'MEMBER' },
    });

    const policies = await request(app).get(`${BASE}/sla/policies`).set('cookie', admin.cookie);
    policyId = (policies.body.items as Array<{ id: string; isDefault: boolean }>).find(
      (p) => p.isDefault,
    )?.id as string;

    anyItemId = await createItem('Any-step service');
    allItemId = await createItem('All-step service');

    await request(app)
      .post(`${BASE}/admin/approval-templates`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        catalogItemId: anyItemId,
        name: 'Any-step approval',
        steps: [{ stepOrder: 1, mode: 'ANY', approverRoleKey: 'APPROVER' }],
      })
      .expect(201);
    await request(app)
      .post(`${BASE}/admin/approval-templates`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        catalogItemId: allItemId,
        name: 'All-step approval',
        steps: [{ stepOrder: 1, mode: 'ALL', approverRoleKey: 'APPROVER' }],
      })
      .expect(201);
  });

  dbIt(
    'instantiates a workflow on APPROVAL_PENDING, pauses the clock, and snapshots approvers',
    async () => {
      const requestId = await raiseRequest(anyItemId, 'Any-step approval request');
      await request(app)
        .post(`${BASE}/requests/${requestId}/transition`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ to: 'APPROVAL_PENDING' })
        .expect(200);

      const workflow = await prisma.approvalWorkflow.findUniqueOrThrow({
        where: { requestId },
        include: { steps: { include: { approvers: true } } },
      });
      expect(workflow.status).toBe('PENDING');
      const step = workflow.steps[0];
      if (!step) throw new Error('Workflow was created without a step.');
      expect(step.mode).toBe('ANY');
      const approverIds = step.approvers.map((a) => a.approverId);
      // Both approvers are snapshotted; the requester (also an APPROVER) is excluded.
      expect(approverIds).toContain(approver1.userId);
      expect(approverIds).toContain(approver2.userId);
      expect(approverIds).not.toContain(requester.userId);

      // The SLA clock is paused (docs/25 §3, docs/26 rule A6).
      const clock = await prisma.slaClock.findFirstOrThrow({ where: { entityId: requestId } });
      expect(clock.state).toBe('PAUSED');
      expect(clock.pausedAt).not.toBeNull();
    },
  );

  dbIt('shows pending approvals only to designated approvers', async () => {
    const mine = await request(app)
      .get(`${BASE}/approvals/pending`)
      .set('cookie', approver1.cookie);
    expect(mine.status).toBe(200);
    expect((mine.body.items as unknown[]).length).toBeGreaterThanOrEqual(1);

    // The agent holds no approval:decide permission (docs/26 §10).
    const denied = await request(app).get(`${BASE}/approvals/pending`).set('cookie', agent.cookie);
    expect(denied.status).toBe(403);
  });

  dbIt('refuses a reasonless rejection and a self-approval (AC2, AC4)', async () => {
    const requestId = await prisma.approvalWorkflow
      .findFirstOrThrow({ where: { organizationId, status: 'PENDING' } })
      .then((w) => w.requestId);
    const stepId = await activeStepId(requestId);

    const noComment = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver1.cookie)
      .set('x-csrf-token', approver1.csrf)
      .send({ decision: 'REJECT' });
    expect(noComment.status).toBe(422);

    // The requester is excluded from the snapshot, so their decision is refused.
    const self = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({ decision: 'APPROVE' });
    expect([403, 404]).toContain(self.status);
  });

  dbIt('approves an ANY step, finalizes the request and resumes the clock (AC1)', async () => {
    const workflow = await prisma.approvalWorkflow.findFirstOrThrow({
      where: { organizationId, status: 'PENDING' },
    });
    const stepId = await activeStepId(workflow.requestId);

    const decided = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver1.cookie)
      .set('x-csrf-token', approver1.csrf)
      .send({ decision: 'APPROVE', comment: 'Approved for access.' });
    expect(decided.status).toBe(200);
    expect(decided.body.workflow.status).toBe('APPROVED');

    const updated = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: workflow.requestId },
    });
    expect(updated.status).toBe('APPROVED');

    const clock = await prisma.slaClock.findFirstOrThrow({
      where: { entityId: workflow.requestId },
    });
    expect(clock.pausedAt).toBeNull();
    expect(clock.state).not.toBe('PAUSED');

    // Replaying the same decision is idempotent (AC: replay returns the original outcome).
    const replay = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver1.cookie)
      .set('x-csrf-token', approver1.csrf)
      .send({ decision: 'APPROVE', comment: 'Approved for access.' });
    expect(replay.status).toBe(200);
    expect(replay.body.recorded).toBe(false);

    const decisions = await prisma.approvalDecision.count({ where: { stepId } });
    expect(decisions).toBe(1);

    // A late decision on the completed step is refused.
    const late = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver2.cookie)
      .set('x-csrf-token', approver2.csrf)
      .send({ decision: 'APPROVE' });
    expect(late.status).toBe(409);
  });

  dbIt('requires every approver on an ALL step before advancing (AC1)', async () => {
    const requestId = await raiseRequest(allItemId, 'All-step approval request');
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'APPROVAL_PENDING' })
      .expect(200);
    const stepId = await activeStepId(requestId);

    const first = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver1.cookie)
      .set('x-csrf-token', approver1.csrf)
      .send({ decision: 'APPROVE' });
    expect(first.status).toBe(200);
    // The step is not satisfied by one approval when the mode is ALL.
    expect(first.body.workflow.status).toBe('PENDING');
    let current = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe('APPROVAL_PENDING');

    const second = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver2.cookie)
      .set('x-csrf-token', approver2.csrf)
      .send({ decision: 'APPROVE' });
    expect(second.status).toBe(200);
    expect(second.body.workflow.status).toBe('APPROVED');
    current = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(current.status).toBe('APPROVED');
  });

  dbIt('rejects a workflow with a reason and returns the request to the requester', async () => {
    const requestId = await raiseRequest(anyItemId, 'To be rejected');
    await request(app)
      .post(`${BASE}/requests/${requestId}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'APPROVAL_PENDING' })
      .expect(200);
    const stepId = await activeStepId(requestId);

    const rejected = await request(app)
      .post(`${BASE}/approvals/${stepId}/decide`)
      .set('cookie', approver1.cookie)
      .set('x-csrf-token', approver1.csrf)
      .send({ decision: 'REJECT', comment: 'Not justified for this role.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.workflow.status).toBe('REJECTED');

    const updated = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(updated.status).toBe('REJECTED');

    const clock = await prisma.slaClock.findFirstOrThrow({ where: { entityId: requestId } });
    expect(clock.pausedAt).toBeNull();
  });

  dbIt('enforces insert-only decisions at the database (docs/26 rule A3)', async () => {
    const decision = await prisma.approvalDecision.findFirstOrThrow({
      where: { organizationId },
    });
    await expect(
      prisma.$executeRaw`UPDATE approval_decisions SET comment = 'tampered' WHERE id = ${decision.id}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM approval_decisions WHERE id = ${decision.id}`,
    ).rejects.toThrow();
  });

  dbIt(
    'advances exactly once when two decisions race on the same step (docs/26 §14 AC5)',
    async () => {
      const requestId = await raiseRequest(anyItemId, 'Racing decisions');
      await request(app)
        .post(`${BASE}/requests/${requestId}/transition`)
        .set('cookie', agent.cookie)
        .set('x-csrf-token', agent.csrf)
        .send({ to: 'APPROVAL_PENDING' })
        .expect(200);
      const stepId = await activeStepId(requestId);
      const workflowId = (await prisma.approvalWorkflow.findUniqueOrThrow({ where: { requestId } }))
        .id;

      // Two designated approvers decide the same ANY step at the same instant. The step is
      // claimed atomically, so exactly one decision advances it; the loser is told so with
      // `409` rather than silently recording a second advance (`docs/26` §5).
      const [first, second] = await Promise.all([
        request(app)
          .post(`${BASE}/approvals/${stepId}/decide`)
          .set('cookie', approver1.cookie)
          .set('x-csrf-token', approver1.csrf)
          .send({ decision: 'APPROVE', comment: 'Approved first.' }),
        request(app)
          .post(`${BASE}/approvals/${stepId}/decide`)
          .set('cookie', approver2.cookie)
          .set('x-csrf-token', approver2.csrf)
          .send({ decision: 'APPROVE', comment: 'Approved second.' }),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);

      // The losing decision is not recorded at all: it never displaced the winning one.
      expect(await prisma.approvalDecision.count({ where: { workflowId } })).toBe(1);
      const workflow = await prisma.approvalWorkflow.findUniqueOrThrow({
        where: { id: workflowId },
      });
      expect(workflow.status).toBe('APPROVED');
      const request1 = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(request1.status).toBe('APPROVED');
    },
    60_000,
  );

  dbIt('records every decision in the audit trail (AC8)', async () => {
    const count = await prisma.auditLog.count({
      where: { organizationId, action: 'approval.decision' },
    });
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
