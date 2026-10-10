import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import {
  SIGNATURE_HEADER,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../src/integrations/webhook-signature';
import { createRecordingWebhookClient } from '../src/integrations/webhook-client';
import {
  createCredential,
  createUser,
  disconnectDatabase,
  findRoleByKey,
  grantRoleToUser,
  prisma,
  writeOutboxEvent,
} from '../src/models';
import { OUTBOX_EVENT } from '../src/services/audit-events';
import { processInboundWebhookEvents } from '../src/services/inbound-webhook.service';
import { deliverPendingWebhooks, fanoutWebhooks } from '../src/services/webhook.service';

/**
 * Outbound webhooks — integration tests (docs/37 §3, docs/32 §4/§15).
 *
 * The behaviour under test is the security core of an integration:
 *
 *   - a delivery is **signed** over the raw body with the subscription secret, so a receiver
 *     can verify it (`docs/32` §4);
 *   - the payload is **minimal** — ids, type, timestamp — never the record, because a webhook
 *     is an exfiltration surface (`docs/32` §4/§10);
 *   - a failing subscriber is retried and then **dead-lettered**, and a dead-letter is
 *     visible and explicitly retryable (`§4`, `§12`);
 *   - the signing secret is returned **once**, never on read (`§7`).
 *
 * The worker is driven with a recording client, so no network is touched (`docs/37` §3). The
 * fan-out reads the durable outbox, so the test writes an outbox row directly with the same
 * helper the domain services use.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@webhooks.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-hooks.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-hooks.test';
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

interface SubscriptionBody {
  subscription: {
    id: string;
    description: string;
    url: string;
    events: string[];
    enabled: boolean;
    secretHint: string;
    secret?: string;
    deadLetterCount: number;
  };
}

/** Advances the clock past a delivery's backoff so the next attempt is due. */
async function deliverNow(
  scripts: Parameters<typeof createRecordingWebhookClient>[0],
  now: Date,
): Promise<ReturnType<typeof createRecordingWebhookClient>> {
  const recorder = createRecordingWebhookClient(scripts);
  await deliverPendingWebhooks({ client: recorder.client, now });
  return recorder;
}

describe('Outbound webhooks', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };
  let organizationId = '';

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

  dbIt('provisions a tenant with an administrator and a requester', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Hooks',
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
  });

  dbIt('returns the signing secret once and never on read', async () => {
    const created = await request(app)
      .post(`${BASE}/admin/webhooks`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        description: 'Downstream ticketing',
        url: 'https://hooks.example.test/inbound',
        events: [OUTBOX_EVENT.REQUEST_CREATED],
      })
      .expect(201);

    const body = created.body as SubscriptionBody;
    expect(body.subscription.secret).toBeTruthy();
    expect(body.subscription.secretHint).toMatch(/^••••/);

    const listed = await request(app)
      .get(`${BASE}/admin/webhooks`)
      .set('cookie', admin.cookie)
      .expect(200);
    const first = (listed.body.subscriptions as SubscriptionBody['subscription'][])[0]!;
    expect(first.secret).toBeUndefined();
    expect(first.secretHint).toBe(body.subscription.secretHint);
  });

  dbIt('rejects an unknown event and a non-HTTPS URL', async () => {
    await request(app)
      .post(`${BASE}/admin/webhooks`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        description: 'Bad event',
        url: 'https://hooks.example.test/inbound',
        events: ['notification.not.a.real.event'],
      })
      .expect(422);

    await request(app)
      .post(`${BASE}/admin/webhooks`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        description: 'Insecure',
        url: 'http://hooks.example.test/inbound',
        events: [OUTBOX_EVENT.REQUEST_CREATED],
      })
      .expect(422);
  });

  dbIt('exposes the subscribable event vocabulary to an integration reader only', async () => {
    const events = await request(app)
      .get(`${BASE}/admin/webhooks/events`)
      .set('cookie', admin.cookie)
      .expect(200);
    expect(events.body.events).toContain(OUTBOX_EVENT.REQUEST_CREATED);

    await request(app).get(`${BASE}/admin/webhooks/events`).set('cookie', alice.cookie).expect(403);
  });

  dbIt('forbids a caller without an integration grant', async () => {
    await request(app).get(`${BASE}/admin/webhooks`).set('cookie', alice.cookie).expect(403);
    await request(app)
      .post(`${BASE}/admin/webhooks`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({
        description: 'Sneaky',
        url: 'https://hooks.example.test/inbound',
        events: [OUTBOX_EVENT.REQUEST_CREATED],
      })
      .expect(403);
  });

  dbIt('fans out an outbox event and delivers it signed with a minimal payload', async () => {
    const created = await request(app)
      .post(`${BASE}/admin/webhooks`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        description: 'Signed delivery',
        url: 'https://hooks.example.test/signed',
        events: [OUTBOX_EVENT.REQUEST_ASSIGNED],
      })
      .expect(201);
    const secret = (created.body as SubscriptionBody).subscription.secret as string;

    const event = await writeOutboxEvent({
      organizationId,
      eventType: OUTBOX_EVENT.REQUEST_ASSIGNED,
      // A full record-like payload: the delivery must copy only the identifiers.
      payload: {
        requestId: '11111111-1111-1111-1111-111111111111',
        requesterId: '22222222-2222-2222-2222-222222222222',
        subject: 'Password reset for a named employee',
      },
      idempotencyKey: `test-webhook-${Date.now()}`,
    });

    const fanout = await fanoutWebhooks();
    expect(fanout.created).toBeGreaterThanOrEqual(1);

    const recorder = await deliverNow([{ delivered: true, status: 200 }], new Date());
    expect(recorder.requests).toHaveLength(1);
    const sent = recorder.requests[0]!;

    // The signature verifies against the raw body with the subscription secret.
    const verified = verifyWebhookSignature(secret, sent.body, sent.headers[SIGNATURE_HEADER]!, {
      toleranceSeconds: 300,
      nowMs: Date.now(),
    });
    expect(verified.valid).toBe(true);

    const payload = JSON.parse(sent.body) as Record<string, unknown>;
    expect(payload.id).toBe(event.id);
    expect(payload.type).toBe(OUTBOX_EVENT.REQUEST_ASSIGNED);
    // Minimal: every `*Id` identifier travels, but the free-text `subject` and the record
    // body do not — a webhook is an exfiltration surface (docs/32 §4/§10).
    expect(payload.subject).toEqual({
      requestId: '11111111-1111-1111-1111-111111111111',
      requesterId: '22222222-2222-2222-2222-222222222222',
    });
    expect(sent.body).not.toContain('Password reset');

    // Idempotency: re-scanning the stream and re-delivering adds nothing.
    await fanoutWebhooks();
    await deliverPendingWebhooks({
      client: createRecordingWebhookClient([{ delivered: true, status: 200 }]).client,
      now: new Date(),
    });
    const deliveries = await prisma.webhookDelivery.count({ where: { eventId: event.id } });
    expect(deliveries).toBe(1);
  });

  dbIt(
    'retries a failing subscriber with backoff, then dead-letters and allows an explicit retry',
    async () => {
      await request(app)
        .post(`${BASE}/admin/webhooks`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({
          description: 'Unreliable subscriber',
          url: 'https://hooks.example.test/broken',
          events: [OUTBOX_EVENT.INCIDENT_REPORTED],
        })
        .expect(201);

      const event = await writeOutboxEvent({
        organizationId,
        eventType: OUTBOX_EVENT.INCIDENT_REPORTED,
        payload: { incidentId: '33333333-3333-3333-3333-333333333333' },
        idempotencyKey: `test-webhook-fail-${Date.now()}`,
      });
      await fanoutWebhooks();

      // Drive the attempt chain to exhaustion; the clock moves past each backoff window.
      let clock = Date.now();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        clock += 2 * 60 * 60 * 1000;
        await deliverPendingWebhooks({
          client: createRecordingWebhookClient([
            {
              delivered: false,
              status: 503,
              failureReason: 'Subscriber failed to accept the delivery (HTTP 503).',
            },
          ]).client,
          now: new Date(clock),
        });
      }

      const deadLetter = await prisma.webhookDelivery.findFirstOrThrow({
        where: { eventId: event.id },
      });
      expect(deadLetter.status).toBe('DEAD_LETTER');
      expect(deadLetter.attempts).toBeGreaterThanOrEqual(2);

      // The dead-letter is visible through the API and retryable.
      const listed = await request(app)
        .get(`${BASE}/admin/integrations/dead-letters`)
        .set('cookie', admin.cookie)
        .expect(200);
      const view = (listed.body.deliveries as Array<{ id: string; status: string }>).find(
        (row) => row.id === deadLetter.id,
      );
      expect(view?.status).toBe('DEAD_LETTER');

      const retried = await request(app)
        .post(`${BASE}/admin/integrations/dead-letters/${deadLetter.id}/retry`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .expect(200);
      expect(retried.body.delivery.status).toBe('PENDING');

      // A healthy subscriber now completes the retried delivery.
      await deliverNow([{ delivered: true, status: 200 }], new Date(clock + 60_000));
      const after = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: deadLetter.id },
      });
      expect(after.status).toBe('DELIVERED');
    },
  );

  dbIt(
    'reports a per-integration health board with last success, last error and dead-letter counts',
    async () => {
      // A healthy outbound integration: one successful delivery.
      await request(app)
        .post(`${BASE}/admin/webhooks`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({
          description: 'Healthy endpoint',
          url: 'https://hooks.example.test/healthy',
          events: [OUTBOX_EVENT.TASK_COMPLETED],
        })
        .expect(201);
      await writeOutboxEvent({
        organizationId,
        eventType: OUTBOX_EVENT.TASK_COMPLETED,
        payload: { taskId: '55555555-5555-5555-5555-555555555555' },
        idempotencyKey: `health-ok-${Date.now()}`,
      });
      await fanoutWebhooks();
      await deliverPendingWebhooks({
        client: createRecordingWebhookClient([{ delivered: true, status: 200 }]).client,
        now: new Date(),
      });

      // An unhealthy outbound integration: a dead-lettered delivery.
      await request(app)
        .post(`${BASE}/admin/webhooks`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({
          description: 'Broken endpoint',
          url: 'https://hooks.example.test/health-broken',
          events: [OUTBOX_EVENT.TASK_BLOCKED],
        })
        .expect(201);
      await writeOutboxEvent({
        organizationId,
        eventType: OUTBOX_EVENT.TASK_BLOCKED,
        payload: { taskId: '66666666-6666-6666-6666-666666666666' },
        idempotencyKey: `health-bad-${Date.now()}`,
      });
      await fanoutWebhooks();
      let clock = Date.now();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        clock += 2 * 60 * 60 * 1000;
        await deliverPendingWebhooks({
          client: createRecordingWebhookClient([
            {
              delivered: false,
              status: 503,
              failureReason: 'Subscriber failed to accept the delivery (HTTP 503).',
            },
          ]).client,
          now: new Date(clock),
        });
      }

      // An inbound integration with a processed event.
      const inbound = await request(app)
        .post(`${BASE}/admin/inbound-endpoints`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ key: 'health-inbound', provider: 'Health Inbound' })
        .expect(201);
      const secret = inbound.body.endpoint.secret as string;
      const eventBody = JSON.stringify({ id: 'health-evt-1', type: 'health.ping' });
      await request(app)
        .post(`${BASE}/webhooks/inbound/health-inbound`)
        .set('Content-Type', 'application/json')
        .set(SIGNATURE_HEADER, signWebhookPayload(secret, eventBody, Date.now()))
        .send(eventBody)
        .expect(202);
      await processInboundWebhookEvents({ jitter: () => 0 });

      const board = await request(app)
        .get(`${BASE}/admin/integrations`)
        .set('cookie', admin.cookie)
        .expect(200);
      const integrations = board.body.integrations as Array<{
        kind: string;
        name: string;
        detail: string;
        healthy: boolean;
        succeeded: number;
        deadLettered: number;
        lastSuccessAt: string | null;
        lastError: string | null;
      }>;

      const healthyRow = integrations.find(
        (row) => row.detail === 'https://hooks.example.test/healthy',
      );
      expect(healthyRow).toMatchObject({
        kind: 'OUTBOUND_WEBHOOK',
        healthy: true,
        deadLettered: 0,
      });
      expect(healthyRow?.lastSuccessAt).not.toBeNull();

      const brokenRow = integrations.find(
        (row) => row.detail === 'https://hooks.example.test/health-broken',
      );
      expect(brokenRow?.healthy).toBe(false);
      expect(brokenRow?.deadLettered).toBeGreaterThanOrEqual(1);
      expect(brokenRow?.lastError).toBeTruthy();

      const inboundRow = integrations.find((row) => row.kind === 'INBOUND_WEBHOOK');
      expect(inboundRow).toMatchObject({
        name: 'Health Inbound',
        detail: 'health-inbound',
        healthy: true,
      });
      expect(inboundRow?.succeeded).toBeGreaterThanOrEqual(1);

      // The board is behind `integration:read`, like the rest of the surface.
      await request(app).get(`${BASE}/admin/integrations`).set('cookie', alice.cookie).expect(403);
    },
  );

  dbIt('exposes roster sync status and runs an audited sync', async () => {
    const status = await request(app)
      .get(`${BASE}/admin/integrations/roster-sync`)
      .set('cookie', admin.cookie)
      .expect(200);
    expect(status.body.rosterSync.status).toBe('NEVER_RUN');
    expect(status.body.rosterSync.driftFraction).toBeGreaterThan(0);

    await request(app)
      .get(`${BASE}/admin/integrations/roster-sync`)
      .set('cookie', alice.cookie)
      .expect(403);

    // No directory is configured in the test environment, so the trigger records a failed run
    // rather than pretending an empty roster means "everyone left" (docs/32 §6).
    const run = await request(app)
      .post(`${BASE}/admin/integrations/roster-sync`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);
    expect(run.body.rosterSync.status).toBe('FAILED');

    await request(app)
      .post(`${BASE}/admin/integrations/roster-sync`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({})
      .expect(403);
  });

  dbIt('sends nothing for a disabled subscription', async () => {
    const created = await request(app)
      .post(`${BASE}/admin/webhooks`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        description: 'Toggled off',
        url: 'https://hooks.example.test/toggled',
        events: [OUTBOX_EVENT.INCIDENT_RESOLVED],
      })
      .expect(201);
    const id = (created.body as SubscriptionBody).subscription.id;

    await request(app)
      .patch(`${BASE}/admin/webhooks/${id}`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ enabled: false })
      .expect(200);

    const event = await writeOutboxEvent({
      organizationId,
      eventType: OUTBOX_EVENT.INCIDENT_RESOLVED,
      payload: { incidentId: '44444444-4444-4444-4444-444444444444' },
      idempotencyKey: `test-webhook-disabled-${Date.now()}`,
    });
    await fanoutWebhooks();

    // A disabled subscription receives no new fan-out.
    const count = await prisma.webhookDelivery.count({ where: { eventId: event.id } });
    expect(count).toBe(0);
  });
});
