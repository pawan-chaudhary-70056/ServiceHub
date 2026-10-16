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
import { getClock, overrideClock } from '../src/services';
import { NotFoundError } from '../src/utils/errors';

/**
 * SLA clock read, projection and override — integration tests (`docs/37` §3, `docs/25`
 * §11/§12/§14).
 *
 * Three claims are under test, and each has been a real gap:
 *
 *   1. **The clock is readable through the API.** The clock was written, swept and paused
 *      for a long time without ever being projected into a response, so no surface could
 *      show SLA state — `docs/22` §14 AC5 asks for it *in the list*.
 *   2. **The override exists and is safe.** `docs/25` §11 requires `POST
 *      /sla/clocks/{id}/override` with a reason, and §14 AC8 requires every override —
 *      including breach clearing — in the audit trail.
 *   3. **Both are scoped to the record.** A clock inherits its record's visibility, so
 *      neither endpoint may become a way to read or move another team's SLA (`docs/07` §1,
 *      `docs/17`).
 *
 * Runs against a real database: the behaviour under test is the interaction of frozen
 * target instants, the tenant predicate and the audit transaction.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@sla-clock.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-clock.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const REQUESTER_EMAIL = 'requester@initech-clock.test';
const REQUESTER_PASSWORD = 'V7kLm2-Qz9p!x';
const OTHER_REQUESTER_EMAIL = 'other@initech-clock.test';
const OTHER_REQUESTER_PASSWORD = 'P3dFg7-Tw1q!z';
const AGENT_EMAIL = 'agent@initech-clock.test';
const AGENT_PASSWORD = 'H4qWn8-Zr2s!m';

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

interface Actor {
  cookie: string;
  csrf: string;
  userId: string;
}

describe('SLA clock read and override', () => {
  let operator: { cookie: string; csrf: string };
  let admin: Actor;
  let requester: Actor;
  let otherRequester: Actor;
  let agent: Actor;
  let organizationId = '';
  let itemId = '';
  let clockId = '';

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
  ): Promise<Actor> {
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

  dbIt('sets up a tenant, an item and the roles the clock endpoints need', async () => {
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
    const adminSession = sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD));
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    admin = { ...adminSession, userId: adminUser.id };

    requester = await onboard(REQUESTER_EMAIL, REQUESTER_PASSWORD, 'REQUESTER', 'Requester One');
    otherRequester = await onboard(
      OTHER_REQUESTER_EMAIL,
      OTHER_REQUESTER_PASSWORD,
      'REQUESTER',
      'Requester Two',
    );
    agent = await onboard(AGENT_EMAIL, AGENT_PASSWORD, 'AGENT', 'Initech Agent');
    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
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
      .send({ name: 'Hardware' });
    const item = await request(app)
      .post(`${BASE}/catalog/items`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'Laptop',
        defaultPriority: 'HIGH',
        defaultSlaPolicyId: policyId,
        fulfilmentTeamId: team.id,
        requiresApproval: false,
        fields: [],
      });
    itemId = item.body.item.id;
    await request(app)
      .post(`${BASE}/catalog/items/${itemId}/activate`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
  });

  async function raise(actor: Actor, title: string): Promise<{ id: string; sla: unknown }> {
    const response = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', actor.cookie)
      .set('x-csrf-token', actor.csrf)
      .send({ catalogItemId: itemId, title, fields: {} })
      .expect(201);
    return { id: response.body.request.id, sla: response.body.request.sla };
  }

  dbIt(
    'carries the live clock on creation, so a new request already has an SLA state',
    async () => {
      const created = await raise(requester, 'Clock on creation');
      const sla = created.sla as { id: string; state: string; remainingSeconds: number } | null;

      expect(sla).not.toBeNull();
      expect(sla?.state).toBe('ON_TRACK');
      // A fresh HIGH clock targets 480 working minutes out, so the countdown is positive.
      expect(sla?.remainingSeconds).toBeGreaterThan(0);

      clockId = sla?.id ?? '';
      expect(clockId).not.toBe('');
    },
  );

  dbIt('shows SLA state and time remaining in the list, without opening the record', async () => {
    // `docs/22` §14 AC5 — the point of the projection. Before it, the only SLA information
    // a list could show was the policy's name, which says nothing about urgency.
    const list = await request(app).get(`${BASE}/requests`).set('cookie', requester.cookie);
    expect(list.status).toBe(200);

    const row = (
      list.body.items as Array<{
        id: string;
        sla: { state: string; targetAt: string; remainingSeconds: number } | null;
      }>
    ).find((item) => item.id !== undefined);
    expect(row?.sla).not.toBeNull();
    expect(row?.sla?.state).toBe('ON_TRACK');
    expect(row?.sla?.remainingSeconds).toBeGreaterThan(0);
    expect(new Date(row?.sla?.targetAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  dbIt(
    'returns the clock by id to a caller who can see the record, and hides it otherwise',
    async () => {
      const mine = await request(app)
        .get(`${BASE}/sla/clocks/${clockId}`)
        .set('cookie', requester.cookie);
      expect(mine.status).toBe(200);
      expect(mine.body.clock.state).toBe('ON_TRACK');
      expect(mine.body.clock.id).toBe(clockId);

      // An administrator with `sla:policy:manage` still needs the record's read scope; the
      // admin holds `request:read.any`, so this succeeds — proving the route is not
      // administrator-only while still being scoped.
      const byAdmin = await request(app)
        .get(`${BASE}/sla/clocks/${clockId}`)
        .set('cookie', admin.cookie);
      expect(byAdmin.status).toBe(200);

      // Another requester cannot see the record, so the clock is NOT_FOUND — never FORBIDDEN,
      // which would confirm the record exists (`docs/17`).
      const stranger = await request(app)
        .get(`${BASE}/sla/clocks/${clockId}`)
        .set('cookie', otherRequester.cookie);
      expect(stranger.status).toBe(404);

      const unknown = await request(app)
        .get(`${BASE}/sla/clocks/01920000-0000-7000-8000-000000000000`)
        .set('cookie', requester.cookie);
      expect(unknown.status).toBe(404);
    },
  );

  dbIt('refuses an override without the permission and without a usable reason', async () => {
    // The route guard rejects a caller without `sla:clock:override` (docs/07 §6).
    const asAgent = await request(app)
      .post(`${BASE}/sla/clocks/${clockId}/override`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ reason: 'Agent cannot move an SLA' });
    expect(asAgent.status).toBe(403);

    // A reason is mandatory (`docs/25` §11) — an unexplained change to a deadline is the
    // thing the audit trail exists to prevent.
    const noReason = await request(app)
      .post(`${BASE}/sla/clocks/${clockId}/override`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ targetAt: new Date(Date.now() + 60_000).toISOString() });
    expect(noReason.status).toBe(422);
    expect(
      (noReason.body.errors as Array<{ field: string }>).some((e) => e.field.startsWith('reason')),
    ).toBe(true);

    // An override that asks for no change at all is rejected rather than recorded as a
    // no-op entry nobody can interpret.
    const noEffect = await request(app)
      .post(`${BASE}/sla/clocks/${clockId}/override`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ reason: 'A reason with no effect requested' });
    expect(noEffect.status).toBe(422);
  });

  dbIt(
    'refuses a clock whose record the caller cannot see, even holding the permission',
    async () => {
      // The route guard is only stage 1 (`docs/07` §1). This principal holds
      // `sla:clock:override` and the *own*-scope read grant, and the clock belongs to someone
      // else — so the service's own scope and object check is what has to refuse, with
      // NOT_FOUND rather than FORBIDDEN (`docs/17`).
      const outsider = {
        userId: otherRequester.userId,
        organizationId,
        isActive: true,
        permissions: new Set(['sla:clock:override', 'request:read.own', 'incident:read.own']),
      };
      const meta = { correlationId: 'test-clock-scope' };

      await expect(getClock(clockId, outsider)).rejects.toThrow(NotFoundError);
      await expect(
        overrideClock(
          clockId,
          { reason: 'Not my record', targetAt: new Date(Date.now() + 60_000).toISOString() },
          outsider,
          meta,
        ),
      ).rejects.toThrow(NotFoundError);

      const before = await prisma.slaClock.findUniqueOrThrow({ where: { id: clockId } });
      expect(before.breachedAt).toBeNull();
    },
  );

  dbIt(
    'moves the target, keeps the warn margin, and audits the override with its reason',
    async () => {
      const before = await prisma.slaClock.findUniqueOrThrow({ where: { id: clockId } });
      const marginMs = before.targetAt.getTime() - before.warnAt.getTime();
      // Three days out, comfortably beyond the warn margin, so ON_TRACK is the only correct
      // derived state; the margin assertion below covers the threshold arithmetic itself.
      const newTarget = new Date(Date.now() + 72 * 60 * 60 * 1000);
      const reason = 'Agreed extension with the customer while the part ships';

      const response = await request(app)
        .post(`${BASE}/sla/clocks/${clockId}/override`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ reason, targetAt: newTarget.toISOString() });

      expect(response.status).toBe(200);
      expect(new Date(response.body.clock.targetAt).toISOString()).toBe(newTarget.toISOString());
      expect(response.body.clock.remainingSeconds).toBeGreaterThan(70_000);
      expect(response.body.clock.state).toBe('ON_TRACK');

      const after = await prisma.slaClock.findUniqueOrThrow({ where: { id: clockId } });
      // The warn threshold keeps its distance from the target: moving the deadline without
      // moving the warning would fire AT_RISK at the wrong moment.
      expect(after.targetAt.getTime() - after.warnAt.getTime()).toBe(marginMs);

      // `docs/25` §14 AC8 — the override is in the audit trail, with the before-state and the
      // reason that justified it.
      const entry = await prisma.auditLog.findFirst({
        where: { action: 'sla.clock.override', entityId: clockId },
        orderBy: { occurredAt: 'desc' },
      });
      expect(entry).not.toBeNull();
      expect(entry?.reason).toBe(reason);
      expect((entry?.before as { targetAt?: string })?.targetAt).toBe(
        before.targetAt.toISOString(),
      );
      expect((entry?.after as { targetAt?: string })?.targetAt).toBe(newTarget.toISOString());
    },
  );

  dbIt(
    'clears a breach as its own audited act, keeping the breach visible in the trail',
    async () => {
      // A breach is recorded at detection (`docs/25` §6); clearing it must not erase that it
      // happened, only its terminal effect on the clock.
      const breachedAt = new Date(Date.now() - 5 * 60 * 1000);
      await prisma.slaClock.update({
        where: { id: clockId },
        data: { state: 'BREACHED', breachedAt },
      });

      const reason = 'False alarm: the resolver had already answered in the ticket thread';
      const response = await request(app)
        .post(`${BASE}/sla/clocks/${clockId}/override`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ reason, clearBreach: true });

      expect(response.status).toBe(200);
      expect(response.body.clock.breachedAt).toBeNull();
      expect(response.body.clock.state).not.toBe('BREACHED');

      const after = await prisma.slaClock.findUniqueOrThrow({ where: { id: clockId } });
      expect(after.breachedAt).toBeNull();
      // A cleared breach leaves the target and its paused total untouched: clearing is not a
      // way to buy time.
      expect(after.targetAt.getTime()).toBeGreaterThan(Date.now());

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'sla.clock.override', entityId: clockId, reason },
      });
      expect((entry?.before as { breachedAt?: string })?.breachedAt).toBe(breachedAt.toISOString());
      expect((entry?.after as { breachedAt?: string | null })?.breachedAt).toBeNull();
    },
  );

  dbIt('drops the clock from a fulfilled record, because a stopped clock is history', async () => {
    const created = await raise(requester, 'Worked to fulfilment');
    const id = created.id;
    expect(created.sla).not.toBeNull();

    await request(app)
      .post(`${BASE}/requests/${id}/assign`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ assigneeId: agent.userId })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${id}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'TRIAGED' })
      .expect(200);
    await request(app)
      .post(`${BASE}/requests/${id}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'IN_PROGRESS' })
      .expect(200);
    const fulfilled = await request(app)
      .post(`${BASE}/requests/${id}/transition`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ to: 'FULFILLED', fulfilmentNote: 'Handed over at the desk' });
    expect(fulfilled.status).toBe(200);

    // The transition response itself carries the change: the clock stopped, so the record
    // has no live SLA to show. A response that still showed a countdown here would be the
    // stale-UI bug the projection exists to prevent.
    expect(fulfilled.body.request.sla).toBeNull();

    const detail = await request(app).get(`${BASE}/requests/${id}`).set('cookie', requester.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.request.sla).toBeNull();

    const stopped = await prisma.slaClock.findFirstOrThrow({ where: { entityId: id } });
    expect(stopped.stoppedAt).not.toBeNull();
  });

  dbIt('serves the same clock shape on the incident projection', async () => {
    const reported = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', requester.cookie)
      .set('x-csrf-token', requester.csrf)
      .send({
        title: 'Printer down on floor 3',
        description: 'No output from the shared printer.',
        impact: 'SIGNIFICANT',
        urgency: 'HIGH',
      });
    expect(reported.status).toBe(201);
    const incidentId = reported.body.incident.id;

    const sla = reported.body.incident.sla as { id: string; state: string } | null;
    expect(sla).not.toBeNull();

    const clock = await request(app)
      .get(`${BASE}/sla/clocks/${sla?.id}`)
      .set('cookie', requester.cookie);
    expect(clock.status).toBe(200);
    expect(clock.body.clock.state).toBe('ON_TRACK');

    // The incident list carries it too, so criticals can be surfaced without opening each
    // record (`docs/23` §11).
    const list = await request(app).get(`${BASE}/incidents`).set('cookie', requester.cookie);
    const row = (list.body.items as Array<{ id: string; sla: unknown }>).find(
      (item) => item.id === incidentId,
    );
    expect(row?.sla).not.toBeNull();
  });

  dbIt('scopes the clock to the tenant that owns it', async () => {
    // A second organization's administrator cannot read this tenant's clock even with
    // `platform` visibility into role data, because the tenant predicate is applied in the
    // service (`ADR-0002`).
    const clock = await prisma.slaClock.findUniqueOrThrow({ where: { id: clockId } });
    const otherOrg = await prisma.organization.create({
      data: {
        name: 'Globex',
        nameKey: 'globex',
        slug: 'globex-clock',
        status: 'ACTIVE',
      },
    });
    await prisma.slaClock.update({
      where: { id: clock.id },
      data: { organizationId: otherOrg.id },
    });

    const response = await request(app)
      .get(`${BASE}/sla/clocks/${clock.id}`)
      .set('cookie', admin.cookie);
    expect(response.status).toBe(404);

    // Restore, so the fixture's own record is left as it was.
    await prisma.slaClock.update({
      where: { id: clock.id },
      data: { organizationId },
    });
  });
});
