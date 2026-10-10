import request, { type Response, type Test } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import { SIGNATURE_HEADER, signWebhookPayload } from '../src/integrations/webhook-signature';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
} from '../src/models';
import {
  clearInboundHandlers,
  processInboundWebhookEvents,
  registerInboundHandler,
} from '../src/services/inbound-webhook.service';

/**
 * Inbound webhooks — integration tests (docs/37 §3, docs/32 §5/§15).
 *
 * AC2 of `docs/32` §15 is the spine: "Inbound webhooks reject unsigned, stale, or duplicate
 * events." Each is asserted here against the **public** route, which has no session — the
 * signature is the only authentication. Also asserted: an unprocessable event dead-letters
 * and is visible and retryable (`§5`, `§12`).
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@inbound.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-inbound.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-inbound.test';
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
       inbound_webhook_events, inbound_webhook_endpoints,
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

describe('Inbound webhooks', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };

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

  afterEach(() => {
    clearInboundHandlers();
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

  /** Registers a receiver and returns its key and secret. */
  async function registerEndpoint(
    key: string,
    provider = 'Acme Tickets',
  ): Promise<{ key: string; secret: string }> {
    const created = await request(app)
      .post(`${BASE}/admin/inbound-endpoints`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ key, provider })
      .expect(201);
    return {
      key: created.body.endpoint.key as string,
      secret: created.body.endpoint.secret as string,
    };
  }

  /** Posts a body to the public inbound route, signed with `secret` at `timestampMs`. */
  function postInbound(
    key: string,
    body: string,
    secret: string | null,
    timestampMs = Date.now(),
  ): Test {
    const req = request(app)
      .post(`${BASE}/webhooks/inbound/${key}`)
      .set('Content-Type', 'application/json');
    if (secret) req.set(SIGNATURE_HEADER, signWebhookPayload(secret, body, timestampMs));
    return req.send(body);
  }

  dbIt('provisions a tenant with an administrator and a requester', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Inbound',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Initech Admin',
        defaultTimeZone: 'Europe/London',
      });
    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: provisioned.body.invitation.token, password: ADMIN_PASSWORD })
      .expect(204);
    admin = sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD));
    alice = await onboard(ALICE_EMAIL, ALICE_PASSWORD, 'REQUESTER', 'Alice Requester');
  });

  dbIt('returns the verification secret once and never on read', async () => {
    const created = await request(app)
      .post(`${BASE}/admin/inbound-endpoints`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ key: 'acme-tickets', provider: 'Acme Tickets' })
      .expect(201);

    expect(created.body.endpoint.secret).toBeTruthy();
    expect(created.body.endpoint.path).toBe('/api/v1/webhooks/inbound/acme-tickets');

    const listed = await request(app)
      .get(`${BASE}/admin/inbound-endpoints`)
      .set('cookie', admin.cookie)
      .expect(200);
    const first = (listed.body.endpoints as Array<{ secret?: string }>)[0]!;
    expect(first.secret).toBeUndefined();
  });

  dbIt('forbids a caller without an integration grant', async () => {
    await request(app)
      .get(`${BASE}/admin/inbound-endpoints`)
      .set('cookie', alice.cookie)
      .expect(403);
    await request(app)
      .post(`${BASE}/admin/inbound-endpoints`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ key: 'sneaky', provider: 'Sneaky' })
      .expect(403);
  });

  dbIt(
    'rejects unsigned, stale and unknown-key deliveries, and accepts a valid one idempotently',
    async () => {
      const { key, secret } = await registerEndpoint('acme-signed', 'Acme Signed');
      const body = JSON.stringify({
        id: 'evt-1',
        type: 'ticket.closed',
        data: { ticketId: 'T-1' },
      });

      // Unsigned → 401 (mandatory signature).
      await postInbound(key, body, null).expect(401);
      // Wrong secret → 401.
      await postInbound(key, body, 'a-different-secret').expect(401);
      // Genuine but stale → 401 (replay window).
      await postInbound(key, body, secret, Date.now() - 60 * 60 * 1000).expect(401);
      // Unknown key → 401, indistinguishable from a bad signature.
      await postInbound('no-such-endpoint', body, secret).expect(401);

      // Valid → 202, not a duplicate.
      const first = await postInbound(key, body, secret).expect(202);
      expect(first.body).toMatchObject({ accepted: true, duplicate: false });

      // The provider retries the same event → still 202, but a duplicate no-op.
      const second = await postInbound(key, body, secret).expect(202);
      expect(second.body).toMatchObject({ accepted: true, duplicate: true });

      const count = await prisma.inboundWebhookEvent.count({ where: { providerEventId: 'evt-1' } });
      expect(count).toBe(1);
    },
  );

  dbIt(
    'persists the raw event, then processes it in the worker (not on the request path)',
    async () => {
      const { key, secret } = await registerEndpoint('acme-receipt', 'Acme Receipt');

      // The event is RECEIVED and unprocessed immediately after the ack.
      await postInbound(
        key,
        JSON.stringify({ id: 'evt-2', type: 'ticket.closed', data: { ticketId: 'T-2' } }),
        secret,
      ).expect(202);
      const endpoint = await prisma.inboundWebhookEndpoint.findUniqueOrThrow({ where: { key } });
      const received = await prisma.inboundWebhookEvent.findUniqueOrThrow({
        where: {
          endpointId_providerEventId: { endpointId: endpoint.id, providerEventId: 'evt-2' },
        },
      });
      expect(received.status).toBe('RECEIVED');

      const seen: string[] = [];
      registerInboundHandler('ticket.closed', async (event) => {
        seen.push(event.id);
      });

      const result = await processInboundWebhookEvents({ jitter: () => 0 });
      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(seen).toContain(received.id);

      const processed = await prisma.inboundWebhookEvent.findUniqueOrThrow({
        where: { id: received.id },
      });
      expect(processed.status).toBe('PROCESSED');
    },
  );

  dbIt('accepts an event with no registered handler without failing it', async () => {
    const { key, secret } = await registerEndpoint('acme-unhandled', 'Acme Unhandled');
    await postInbound(key, JSON.stringify({ id: 'evt-3', type: 'no.handler' }), secret).expect(202);

    await processInboundWebhookEvents({ jitter: () => 0 });
    const event = await prisma.inboundWebhookEvent.findFirstOrThrow({
      where: { providerEventId: 'evt-3' },
    });
    expect(event.status).toBe('PROCESSED');
  });

  dbIt(
    'retries a failing handler with backoff, dead-letters, and exposes an audited retry',
    async () => {
      const { key, secret } = await registerEndpoint('acme-broken', 'Acme Broken');
      await postInbound(key, JSON.stringify({ id: 'evt-4', type: 'ticket.broken' }), secret).expect(
        202,
      );

      // A handler that always throws drives the attempt chain to exhaustion.
      registerInboundHandler('ticket.broken', async () => {
        throw new Error('Handler could not process the event.');
      });

      let clock = Date.now();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        clock += 2 * 60 * 60 * 1000;
        await processInboundWebhookEvents({ now: new Date(clock), jitter: () => 0 });
      }

      const dead = await prisma.inboundWebhookEvent.findFirstOrThrow({
        where: { providerEventId: 'evt-4' },
      });
      expect(dead.status).toBe('DEAD_LETTER');

      // Visible through the admin API.
      const listed = await request(app)
        .get(`${BASE}/admin/integrations/inbound-dead-letters`)
        .set('cookie', admin.cookie)
        .expect(200);
      expect((listed.body.deliveries as Array<{ id: string }>).some((r) => r.id === dead.id)).toBe(
        true,
      );

      // An explicit retry requeues it; a now-working handler completes it.
      const retried = await request(app)
        .post(`${BASE}/admin/integrations/inbound-dead-letters/${dead.id}/retry`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .expect(200);
      expect(retried.body.event.status).toBe('RECEIVED');

      registerInboundHandler('ticket.broken', async () => undefined);
      await processInboundWebhookEvents({ now: new Date(clock + 60_000), jitter: () => 0 });
      const after = await prisma.inboundWebhookEvent.findUniqueOrThrow({ where: { id: dead.id } });
      expect(after.status).toBe('PROCESSED');
    },
  );
});
