import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import request, { type Response as SupertestResponse, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword, sha256 } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import { MemoryRateLimitStore } from '../src/integrations/rate-limit-store';
import { createRateLimiter } from '../src/middlewares/rate-limit';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
} from '../src/models';

/**
 * Authentication, injection and abuse tests — docs/20 §6, §7, §8, §9.
 *
 * What each covers:
 *   - **§6** credential handling: uniform failure (no enumeration oracle), lockout with a
 *     `Retry-After` hint, server-side logout, single-use reset that revokes sessions, and
 *     token storage that keeps only a hash.
 *   - **§7** injection and input: a SQL-injection corpus against filters and ids, operator
 *     injection, mass assignment, oversized bodies, malformed JSON, and XSS-shaped data
 *     that must round-trip as data, never as markup.
 *   - **§8** abuse: the rate limiter rejects with `429` + `Retry-After`, over-limit page
 *     sizes are refused, and absurd report ranges are rejected rather than executed.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@sec-input.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-input.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-input.test';
const ALICE_PASSWORD = 'V7kLm2-Qz9p!x';
const LOCKME_EMAIL = 'lockme@initech-input.test';
const LOCKME_PASSWORD = 'H4qWn8-Zr2s!m';
const VICTIM_EMAIL = 'victim@initech-input.test';
const VICTIM_PASSWORD = 'M4dFs7-Qh3b!t';
const RESET_PASSWORD = 'R3set-Passphrase!zq';

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

function sessionFrom(response: SupertestResponse): { cookie: string; csrf: string } {
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

describe('docs/20 §6/§7/§8 authentication, input and abuse', () => {
  let operator: Session;
  let admin: Session;
  let alice: Session;
  let itemId = '';

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

  dbIt('sets up a tenant with an administrator and a requester', async () => {
    operator = { ...sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD)), userId: '' };
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Input',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Initech Admin',
        defaultTimeZone: 'Europe/London',
      });
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: provisioned.body.invitation.token, password: ADMIN_PASSWORD })
      .expect(204);
    // The provisioned administrator already holds ADMINISTRATOR; only capture the session.
    admin = {
      ...sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD)),
      userId: (await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } })).id,
    };

    alice = await onboard(admin, ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');
    await onboard(admin, LOCKME_EMAIL, LOCKME_PASSWORD, 'REQUESTER', 'Lock Me');
    await onboard(admin, VICTIM_EMAIL, VICTIM_PASSWORD, 'REQUESTER', 'Victim User');

    const organizationId = (await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } }))
      .organizationId as string;
    const team = await prisma.team.create({
      data: { organizationId, name: 'Service Desk' },
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
        name: 'Standard laptop',
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
  });

  // -------------------------------------------------------------------------
  // §6 — authentication
  // -------------------------------------------------------------------------
  dbIt(
    'answers an unknown user and a wrong password identically (no enumeration oracle)',
    async () => {
      const unknown = await login('nobody@initech-input.test', 'Some-Passphrase!42');
      const wrongPassword = await login(ALICE_EMAIL, 'Wrong-Passphrase!42');

      expect(unknown.status).toBe(401);
      expect(wrongPassword.status).toBe(401);
      // Same status, same code, same detail: the response does not reveal which was wrong.
      expect(unknown.body.code).toBe(wrongPassword.body.code);
      expect(unknown.body.detail).toBe(wrongPassword.body.detail);
    },
  );

  dbIt('answers forgot-password identically for a known and an unknown address', async () => {
    const known = await request(app).post(`${BASE}/auth/forgot`).send({ email: ALICE_EMAIL });
    const unknown = await request(app)
      .post(`${BASE}/auth/forgot`)
      .send({ email: 'nobody@initech-input.test' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  dbIt(
    'locks an account after repeated failures and refuses the correct password too',
    async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await login(LOCKME_EMAIL, `Wrong-Passphrase!${attempt}`);
        expect(response.status).toBe(401);
      }

      const locked = await login(LOCKME_EMAIL, LOCKME_PASSWORD);
      expect(locked.status).toBe(423);
      expect(locked.headers['retry-after']).toBeDefined();
    },
  );

  dbIt('invalidates the session server-side on logout', async () => {
    const session = sessionFrom(await login(ALICE_EMAIL, ALICE_PASSWORD));
    await request(app).get(`${BASE}/auth/me`).set('cookie', session.cookie).expect(200);

    await request(app)
      .post(`${BASE}/auth/logout`)
      .set('cookie', session.cookie)
      .set('x-csrf-token', session.csrf)
      .expect(204);

    // Replaying the revoked cookie fails: logout is a database revocation, not a client hint.
    await request(app).get(`${BASE}/auth/me`).set('cookie', session.cookie).expect(401);
  });

  dbIt('stores only a hash of a reset token and refuses an expired one', async () => {
    await request(app).post(`${BASE}/auth/forgot`).send({ email: ALICE_EMAIL }).expect(202);

    const event = await prisma.outbox.findFirstOrThrow({
      where: { eventType: 'notification.password.reset' },
      orderBy: { occurredAt: 'desc' },
    });
    const resetUrl = (event.payload as { resetUrl: string }).resetUrl;
    const rawToken = decodeURIComponent(new URL(resetUrl).searchParams.get('token') ?? '');
    expect(rawToken.length).toBeGreaterThan(20);

    // The database holds only the digest of the token, never the token itself (docs/06).
    const stored = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: alice.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored.tokenHash).toBe(sha256(rawToken));
    expect(stored.tokenHash).not.toBe(rawToken);

    // An expired token is rejected exactly like an unknown one.
    const expiredToken = 'expired-token-value-for-the-security-suite';
    await prisma.passwordResetToken.create({
      data: {
        userId: alice.userId,
        tokenHash: sha256(expiredToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const expired = await request(app)
      .post(`${BASE}/auth/reset`)
      .send({ token: expiredToken, password: RESET_PASSWORD });
    expect(expired.status).toBe(422);
  });

  dbIt('consumes a reset token once and revokes every live session (docs/06 §5)', async () => {
    const victimLive = sessionFrom(await login(VICTIM_EMAIL, VICTIM_PASSWORD));
    await request(app).get(`${BASE}/auth/me`).set('cookie', victimLive.cookie).expect(200);

    await request(app).post(`${BASE}/auth/forgot`).send({ email: VICTIM_EMAIL }).expect(202);
    const event = await prisma.outbox.findFirstOrThrow({
      where: {
        eventType: 'notification.password.reset',
        payload: { path: ['email'], equals: VICTIM_EMAIL },
      },
      orderBy: { occurredAt: 'desc' },
    });
    const rawToken = decodeURIComponent(
      new URL((event.payload as { resetUrl: string }).resetUrl).searchParams.get('token') ?? '',
    );

    await request(app)
      .post(`${BASE}/auth/reset`)
      .send({ token: rawToken, password: RESET_PASSWORD })
      .expect(204);

    // The session that existed before the reset is revoked.
    await request(app).get(`${BASE}/auth/me`).set('cookie', victimLive.cookie).expect(401);

    // The token cannot be replayed.
    const replay = await request(app)
      .post(`${BASE}/auth/reset`)
      .send({ token: rawToken, password: 'An0ther-Passphrase!xy' });
    expect(replay.status).toBe(422);

    // The new password works.
    const relogin = await login(VICTIM_EMAIL, RESET_PASSWORD);
    expect(relogin.status).toBe(200);
  });

  dbIt('deactivation takes effect on a live session immediately (docs/06 §7)', async () => {
    const victim = await prisma.user.findUniqueOrThrow({ where: { email: VICTIM_EMAIL } });
    const live = sessionFrom(await login(VICTIM_EMAIL, RESET_PASSWORD));
    await request(app).get(`${BASE}/auth/me`).set('cookie', live.cookie).expect(200);

    await request(app)
      .post(`${BASE}/users/${victim.id}/deactivate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(204);

    await request(app).get(`${BASE}/auth/me`).set('cookie', live.cookie).expect(401);
    await login(VICTIM_EMAIL, RESET_PASSWORD).expect(401);
  });

  it('rate limits a caller with 429 and a Retry-After header (docs/20 §8)', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      store: new MemoryRateLimitStore(),
    });

    const headers: Record<string, string> = {};
    const req = {
      ip: '203.0.113.7',
      headers: {},
      method: 'POST',
      path: '/',
    } as unknown as ExpressRequest;
    const res = {
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
      hasHeader: (key: string) => key in headers,
    } as unknown as ExpressResponse;

    const run = () =>
      new Promise<unknown>((resolve) => {
        limiter(req, res, (error?: unknown) => resolve(error));
      });

    expect(await run()).toBeUndefined();
    expect(await run()).toBeUndefined();

    const rejection = await run();
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as { code?: string }).code).toBe('RATE_LIMITED');
    expect(headers['Retry-After']).toBeDefined();
    expect(headers['RateLimit-Limit']).toBe('2');
  });

  // -------------------------------------------------------------------------
  // §7 — injection and input
  // -------------------------------------------------------------------------
  dbIt('is not susceptible to SQL injection through search or id parameters', async () => {
    const payloads = ["' OR 1=1--", '1; DROP TABLE users;--', "' UNION SELECT * FROM users--"];
    for (const payload of payloads) {
      const searchResponse = await request(app)
        .get(`${BASE}/search?q=${encodeURIComponent(payload)}`)
        .set('cookie', admin.cookie);
      expect(searchResponse.status).toBe(200);
      expect(searchResponse.body.items).toHaveLength(0);
    }

    // An injection-shaped id fails the identifier format check (422) without touching SQL.
    const idResponse = await request(app)
      .get(`${BASE}/requests/${encodeURIComponent("' OR '1'='1")}`)
      .set('cookie', admin.cookie);
    expect(idResponse.status).toBe(422);

    // A filter enum carrying an injection string is a 422, not a query.
    const filterResponse = await request(app)
      .get(`${BASE}/requests?status=${encodeURIComponent("NEW' OR '1'='1")}`)
      .set('cookie', admin.cookie);
    expect(filterResponse.status).toBe(422);
  });

  dbIt('rejects operator injection where a scalar is expected', async () => {
    const response = await request(app)
      .post(`${BASE}/auth/login`)
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  dbIt('ignores undeclared fields and never mass-assigns', async () => {
    const response = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({
        catalogItemId: itemId,
        title: 'Mass assignment attempt',
        fields: {},
        // None of these are part of the request schema.
        organizationId: 'attacker-supplied',
        status: 'CLOSED',
        requesterId: 'someone-else',
      });
    expect(response.status).toBe(422);

    // A clean request in the same tenant persists with server-derived values only.
    const clean = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'A clean request', fields: {} });
    expect(clean.status).toBe(201);
    expect(clean.body.request.requester.id).toBe(alice.userId);
    expect(clean.body.request.status).toBe('NEW');
  });

  dbIt('bounds oversized input with 413/422 and rejects malformed JSON with 400', async () => {
    const oversizedField = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'x'.repeat(5000), fields: {} });
    expect(oversizedField.status).toBe(422);

    const oversizedBody = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          catalogItemId: itemId,
          title: 'ok',
          fields: { big: 'x'.repeat(2_000_000) },
        }),
      );
    expect(oversizedBody.status).toBe(413);

    const malformed = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .set('content-type', 'application/json')
      .send('{ "catalogItemId": ');
    expect(malformed.status).toBe(400);
    expect(malformed.headers['content-type']).toContain('application/problem+json');
    // No stack trace or SQL reaches the client.
    expect(JSON.stringify(malformed.body)).not.toMatch(/at .*\.ts:|SELECT |prisma/i);
  });

  dbIt('treats XSS-shaped data as data, never as reflected markup', async () => {
    const payload = '<script>alert("xss")</script>';
    const created = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: payload, fields: {} });
    expect(created.status).toBe(201);

    // The value round-trips verbatim as JSON — escaping belongs to the renderer, and the
    // API never serves it as HTML, so it cannot execute on its own.
    expect(created.headers['content-type']).toContain('application/json');
    const read = await request(app)
      .get(`${BASE}/requests/${created.body.request.id}`)
      .set('cookie', alice.cookie);
    expect(read.body.request.title).toBe(payload);
    expect(read.headers['content-type']).toContain('application/json');
  });

  dbIt(
    'rejects a path-traversal id and an absurd report range without a server error',
    async () => {
      const traversal = await request(app)
        .get(`${BASE}/catalog/items/${encodeURIComponent('../../etc/passwd')}`)
        .set('cookie', admin.cookie);
      expect(traversal.status).toBe(422);

      const absurdRange = await request(app)
        .get(
          `${BASE}/reports/requests.summary?from=9999-01-01T00:00:00.000Z&to=0000-01-01T00:00:00.000Z`,
        )
        .set('cookie', admin.cookie);
      expect(absurdRange.status).toBeGreaterThanOrEqual(400);
      expect(absurdRange.status).toBeLessThan(500);
    },
  );

  // -------------------------------------------------------------------------
  // §8 — abuse
  // -------------------------------------------------------------------------
  dbIt('refuses an over-limit page size and a malformed cursor', async () => {
    const tooLarge = await request(app)
      .get(`${BASE}/requests?limit=1000`)
      .set('cookie', admin.cookie);
    expect(tooLarge.status).toBe(422);

    const malformedCursor = await request(app)
      .get(`${BASE}/requests?cursor=${encodeURIComponent('!!!not-base64-json!!!')}`)
      .set('cookie', admin.cookie);
    expect(malformedCursor.status).toBe(422);
  });
});
