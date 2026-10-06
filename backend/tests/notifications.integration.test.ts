import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { PERMISSIONS, PLATFORM_ROLES } from '../src/helpers/permission-catalogue';
import { hashPassword } from '../src/helpers/crypto';
import { parseCookies } from '../src/helpers/cookies';
import type { DeliveryResult, EmailAdapter, EmailMessage } from '../src/integrations';
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
 * Notifications outbox drain — integration tests (docs/37 §3, docs/29 §3/§4/§10).
 *
 * The behaviour under test is the reliability boundary: an event written in the mutation's
 * transaction is delivered exactly once, retried on failure, dead-lettered at the cap, and
 * never delivered twice. Runs against a real database because that is where idempotency
 * (the unique dedupe key) and the drain ordering actually live.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@notify.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-notify.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';

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

function capturingAdapter(): { adapter: EmailAdapter; messages: EmailMessage[] } {
  const messages: EmailMessage[] = [];
  return {
    messages,
    adapter: {
      async send(message: EmailMessage): Promise<DeliveryResult> {
        messages.push(message);
        return { accepted: true, providerMessageId: `fake:${messages.length}` };
      },
    },
  };
}

describe('Notification outbox drain', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
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

  dbIt('provisions a tenant, queuing the administrator invitation', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Notify',
        administratorEmail: ADMIN_EMAIL,
        administratorName: 'Initech Admin',
        defaultTimeZone: 'Europe/London',
      });
    organizationId = provisioned.body.organization.id;

    // The invitation is queued, not sent (docs/29 §3).
    const queued = await prisma.outbox.findMany({
      where: { eventType: 'notification.invitation.created' },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.processedAt ?? null).toBeNull();

    await request(app)
      .post(`${BASE}/auth/accept-invitation`)
      .send({ token: provisioned.body.invitation.token, password: ADMIN_PASSWORD })
      .expect(204);
    // The invitation establishes the first credential (docs/06 §11); the login proves it.
    admin = sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD).expect(200));
  });

  dbIt('delivers the invitation email exactly once and records the send', async () => {
    const { adapter, messages } = capturingAdapter();

    const first = await drainOutbox({ adapter, batchSize: 200 });
    expect(first.delivered).toBeGreaterThanOrEqual(1);

    const invitation = messages.find((message) => message.to === ADMIN_EMAIL);
    expect(invitation).toBeDefined();
    expect(invitation?.subject).toBe('You have been invited to ServiceHub');
    expect(invitation?.text).toContain('accept-invitation?token=');

    const notification = await prisma.notification.findFirst({
      where: { recipient: ADMIN_EMAIL, eventType: 'notification.invitation.created' },
    });
    expect(notification?.status).toBe('SENT');
    expect(notification?.templateVersion).toBe('v1');
    expect(notification?.sentAt).not.toBeNull();
    expect(notification?.providerMessageId).toBeDefined();

    // Redelivery must not produce a visible duplicate (docs/29 N4).
    const sentBefore = messages.filter((message) => message.to === ADMIN_EMAIL).length;
    await drainOutbox({ adapter, batchSize: 200 });
    const sentAfter = messages.filter((message) => message.to === ADMIN_EMAIL).length;
    expect(sentAfter).toBe(sentBefore);

    const stillOne = await prisma.notification.count({
      where: { recipient: ADMIN_EMAIL, eventType: 'notification.invitation.created' },
    });
    expect(stillOne).toBe(1);
  });

  dbIt('renders and delivers a password-reset email through the real flow', async () => {
    await request(app).post(`${BASE}/auth/forgot`).send({ email: ADMIN_EMAIL }).expect(202);

    const { adapter, messages } = capturingAdapter();
    await drainOutbox({ adapter, batchSize: 200 });

    const reset = messages.find(
      (message) =>
        message.to === ADMIN_EMAIL && message.subject === 'Reset your ServiceHub password',
    );
    expect(reset).toBeDefined();
    expect(reset?.text).toContain('reset-password?token=');

    const notification = await prisma.notification.findFirst({
      where: { recipient: ADMIN_EMAIL, eventType: 'notification.password.reset' },
    });
    expect(notification?.status).toBe('SENT');
  });

  dbIt(
    'retries a failed send and dead-letters after the attempt cap without throwing',
    async () => {
      const email = 'flaky@initech-notify.test';
      await prisma.outbox.create({
        data: {
          organizationId,
          eventType: 'notification.invitation.created',
          idempotencyKey: `test-flaky:${email}`,
          payload: { email, acceptUrl: 'https://example.test/accept-invitation?token=x' },
        },
      });

      const rejecting: EmailAdapter = {
        async send(): Promise<DeliveryResult> {
          return { accepted: false, failureReason: 'Provider unavailable.' };
        },
      };

      // Five drains, each past the bounded backoff, exhaust NOTIFICATION_MAX_ATTEMPTS (5).
      const occurredAt = (
        await prisma.outbox.findUniqueOrThrow({ where: { idempotencyKey: `test-flaky:${email}` } })
      ).occurredAt;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await drainOutbox({
          adapter: rejecting,
          now: new Date(occurredAt.getTime() + attempt * 2 * 60 * 60_000),
          batchSize: 200,
        });
      }

      const notification = await prisma.notification.findFirst({
        where: { recipient: email, eventType: 'notification.invitation.created' },
      });
      expect(notification?.status).toBe('DEAD');
      expect(notification?.attempts).toBeGreaterThanOrEqual(5);

      // Dead-lettering releases the outbox row so it cannot block the queue.
      const row = await prisma.outbox.findUniqueOrThrow({
        where: { idempotencyKey: `test-flaky:${email}` },
      });
      expect(row.processedAt).not.toBeNull();
    },
  );

  dbIt('skips an event with no template without blocking the queue', async () => {
    await prisma.outbox.create({
      data: {
        organizationId,
        eventType: 'notification.some.future.event',
        idempotencyKey: 'test-unknown-event',
        payload: { anything: true },
      },
    });

    const { adapter, messages } = capturingAdapter();
    await drainOutbox({ adapter, batchSize: 200 });

    expect(messages.some((message) => message.subject.includes('future'))).toBe(false);
    const row = await prisma.outbox.findUniqueOrThrow({
      where: { idempotencyKey: 'test-unknown-event' },
    });
    expect(row.processedAt).not.toBeNull();
    const notification = await prisma.notification.findFirst({
      where: { eventType: 'notification.some.future.event' },
    });
    expect(notification).toBeNull();
  });

  dbIt('delivers an in-app notification and lets its owner read it (docs/29 §12)', async () => {
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    await prisma.outbox.create({
      data: {
        organizationId,
        eventType: 'notification.request.assigned',
        idempotencyKey: 'test-inapp-assigned',
        payload: { requestId: 'req-inapp-1', assigneeId: adminUser.id },
      },
    });

    const { adapter } = capturingAdapter();
    const drained = await drainOutbox({ adapter, batchSize: 200 });
    expect(drained.inApp).toBeGreaterThanOrEqual(1);

    const list = await request(app).get(`${BASE}/notifications`).set('cookie', admin.cookie);
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{
      id: string;
      title: string;
      linkUrl: string;
      readAt: string | null;
    }>;
    const assigned = items.find((entry) => entry.title === 'A request was assigned to you');
    expect(assigned).toBeDefined();
    expect(assigned?.linkUrl).toBe('/requests/req-inapp-1');
    expect(assigned?.readAt).toBeNull();
    expect(list.body.unreadCount).toBeGreaterThanOrEqual(1);

    // Another user cannot read it: a notification is self-scoped.
    const foreign = await request(app)
      .post(`${BASE}/notifications/${assigned?.id}/read`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf);
    expect(foreign.status).toBe(404);

    const read = await request(app)
      .post(`${BASE}/notifications/${assigned?.id}/read`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf);
    expect(read.status).toBe(200);
    expect(read.body.notification.readAt).not.toBeNull();
  });

  dbIt('exposes the preference matrix and refuses to silence a transactional event', async () => {
    const list = await request(app)
      .get(`${BASE}/me/notification-preferences`)
      .set('cookie', admin.cookie);
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{
      eventType: string;
      channel: string;
      enabled: boolean;
      mandatory: boolean;
    }>;

    // A password reset is transactional and mandatory on every channel (`29` N6).
    const reset = items.filter((entry) => entry.eventType === 'notification.password.reset');
    expect(reset).toHaveLength(3);
    expect(reset.every((entry) => entry.mandatory && entry.enabled)).toBe(true);

    const refused = await request(app)
      .put(`${BASE}/me/notification-preferences`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        preferences: [
          { eventType: 'notification.password.reset', channel: 'EMAIL', enabled: false },
        ],
      });
    expect(refused.status).toBe(422);
  });

  dbIt('suppresses an operational event the recipient opted out of (docs/29 §7)', async () => {
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });

    const applied = await request(app)
      .put(`${BASE}/me/notification-preferences`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        preferences: [
          { eventType: 'notification.request.assigned', channel: 'IN_APP', enabled: false },
        ],
      });
    expect(applied.status).toBe(200);

    await prisma.outbox.create({
      data: {
        organizationId,
        eventType: 'notification.request.assigned',
        idempotencyKey: 'test-inapp-suppressed',
        payload: { requestId: 'req-inapp-2', assigneeId: adminUser.id },
      },
    });

    const { adapter } = capturingAdapter();
    await drainOutbox({ adapter, batchSize: 200 });

    // No delivered in-app row for the suppressed event; the skip is recorded instead.
    const delivered = await prisma.notification.findFirst({
      where: { eventType: 'notification.request.assigned', linkUrl: '/requests/req-inapp-2' },
    });
    expect(delivered?.status).toBe('SKIPPED');
  });
});
