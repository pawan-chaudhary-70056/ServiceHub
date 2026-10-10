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
 * Session self-service and team administration — integration tests (docs/06 §7, docs/07
 * §6, docs/37 §3).
 *
 * Two surfaces that both widen or narrow what a person can reach:
 *
 *   - **sessions**: revocation is immediate and durable, and a caller can only ever see
 *     or revoke their own — there is no id to guess (`06` §7);
 *   - **teams**: membership decides which records a team-scoped grant resolves to
 *     (`07` §6), so adding a member takes `user:manage` and the target must belong to the
 *     same tenant.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@sessions-teams.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-teams.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-teams.test';
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
       attachments,
       webhook_deliveries, webhook_subscriptions, webhook_fanout_states,
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

interface SessionItem {
  id: string;
  current: boolean;
  sourceIp: string | null;
  userAgent: string | null;
  createdAt: string;
  absoluteExpiresAt: string;
}

describe('Session self-service and team administration', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };
  let aliceUserId = '';
  let organizationId = '';
  let aliceSecondSessionId = '';

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

  dbIt('provisions a tenant with an administrator and a requester', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Teams',
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
    const onboarded = await onboard(ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');
    alice = onboarded;
    aliceUserId = onboarded.userId;
  });

  dbIt('lists only the caller’s own sessions and marks the current one', async () => {
    // A second login from "another device" gives Alice two live sessions.
    sessionFrom(await login(ALICE_EMAIL, ALICE_PASSWORD));

    const listed = await request(app)
      .get(`${BASE}/auth/sessions`)
      .set('cookie', alice.cookie)
      .expect(200);
    const items = listed.body.items as SessionItem[];
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.current)).toHaveLength(1);

    // No session material is ever in the response body (docs/19 §1).
    expect(JSON.stringify(listed.body)).not.toContain('tokenHash');
    expect(JSON.stringify(listed.body)).not.toContain('csrfSecretHash');

    // Remembered for the revocation test below.
    aliceSecondSessionId = items.find((item) => !item.current)?.id ?? '';
    expect(aliceSecondSessionId).toBeTruthy();
  });

  dbIt('revokes one of the caller’s sessions immediately and durably', async () => {
    const sessionId = aliceSecondSessionId;
    expect(sessionId).toBeTruthy();

    await request(app)
      .delete(`${BASE}/auth/sessions/${sessionId}`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .expect(204);

    // The row is revoked, not deleted: the audit trail survives (docs/31 §3).
    const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId as string } });
    expect(row.revokedAt).not.toBeNull();

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'session.revoke', entityId: sessionId as string },
    });
    expect(audited).not.toBeNull();

    const remaining = await request(app)
      .get(`${BASE}/auth/sessions`)
      .set('cookie', alice.cookie)
      .expect(200);
    expect((remaining.body.items as SessionItem[]).map((item) => item.id)).not.toContain(sessionId);
  });

  dbIt('never lets a caller see or revoke someone else’s session', async () => {
    const adminSessions = await request(app)
      .get(`${BASE}/auth/sessions`)
      .set('cookie', admin.cookie)
      .expect(200);
    const adminSessionId = (adminSessions.body.items as SessionItem[])[0]?.id as string;

    // Alice asking for the administrator's session is NOT_FOUND, not FORBIDDEN: the API
    // must not confirm that the id exists (docs/17 §5).
    await request(app)
      .delete(`${BASE}/auth/sessions/${adminSessionId}`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .expect(404);

    // The administrator's session is untouched, and Alice only ever saw her own.
    const adminStill = await request(app)
      .get(`${BASE}/auth/sessions`)
      .set('cookie', admin.cookie)
      .expect(200);
    expect((adminStill.body.items as SessionItem[]).map((item) => item.id)).toContain(
      adminSessionId,
    );
  });

  dbIt('requires authentication and a CSRF token for session revocation', async () => {
    await request(app).get(`${BASE}/auth/sessions`).expect(401);

    const sessions = await request(app)
      .get(`${BASE}/auth/sessions`)
      .set('cookie', alice.cookie)
      .expect(200);
    const id = (sessions.body.items as SessionItem[])[0]?.id as string;

    await request(app)
      .delete(`${BASE}/auth/sessions/${id}`)
      .set('cookie', alice.cookie)
      .expect(403);
  });

  dbIt('creates a team, rejects a duplicate name and refuses a non-administrator', async () => {
    const created = await request(app)
      .post(`${BASE}/teams`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Service Desk', description: 'First line' })
      .expect(201);
    expect(created.body.team.name).toBe('Service Desk');
    expect(created.body.team.members).toEqual([]);

    await request(app)
      .post(`${BASE}/teams`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Service Desk' })
      .expect(409);

    // Membership decides record visibility, so creating or staffing a team is user
    // administration — `catalog:read` is not enough (docs/07 §6).
    await request(app)
      .post(`${BASE}/teams`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ name: 'Shadow Ops' })
      .expect(403);

    // Any tenant member can still see which teams exist, to route work to them.
    const teams = await request(app).get(`${BASE}/teams`).set('cookie', alice.cookie).expect(200);
    expect((teams.body.items as Array<{ name: string }>).map((t) => t.name)).toContain(
      'Service Desk',
    );
  });

  dbIt('adds and removes members, auditing both, and rejects a foreign user', async () => {
    const teams = await request(app).get(`${BASE}/teams`).set('cookie', admin.cookie).expect(200);
    const teamId = (teams.body.items as Array<{ id: string }>)[0]?.id as string;

    const added = await request(app)
      .post(`${BASE}/teams/${teamId}/members`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ userId: aliceUserId, role: 'LEAD' })
      .expect(200);
    const members = added.body.team.members as Array<{
      userId: string;
      role: string;
      email: string;
    }>;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: aliceUserId, role: 'LEAD', email: ALICE_EMAIL });

    // Membership is what team-scoped read uses, so the grant must be visible to the
    // caller it concerns (docs/07 §6).
    const aliceTeamIds = await prisma.teamMember.findMany({ where: { userId: aliceUserId } });
    expect(aliceTeamIds).toHaveLength(1);

    const auditedAdd = await prisma.auditLog.findFirst({
      where: { action: 'team.member.add', entityId: teamId },
    });
    expect(auditedAdd).not.toBeNull();

    // A user id that is not in this tenant is a validation failure, never a cross-tenant
    // membership row (ADR-0002).
    await request(app)
      .post(`${BASE}/teams/${teamId}/members`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ userId: '00000000-0000-0000-0000-000000000000' })
      .expect(422);

    // A requester cannot staff a team.
    await request(app)
      .post(`${BASE}/teams/${teamId}/members`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ userId: aliceUserId })
      .expect(403);

    await request(app)
      .delete(`${BASE}/teams/${teamId}/members/${aliceUserId}`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(204);

    const after = await request(app)
      .get(`${BASE}/teams/${teamId}/members`)
      .set('cookie', admin.cookie)
      .expect(200);
    expect(after.body.team.members).toEqual([]);

    const auditedRemove = await prisma.auditLog.findFirst({
      where: { action: 'team.member.remove', entityId: teamId },
    });
    expect(auditedRemove).not.toBeNull();
  });

  dbIt('treats a team from another tenant as not found', async () => {
    // A second tenant with its own team: the id exists, but not for this caller.
    const other = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Umbrella Teams',
        administratorEmail: 'admin@umbrella-teams.test',
        administratorName: 'Umbrella Admin',
        defaultTimeZone: 'UTC',
      })
      .expect(201);
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: other.body.invitation.token, password: 'Umbr3lla-Passphrase!' })
      .expect(204);
    const otherAdmin = sessionFrom(
      await login('admin@umbrella-teams.test', 'Umbr3lla-Passphrase!'),
    );

    const otherTeam = await request(app)
      .post(`${BASE}/teams`)
      .set('cookie', otherAdmin.cookie)
      .set('x-csrf-token', otherAdmin.csrf)
      .send({ name: 'Umbrella Desk' })
      .expect(201);

    await request(app)
      .get(`${BASE}/teams/${otherTeam.body.team.id}/members`)
      .set('cookie', admin.cookie)
      .expect(404);
    void organizationId;
  });
});
