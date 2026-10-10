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
import { processQueuedExports } from '../src/services';

/**
 * Audit log reading — integration tests (docs/31 §5, §9, §10, §13).
 *
 * The behaviour under test is the one that is easiest to get quietly wrong: **scoping and
 * redaction are query predicates and projections, not post-fetch filters.** A team lead's
 * page must not contain another team's rows at all, and a caller without
 * `audit:read.security` must never receive a security entry's payload. If either were
 * implemented as a filter after the fetch, the leak would already be in the page.
 *
 * It also asserts the recursive property that makes the log trustworthy: **reading it is
 * itself audited** (AC5).
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@audit.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-audit.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const LEAD_EMAIL = 'lead@initech-audit.test';
const LEAD_PASSWORD = 'V7kLm2-Qz9p!x';
const AGENT_A_EMAIL = 'agent-a@initech-audit.test';
const AGENT_A_PASSWORD = 'H4qWn8-Zr2s!m';
const AGENT_B_EMAIL = 'agent-b@initech-audit.test';
const AGENT_B_PASSWORD = 'N2wRt9-Pk6v!s';
const REQUESTER_EMAIL = 'requester@initech-audit.test';
const REQUESTER_PASSWORD = 'Secur3-Passphrase!';
const AUDITOR_EMAIL = 'auditor@initech-audit.test';
const AUDITOR_PASSWORD = 'V7kLm2-Qz9p!x';

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
       article_versions, article_slug_redirects, knowledge_links, articles, article_categories,
       asset_assignments, assets, asset_types,
       tasks, incidents, request_field_values, service_requests, comments, reference_sequences,
       catalog_item_fields, catalog_items, categories, sla_targets, sla_policies,
       business_calendars, sla_clocks,
       report_exports,
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

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

let admin: Session;
let lead: Session;
let agentA: Session;
let agentB: Session;
let requester: Session;
let auditor: Session;
let organizationId = '';
let itemId = '';

describe('audit log reading', () => {
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
    const operator = await createUser({
      email: OPERATOR_EMAIL,
      displayName: 'Platform Operator',
      organizationId: null,
      status: 'ACTIVE',
    });
    await createCredential({
      userId: operator.id,
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    await grantRoleToUser({
      userId: operator.id,
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
  ): Promise<Session> {
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

  async function raiseRequest(session: Session, title: string): Promise<string> {
    const created = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .send({ catalogItemId: itemId, title, fields: { application: 'Payroll' } });
    expect(created.status).toBe(201);
    return created.body.request.id as string;
  }

  dbIt('sets up a tenant with two teams, a catalog item and the audit roles', async () => {
    const operatorSession = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));

    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operatorSession.cookie)
      .set('x-csrf-token', operatorSession.csrf)
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
    admin = { ...sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD)), userId: '' };
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    admin.userId = adminUser.id;

    const teamA = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    const teamB = await prisma.team.create({ data: { organizationId, name: 'Network' } });

    // No tenant role holds `audit:read.security` by default (docs/07 §3): the security class
    // is a raised privilege, so the test grants it explicitly to the auditor role rather
    // than inventing a role the matrix does not define.
    const auditorRole = await prisma.role.findFirstOrThrow({
      where: { organizationId, key: 'AUDITOR' },
    });
    const securityPermission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'audit:read.security' },
    });
    await prisma.rolePermission.create({
      data: { roleId: auditorRole.id, permissionId: securityPermission.id },
    });

    lead = await onboard(LEAD_EMAIL, LEAD_PASSWORD, 'TEAM_LEAD', 'Initech Lead');
    agentA = await onboard(AGENT_A_EMAIL, AGENT_A_PASSWORD, 'AGENT', 'Agent A');
    agentB = await onboard(AGENT_B_EMAIL, AGENT_B_PASSWORD, 'AGENT', 'Agent B');
    requester = await onboard(
      REQUESTER_EMAIL,
      REQUESTER_PASSWORD,
      'REQUESTER',
      'Initech Requester',
    );
    auditor = await onboard(AUDITOR_EMAIL, AUDITOR_PASSWORD, 'AUDITOR', 'Initech Auditor');

    await prisma.teamMember.create({
      data: { teamId: teamA.id, userId: lead.userId, organizationId, role: 'LEAD' },
    });
    await prisma.teamMember.create({
      data: { teamId: teamA.id, userId: agentA.userId, organizationId, role: 'MEMBER' },
    });
    await prisma.teamMember.create({
      data: { teamId: teamB.id, userId: agentB.userId, organizationId, role: 'MEMBER' },
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
        // Fulfilled by team A, so team B cannot read a request raised against it — the fact
        // the record-history test needs to distinguish a participant from a foreign caller.
        fulfilmentTeamId: teamA.id,
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

    expect(organizationId).not.toBe('');
  });

  dbIt(
    'docs/31 §5: a lead sees only their team members; an administrator sees the tenant',
    async () => {
      await raiseRequest(agentA, 'Laptop for Agent A');
      await raiseRequest(agentB, 'Firewall rule for Agent B');

      const leadPage = await request(app)
        .get(`${BASE}/audit?action=request.create&limit=100`)
        .set('cookie', lead.cookie)
        .expect(200);
      const leadActors = new Set(
        (leadPage.body.items as Array<{ actorId: string | null }>).map((row) => row.actorId),
      );
      expect(leadActors.has(agentA.userId)).toBe(true);
      // Team B's member is not in the lead's scope, so their row is absent from the page —
      // not merely flagged, because scope is a query predicate (docs/31 §5).
      expect(leadActors.has(agentB.userId)).toBe(false);

      const adminPage = await request(app)
        .get(`${BASE}/audit?action=request.create&limit=100`)
        .set('cookie', admin.cookie)
        .expect(200);
      const adminActors = new Set(
        (adminPage.body.items as Array<{ actorId: string | null }>).map((row) => row.actorId),
      );
      expect(adminActors.has(agentA.userId)).toBe(true);
      expect(adminActors.has(agentB.userId)).toBe(true);

      // Asking for an actor outside the scope yields an empty page, never another team's rows.
      const outOfScope = await request(app)
        .get(`${BASE}/audit?actorId=${agentB.userId}`)
        .set('cookie', lead.cookie)
        .expect(200);
      expect(outOfScope.body.items).toHaveLength(0);
    },
  );

  dbIt('docs/31 §13 AC5: reading the log is itself audited', async () => {
    const before = await prisma.auditLog.count({
      where: { action: 'audit.read', actorId: lead.userId },
    });

    await request(app).get(`${BASE}/audit?limit=5`).set('cookie', lead.cookie).expect(200);

    const after = await prisma.auditLog.findFirst({
      where: { action: 'audit.read', actorId: lead.userId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'audit.read', actorId: lead.userId } }),
    ).toBe(before + 1);
    expect(after?.entityType).toBe('AuditLog');
    expect(after?.correlationId).toBeTruthy();
    // The filters used are recorded on the entry, so the access is reconstructable.
    expect(after?.after).toMatchObject({ filters: { scope: 'team' } });
  });

  dbIt(
    'docs/31 §10: the log is cursor-paginated and the filters narrow to indexed columns',
    async () => {
      const first = await request(app)
        .get(`${BASE}/audit?limit=2`)
        .set('cookie', admin.cookie)
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);
      expect(typeof first.body.nextCursor).toBe('string');

      const second = await request(app)
        .get(`${BASE}/audit?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set('cookie', admin.cookie)
        .expect(200);
      const firstIds = (first.body.items as Array<{ id: string }>).map((row) => row.id);
      const secondIds = (second.body.items as Array<{ id: string }>).map((row) => row.id);
      // A total cursor means the windows do not overlap.
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

      const requestId = await raiseRequest(requester, 'Payroll access');
      const byEntity = await request(app)
        .get(`${BASE}/audit?entityType=ServiceRequest&entityId=${requestId}&limit=50`)
        .set('cookie', admin.cookie)
        .expect(200);
      expect(byEntity.body.items.length).toBeGreaterThan(0);
      for (const row of byEntity.body.items as Array<{ entityType: string; entityId: string }>) {
        expect(row.entityType).toBe('ServiceRequest');
        expect(row.entityId).toBe(requestId);
      }

      const byAction = await request(app)
        .get(`${BASE}/audit?action=audit.read&limit=50`)
        .set('cookie', admin.cookie)
        .expect(200);
      for (const row of byAction.body.items as Array<{ action: string }>) {
        expect(row.action).toBe('audit.read');
      }

      // A range that ends before it starts is a validation error, not an empty page.
      await request(app)
        .get(`${BASE}/audit?from=2026-10-08T00:00:00.000Z&to=2026-10-07T00:00:00.000Z`)
        .set('cookie', admin.cookie)
        .expect(422);
    },
  );

  dbIt('docs/31 §2/§5: the security class is withheld without audit:read.security', async () => {
    // An administrator holds `audit:read.all` but not the security class.
    const adminView = await request(app)
      .get(`${BASE}/audit?action=login.success&limit=100`)
      .set('cookie', admin.cookie)
      .expect(200);
    const adminRows = adminView.body.items as Array<{
      security: boolean;
      redacted: boolean;
      sourceIp: string | null;
      before: unknown;
      after: unknown;
    }>;
    expect(adminRows.length).toBeGreaterThan(0);
    for (const row of adminRows) {
      expect(row.security).toBe(true);
      expect(row.redacted).toBe(true);
      // Redaction removes the payload, not just flags it.
      expect(row.sourceIp).toBeNull();
      expect(row.before).toBeNull();
      expect(row.after).toBeNull();
    }

    // The auditor holds `audit:read.security` (granted in setup) and sees the same rows whole.
    const auditorView = await request(app)
      .get(`${BASE}/audit?action=login.success&limit=100`)
      .set('cookie', auditor.cookie)
      .expect(200);
    const auditorRows = auditorView.body.items as Array<{
      security: boolean;
      redacted: boolean;
      sourceIp: string | null;
    }>;
    expect(auditorRows.length).toBeGreaterThan(0);
    for (const row of auditorRows) {
      expect(row.security).toBe(true);
      expect(row.redacted).toBe(false);
    }
    // The stored address is visible to the auditor, which is what redaction withheld above.
    expect(
      auditorRows.some((row) => typeof row.sourceIp === 'string' && row.sourceIp.length > 0),
    ).toBe(true);

    // Asking for the security class without the grant is refused, not silently emptied.
    await request(app)
      .get(`${BASE}/audit?securityOnly=true`)
      .set('cookie', admin.cookie)
      .expect(403);

    // `/audit/security` requires the security grant outright.
    await request(app).get(`${BASE}/audit/security`).set('cookie', admin.cookie).expect(403);
    const securityOnlyPage = await request(app)
      .get(`${BASE}/audit/security?limit=100`)
      .set('cookie', auditor.cookie)
      .expect(200);
    const securityRows = securityOnlyPage.body.items as Array<{ action: string }>;
    expect(securityRows.length).toBeGreaterThan(0);
    for (const row of securityRows) {
      expect(
        ['login.', 'logout', 'password.', 'authz.', 'role.', 'user.'].some((prefix) =>
          row.action.startsWith(prefix),
        ),
      ).toBe(true);
    }

    // A caller with no audit permission cannot read the log at all.
    await request(app).get(`${BASE}/audit`).set('cookie', requester.cookie).expect(403);
  });

  dbIt(
    'docs/31 §5/§10: a record participant reads its history; a foreign caller does not',
    async () => {
      const recordId = await raiseRequest(requester, 'History under test');

      // The requester owns the record, so its history is theirs to read — the record half of §5.
      const participant = await request(app)
        .get(`${BASE}/audit/records/ServiceRequest/${recordId}?limit=100`)
        .set('cookie', requester.cookie)
        .expect(200);
      const participantActions = (participant.body.history as Array<{ action: string }>).map(
        (row) => row.action,
      );
      expect(participantActions).toContain('request.create');
      // Security-class entries never appear in a participant's view of a record.
      for (const action of participantActions) {
        expect(action.startsWith('login.')).toBe(false);
        expect(action.startsWith('user.')).toBe(false);
      }

      // An auditor also reads it, through the audit grant rather than the record's visibility.
      await request(app)
        .get(`${BASE}/audit/records/ServiceRequest/${recordId}`)
        .set('cookie', auditor.cookie)
        .expect(200);

      // The request is fulfilled by team A; team B's agent may not read it, so its history is
      // refused with the same NOT_FOUND a direct read would give — no back door (docs/31 §5).
      const foreign = await request(app)
        .get(`${BASE}/audit/records/ServiceRequest/${recordId}`)
        .set('cookie', agentB.cookie);
      expect(foreign.status).toBe(404);

      // Asset now has a participant-readable projection: a requester may read the history of
      // an asset they hold, so an asset they do not hold is the asset's own 404, not a 403.
      await request(app)
        .get(`${BASE}/audit/records/Asset/00000000-0000-0000-0000-000000000000`)
        .set('cookie', requester.cookie)
        .expect(404);

      // An entity type with no participant-readable projection is auditor-only.
      await request(app)
        .get(`${BASE}/audit/records/User/${requester.userId}`)
        .set('cookie', requester.cookie)
        .expect(403);

      // An unknown entity type is rejected by validation before any lookup.
      await request(app)
        .get(`${BASE}/audit/records/not-a-type/${recordId}`)
        .set('cookie', admin.cookie)
        .expect(422);
    },
  );

  dbIt('docs/31 §6/§9/§10: an audit export is scoped, audited and downloadable', async () => {
    await raiseRequest(agentA, 'Export scope A');
    await raiseRequest(agentB, 'Export scope B');

    const queued = await request(app)
      .post(`${BASE}/audit/export`)
      .set('cookie', lead.cookie)
      .set('x-csrf-token', lead.csrf)
      .send({ action: 'request.create' })
      .expect(202);
    expect(queued.body.export.status).toBe('QUEUED');
    const exportId = queued.body.export.id as string;

    // The export request is itself audited with its filters (§6/§9).
    const requested = await prisma.auditLog.findFirst({
      where: { action: 'audit.export.requested', entityId: exportId },
    });
    expect(requested).not.toBeNull();

    // Nothing runs until the worker claims the job (`docs/30` §5).
    const beforeRun = await request(app)
      .get(`${BASE}/audit/exports/${exportId}`)
      .set('cookie', lead.cookie)
      .expect(200);
    expect(beforeRun.body.export.status).toBe('QUEUED');
    expect(beforeRun.body.export.downloadUrl).toBeNull();

    const processed = await processQueuedExports();
    expect(processed.processed).toBeGreaterThanOrEqual(1);

    const status = await request(app)
      .get(`${BASE}/audit/exports/${exportId}`)
      .set('cookie', lead.cookie)
      .expect(200);
    expect(status.body.export.status).toBe('SUCCEEDED');
    expect(status.body.export.downloadUrl).toBe(`/api/v1/audit/exports/${exportId}/download`);

    const csv = await request(app)
      .get(`${BASE}/audit/exports/${exportId}/download`)
      .set('cookie', lead.cookie)
      .expect(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const csvText =
      typeof csv.text === 'string' && csv.text.length > 0 ? csv.text : String(csv.body);
    expect(csvText).toContain('# scope,team');

    // The export is scoped like a read, not wider (§5): the lead's team member's row is
    // present, the other team's member's is absent.
    const actorColumn = csvText
      .split('\n')
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('occurred_at'))
      .map((line) => line.split(',')[3]);
    expect(actorColumn).toContain(agentA.userId);
    expect(actorColumn).not.toContain(agentB.userId);

    // A caller without `audit:export` cannot queue one...
    await request(app)
      .post(`${BASE}/audit/export`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({})
      .expect(403);

    // ...nor read or download another user's export (self-scoped, `docs/30` §5).
    await request(app)
      .get(`${BASE}/audit/exports/${exportId}`)
      .set('cookie', admin.cookie)
      .expect(404);

    // The security class is refused on export without the grant, as on the read path.
    await request(app)
      .post(`${BASE}/audit/export`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ securityOnly: true })
      .expect(403);

    // An auditor holding the security grant may export the security class.
    const auditorQueued = await request(app)
      .post(`${BASE}/audit/export`)
      .set('cookie', auditor.cookie)
      .set('x-csrf-token', auditor.csrf)
      .send({ securityOnly: true })
      .expect(202);
    expect(auditorQueued.body.export.id).toBeTruthy();
  });

  dbIt('docs/31 §9: there is no route that can update or delete an audit entry', async () => {
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { organizationId } });

    // The surface exposes reads only: a mutation verb is a 404 because no route matches.
    await request(app)
      .patch(`${BASE}/audit/${entry.id}`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ action: 'tampered' })
      .expect(404);
    await request(app)
      .delete(`${BASE}/audit/${entry.id}`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(404);

    // And the database trigger catches a direct edit, which is the real enforcement.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit_logs SET action = 'tampered' WHERE id = '${entry.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${entry.id}'`),
    ).rejects.toThrow();
  });
});
