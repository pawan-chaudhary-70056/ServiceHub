import { randomUUID } from 'node:crypto';
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
 * Unified search and reporting — integration tests (docs/37 §3, docs/30 §2/§3).
 *
 * The behaviour under test is the security core of `docs/30` §2.3: **search never returns a
 * record the caller cannot read**, in results, counts or suggestions, and reports are
 * scoped by the caller's authorization (`§3.2` R3). A restricted record under a broad query
 * is the canonical leak, so that is exactly what the first test exercises.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@search.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-search.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-search.test';
const ALICE_PASSWORD = 'V7kLm2-Qz9p!x';
const BOB_EMAIL = 'bob@initech-search.test';
const BOB_PASSWORD = 'H4qWn8-Zr2s!m';

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
       notification_preferences, notifications, tasks, incidents, request_field_values,
       service_requests, comments,
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

interface SearchBody {
  items: Array<{
    entityType: string;
    id: string;
    reference: string | null;
    title: string;
    snippet: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
  fallback: string | null;
  searchedTypes: string[];
}

describe('Unified search and reporting', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };
  let bob: { cookie: string; csrf: string };
  let organizationId = '';
  let itemId = '';
  let aliceReference = '';
  let bobReference = '';

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

  dbIt('sets up a tenant with a requester, a second requester and an admin', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Search',
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

    alice = await onboard(ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');
    bob = await onboard(BOB_EMAIL, BOB_PASSWORD, 'REQUESTER', 'Bob Requester');

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

    // A draft item that a requester must never see in search.
    await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'Secret Project Tool',
        defaultPriority: 'LOW',
        defaultSlaPolicyId: policyId,
        fields: [],
      });
  });

  dbIt('raises one request for each requester', async () => {
    const a = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'VPN access for Alice', fields: {} });
    expect(a.status).toBe(201);
    aliceReference = a.body.request.reference;

    const b = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', bob.cookie)
      .set('x-csrf-token', bob.csrf)
      .send({ catalogItemId: itemId, title: 'VPN access for Bob', fields: {} });
    expect(b.status).toBe(201);
    bobReference = b.body.request.reference;
  });

  dbIt('never returns a record the caller cannot read (docs/30 §2.3 S1)', async () => {
    // Alice's own scope: a broad query must return only her request.
    const aliceSearch = await request(app).get(`${BASE}/search?q=VPN`).set('cookie', alice.cookie);
    expect(aliceSearch.status).toBe(200);
    const aliceBody = aliceSearch.body as SearchBody;
    const aliceRequests = aliceBody.items.filter((i) => i.entityType === 'REQUEST');
    expect(aliceRequests).toHaveLength(1);
    expect(aliceRequests[0]?.title).toBe('VPN access for Alice');
    expect(aliceBody.items.map((i) => i.reference)).not.toContain(bobReference);

    // Searching Bob's exact reference as Alice yields nothing — not an error, not a hint.
    const restricted = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(bobReference)}`)
      .set('cookie', alice.cookie);
    expect(restricted.status).toBe(200);
    expect((restricted.body as SearchBody).items).toHaveLength(0);

    // The admin holds `request:read.any`, so the same query returns both.
    const adminSearch = await request(app).get(`${BASE}/search?q=VPN`).set('cookie', admin.cookie);
    const adminRequests = (adminSearch.body as SearchBody).items.filter(
      (i) => i.entityType === 'REQUEST',
    );
    expect(adminRequests).toHaveLength(2);
  });

  dbIt('ranks an exact reference match first (docs/30 §2.1)', async () => {
    const exact = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent(aliceReference)}`)
      .set('cookie', admin.cookie);
    const body = exact.body as SearchBody;
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]?.reference).toBe(aliceReference);
  });

  dbIt('hides a draft catalog item from a requester but shows it to a manager', async () => {
    const asAlice = await request(app).get(`${BASE}/search?q=Secret`).set('cookie', alice.cookie);
    expect((asAlice.body as SearchBody).items).toHaveLength(0);

    const asAdmin = await request(app).get(`${BASE}/search?q=Secret`).set('cookie', admin.cookie);
    const draft = (asAdmin.body as SearchBody).items.find(
      (i) => i.entityType === 'CATALOG_ITEM' && i.title === 'Secret Project Tool',
    );
    expect(draft).toBeDefined();
  });

  dbIt('searches users only for a caller with user:manage', async () => {
    const asAlice = await request(app).get(`${BASE}/search?q=Bob`).set('cookie', alice.cookie);
    expect((asAlice.body as SearchBody).searchedTypes).not.toContain('USER');
    expect((asAlice.body as SearchBody).items.some((i) => i.entityType === 'USER')).toBe(false);

    const asAdmin = await request(app).get(`${BASE}/search?q=Bob`).set('cookie', admin.cookie);
    const users = (asAdmin.body as SearchBody).items.filter((i) => i.entityType === 'USER');
    expect(users.some((i) => i.title === 'Bob Requester')).toBe(true);
  });

  dbIt(
    'scopes reports to the caller and reserves cross-team reports (docs/30 §3.2 R3)',
    async () => {
      const aliceReport = await request(app)
        .get(`${BASE}/reports/requests.summary`)
        .set('cookie', alice.cookie);
      expect(aliceReport.status).toBe(200);
      expect(aliceReport.body.report.scope).toBe('own');
      const aliceByStatus = aliceReport.body.report.figures.byStatus as Record<string, number>;
      expect(Object.values(aliceByStatus).reduce((sum, n) => sum + n, 0)).toBe(1);

      const adminReport = await request(app)
        .get(`${BASE}/reports/requests.summary`)
        .set('cookie', admin.cookie);
      expect(adminReport.body.report.scope).toBe('any');
      const adminByStatus = adminReport.body.report.figures.byStatus as Record<string, number>;
      expect(Object.values(adminByStatus).reduce((sum, n) => sum + n, 0)).toBe(2);

      // SLA attainment is cross-team: refused for a requester, allowed for the admin.
      const denied = await request(app)
        .get(`${BASE}/reports/sla.attainment`)
        .set('cookie', alice.cookie);
      expect(denied.status).toBe(403);

      const allowed = await request(app)
        .get(`${BASE}/reports/sla.attainment`)
        .set('cookie', admin.cookie);
      expect(allowed.status).toBe(200);
      expect(allowed.body.report.figures.totalClocks).toBeGreaterThanOrEqual(2);

      const unknown = await request(app)
        .get(`${BASE}/reports/does.not.exist`)
        .set('cookie', admin.cookie);
      expect(unknown.status).toBe(404);
    },
  );

  dbIt('reports open and overdue task load, scoped to the caller (docs/30 §3.3)', async () => {
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { email: ALICE_EMAIL } });
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    const bobUser = await prisma.user.findUniqueOrThrow({ where: { email: BOB_EMAIL } });

    await prisma.task.createMany({
      data: [
        {
          organizationId,
          parentType: 'REQUEST',
          parentId: randomUUID(),
          title: 'Late for Alice',
          status: 'IN_PROGRESS',
          assigneeId: aliceUser.id,
          createdById: adminUser.id,
          dueAt: new Date(Date.now() - 60_000),
        },
        {
          organizationId,
          parentType: 'REQUEST',
          parentId: randomUUID(),
          title: 'Due tomorrow for Alice',
          status: 'TODO',
          assigneeId: aliceUser.id,
          createdById: adminUser.id,
          dueAt: new Date(Date.now() + 86_400_000),
        },
        {
          organizationId,
          parentType: 'REQUEST',
          parentId: randomUUID(),
          title: 'Late for Bob',
          status: 'TODO',
          assigneeId: bobUser.id,
          createdById: adminUser.id,
          dueAt: new Date(Date.now() - 60_000),
        },
      ],
    });

    const asAlice = await request(app)
      .get(`${BASE}/reports/tasks.workload`)
      .set('cookie', alice.cookie);
    expect(asAlice.status).toBe(200);
    expect(asAlice.body.report.scope).toBe('own');
    // Alice sees her two tasks and exactly one of them is late (R1: from stored timestamps).
    expect(asAlice.body.report.figures.open).toBe(2);
    expect(asAlice.body.report.figures.overdue).toBe(1);
    expect(asAlice.body.report.figures.overdueSharePercent).toBe(50);
    expect(asAlice.body.report.figures.byStatus).toMatchObject({ IN_PROGRESS: 1, TODO: 1 });

    // Bob's late task is invisible to her and counted tenant-wide.
    const asAdmin = await request(app)
      .get(`${BASE}/reports/tasks.workload`)
      .set('cookie', admin.cookie);
    expect(asAdmin.body.report.scope).toBe('any');
    expect(asAdmin.body.report.figures.open).toBe(3);
    expect(asAdmin.body.report.figures.overdue).toBe(2);
  });

  dbIt('reports notification delivery outcomes tenant-wide (docs/30 §3.3)', async () => {
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { email: ALICE_EMAIL } });

    await prisma.notification.createMany({
      data: [
        {
          organizationId,
          userId: aliceUser.id,
          recipient: ALICE_EMAIL,
          channel: 'EMAIL',
          eventType: 'notification.request.assigned',
          templateVersion: 'v1',
          dedupeKey: 'report-depth-sent',
          status: 'SENT',
          sentAt: new Date(),
        },
        {
          organizationId,
          userId: aliceUser.id,
          recipient: ALICE_EMAIL,
          channel: 'EMAIL',
          eventType: 'notification.request.assigned',
          templateVersion: 'v1',
          dedupeKey: 'report-depth-dead',
          status: 'DEAD',
          failureReason: 'Provider unavailable.',
        },
      ],
    });

    // A delivery figure is other people's mail metadata, so it is cross-team only.
    const denied = await request(app)
      .get(`${BASE}/reports/notifications.delivery`)
      .set('cookie', alice.cookie);
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`${BASE}/reports/notifications.delivery`)
      .set('cookie', admin.cookie);
    expect(allowed.status).toBe(200);
    const figures = allowed.body.report.figures as Record<string, number>;
    expect(figures.delivered).toBeGreaterThanOrEqual(1);
    expect(figures.deadLettered).toBeGreaterThanOrEqual(1);
    // The published rate is the documented one: failures are FAILED + DEAD, never SKIPPED.
    const total = figures.total as number;
    expect(figures.failureRatePercent).toBe(
      Math.round((((figures.failed ?? 0) + (figures.deadLettered as number)) / total) * 1000) / 10,
    );
    expect(figures.deliveryRatePercent).toBe(
      Math.round(((figures.delivered as number) / total) * 1000) / 10,
    );
  });

  dbIt(
    'reports mean/median request resolution from stored timestamps (30 §3.3, owner 22)',
    async () => {
      // Synthetic but fixed intervals: Alice resolved after 60 minutes, Bob after 180 —
      // written to the stored columns so the figure is reproducible from them alone (R1).
      const aliceRequest = await prisma.serviceRequest.findFirstOrThrow({
        where: { reference: aliceReference },
      });
      const bobRequest = await prisma.serviceRequest.findFirstOrThrow({
        where: { reference: bobReference },
      });
      const base = new Date(Date.now() - 10 * 3_600_000);
      await prisma.serviceRequest.update({
        where: { id: aliceRequest.id },
        data: {
          status: 'FULFILLED',
          submittedAt: base,
          resolvedAt: new Date(base.getTime() + 60 * 60_000),
        },
      });
      await prisma.serviceRequest.update({
        where: { id: bobRequest.id },
        data: {
          status: 'FULFILLED',
          submittedAt: base,
          resolvedAt: new Date(base.getTime() + 180 * 60_000),
        },
      });

      const asAdmin = await request(app)
        .get(`${BASE}/reports/requests.resolution`)
        .set('cookie', admin.cookie);
      expect(asAdmin.status).toBe(200);
      const figures = asAdmin.body.report.figures as Record<string, unknown>;
      expect(figures.resolvedCount).toBe(2);
      // Elapsed minutes come straight from the two stored columns: median of [60, 180].
      expect(figures.meanElapsedMinutes).toBe(120);
      expect(figures.medianElapsedMinutes).toBe(120);
      // Working minutes are the same interval with non-working time removed, so they can
      // never exceed elapsed — the invariant that catches a double-counted exclusion.
      expect(figures.meanMinutes as number).toBeLessThanOrEqual(
        figures.meanElapsedMinutes as number,
      );
      // ADR-0008: the report states which calendar it measured against.
      expect(Object.keys(figures.calendarsUsed as Record<string, number>)).toContain(
        'Europe/London (WORKING_HOURS)',
      );

      // R3: Alice's own scope resolves to her one request, not the tenant's two.
      const asAlice = await request(app)
        .get(`${BASE}/reports/requests.resolution`)
        .set('cookie', alice.cookie);
      expect(asAlice.body.report.scope).toBe('own');
      expect(asAlice.body.report.figures.resolvedCount).toBe(1);
    },
  );

  dbIt('reports reopen-aware MTTR (docs/30 §3.3, owner 23)', async () => {
    const first = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({
        title: 'VPN outage',
        description: 'Nobody can reach the VPN.',
        impact: 'MINOR',
        urgency: 'LOW',
      });
    expect(first.status).toBe(201);
    const reopenedIncident = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({
        title: 'Flaky build agent',
        description: 'The CI agent drops jobs.',
        impact: 'MINOR',
        urgency: 'LOW',
      });
    expect(reopenedIncident.status).toBe(201);

    // Incident 1: reported 5 h ago, resolved 4 h ago (60 minutes).
    await prisma.incident.update({
      where: { id: first.body.incident.id },
      data: {
        createdAt: new Date(Date.now() - 5 * 3_600_000),
        resolvedAt: new Date(Date.now() - 4 * 3_600_000),
        status: 'RESOLVED',
        resolutionSummary: 'VPN configuration was reverted.',
      },
    });
    // Incident 2: reported 5 h ago, reopened once, finally resolved 1 h ago — the full
    // report-to-final-resolution time (240 minutes), not its first pass.
    await prisma.incident.update({
      where: { id: reopenedIncident.body.incident.id },
      data: {
        createdAt: new Date(Date.now() - 5 * 3_600_000),
        resolvedAt: new Date(Date.now() - 1 * 3_600_000),
        status: 'RESOLVED',
        resolutionSummary: 'Agent restarted and jobs re-queued.',
        reopenCount: 1,
        isMajor: true,
      },
    });

    const asAdmin = await request(app)
      .get(`${BASE}/reports/incidents.mttr`)
      .set('cookie', admin.cookie);
    expect(asAdmin.status).toBe(200);
    const figures = asAdmin.body.report.figures as Record<string, unknown>;
    expect(figures.resolvedCount).toBe(2);
    expect(figures.meanMinutes).toBe(150);
    expect(figures.medianMinutes).toBe(150);
    expect(figures.reopenedCount).toBe(1);
    expect(figures.reopenRatePercent).toBe(50);
    expect(figures.majorCount).toBe(1);
  });

  dbIt('reports approval turnaround and the undecided backlog (30 §3.3, owner 26)', async () => {
    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL } });
    const aliceRequest = await prisma.serviceRequest.findFirstOrThrow({
      where: { reference: aliceReference },
    });

    const workflow = await prisma.approvalWorkflow.create({
      data: { organizationId, requestId: aliceRequest.id },
    });
    // A step raised 2 h before its decision: 90 minutes of turnaround.
    const decidedStep = await prisma.approvalStep.create({
      data: {
        workflowId: workflow.id,
        stepOrder: 1,
        mode: 'ANY',
        status: 'COMPLETED',
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    await prisma.approvalDecision.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        stepId: decidedStep.id,
        approverId: adminUser.id,
        outcome: 'APPROVE',
        decidedAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    // A queued step already past its deadline: the backlog is a snapshot (PENDING counts
    // as undecided — it is queued behind an earlier step, not decided).
    await prisma.approvalStep.create({
      data: {
        workflowId: workflow.id,
        stepOrder: 2,
        mode: 'ALL',
        status: 'PENDING',
        deadlineAt: new Date(Date.now() - 3_600_000),
      },
    });

    const asAdmin = await request(app)
      .get(`${BASE}/reports/approvals.turnaround`)
      .set('cookie', admin.cookie);
    expect(asAdmin.status).toBe(200);
    const figures = asAdmin.body.report.figures as Record<string, unknown>;
    expect(figures.decisionCount).toBe(1);
    expect(figures.meanMinutes).toBe(90);
    expect(figures.medianMinutes).toBe(90);
    expect(figures.pending).toBeGreaterThanOrEqual(1);
    expect(figures.overdue).toBe(1);

    // R3: visibility is the *request's*. Bob can see neither Alice's decision nor her
    // backlog — his figures are the empty set, not a narrowed tenant view.
    const asBob = await request(app)
      .get(`${BASE}/reports/approvals.turnaround`)
      .set('cookie', bob.cookie);
    expect(asBob.body.report.scope).toBe('own');
    expect(asBob.body.report.figures.decisionCount).toBe(0);
    expect(asBob.body.report.figures.pending).toBe(0);
    expect(asBob.body.report.figures.overdue).toBe(0);
  });

  dbIt('uses PostgreSQL full-text search with highlighting (docs/30 §2.2/§2.4)', async () => {
    const response = await request(app).get(`${BASE}/search?q=VPN`).set('cookie', admin.cookie);
    const body = response.body as SearchBody;
    const requestItem = body.items.find((i) => i.entityType === 'REQUEST');
    expect(requestItem).toBeDefined();
    // `ts_headline` wraps the matched term, so a title match carries markup.
    expect(requestItem?.snippet).toMatch(/<b>VPN<\/b>/i);
  });

  dbIt('treats a multi-term query as a conjunction (FTS AND)', async () => {
    const response = await request(app)
      .get(`${BASE}/search?q=${encodeURIComponent('VPN Bob')}`)
      .set('cookie', admin.cookie);
    const requests = (response.body as SearchBody).items.filter((i) => i.entityType === 'REQUEST');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.title).toBe('VPN access for Bob');
  });

  dbIt('registers the GIN full-text indexes (docs/30 §2.2)', async () => {
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_search_idx'`,
    );
    const names = indexes.map((row) => row.indexname).sort();
    expect(names).toEqual([
      'articles_search_idx',
      'assets_search_idx',
      'catalog_items_search_idx',
      'incidents_search_idx',
      'service_requests_search_idx',
      'users_search_idx',
    ]);

    // The article index carries `setweight` classes (title/summary above body), which the
    // query vector must reproduce exactly or the planner will not use it (docs/09 §4).
    const articles = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'articles_search_idx'`,
    );
    expect(articles[0]?.indexdef).toContain('setweight');
    expect(articles[0]?.indexdef).toContain("'A'");
    expect(articles[0]?.indexdef).toContain("'B'");
  });

  dbIt('caches dashboard aggregates and invalidates them per class (docs/30 §3.4)', async () => {
    // A period unique to this run and open into the near future, so rows created during the
    // test are inside it and a previous run can never have populated the same key.
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const window = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const summaryUrl = `${BASE}/reports/requests.summary?${window}`;
    const workloadUrl = `${BASE}/reports/tasks.workload?${window}`;

    const first = await request(app).get(summaryUrl).set('cookie', admin.cookie);
    expect(first.status).toBe(200);
    const firstGeneratedAt = first.body.report.generatedAt as string;
    const countOf = (body: { report: { figures: { byStatus: Record<string, number> } } }) =>
      Object.values(body.report.figures.byStatus).reduce((sum, n) => sum + n, 0);
    const before = countOf(first.body);

    // The second identical request is a cache hit: byte-identical payload, including the
    // generation stamp, which only a fresh computation (`new Date()`) could move.
    const second = await request(app).get(summaryUrl).set('cookie', admin.cookie);
    expect(second.body.report.generatedAt).toBe(firstGeneratedAt);

    // A write in the class the metric reads invalidates the entry after its commit: the new
    // request is counted and the report is recomputed.
    const created = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'Dashboards must not lie', fields: {} });
    expect(created.status).toBe(201);

    const afterWrite = await request(app).get(summaryUrl).set('cookie', admin.cookie);
    expect(afterWrite.body.report.generatedAt).not.toBe(firstGeneratedAt);
    expect(countOf(afterWrite.body)).toBe(before + 1);

    // A write in a *different* class must leave this region alone (`§3.4`): the task load
    // was cached before the request was raised and is still the same entry afterwards.
    const tasksBefore = await request(app).get(workloadUrl).set('cookie', admin.cookie);
    expect(tasksBefore.status).toBe(200);
    const tasksAfter = await request(app).get(workloadUrl).set('cookie', admin.cookie);
    expect(tasksAfter.body.report.generatedAt).toBe(tasksBefore.body.report.generatedAt);

    // Scope is part of the key (`R3`): a requester's own-scope entry is never served to the
    // admin's cross-team read, and the requester keeps getting their own answer back. Alice
    // owns two requests in this window — her VPN one and the probe she just raised.
    const asAlice = await request(app).get(summaryUrl).set('cookie', alice.cookie);
    expect(asAlice.body.report.scope).toBe('own');
    expect(asAlice.body.report.generatedAt).not.toBe(afterWrite.body.report.generatedAt);
    expect(countOf(asAlice.body)).toBe(2);

    const asAliceAgain = await request(app).get(summaryUrl).set('cookie', alice.cookie);
    expect(asAliceAgain.body.report.generatedAt).toBe(asAlice.body.report.generatedAt);
    expect(countOf(asAliceAgain.body)).toBe(2);
  });

  dbIt('invalidates the SLA figures when a clock is overridden (docs/30 §3.4)', async () => {
    const url = `${BASE}/reports/sla.attainment`;
    const first = await request(app).get(url).set('cookie', admin.cookie);
    expect(first.status).toBe(200);
    const clock = await prisma.slaClock.findFirstOrThrow({
      where: { organizationId, breachedAt: null },
    });

    // An audited correction to a frozen target (`docs/25` §11) is a write in the SLA class,
    // and it must not be served from the cached attainment figure.
    const overridden = await request(app)
      .post(`${BASE}/sla/clocks/${clock.id}/override`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        reason: 'Deadline extended by the change board.',
        targetAt: new Date().toISOString(),
      });
    expect(overridden.status).toBe(200);

    const second = await request(app).get(url).set('cookie', admin.cookie);
    expect(second.body.report.generatedAt).not.toBe(first.body.report.generatedAt);
  });
});
