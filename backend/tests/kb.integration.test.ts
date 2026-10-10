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
 * Knowledge base — integration tests (docs/27 §12, docs/37 §3).
 *
 * Runs against a real database and the real app, because every property under test is an
 * interaction: the visibility pre-filter applied in **search** as well as on read (K3),
 * the version snapshot that keeps a published article's content fixed across edits (AC2),
 * and the audit trail for publish/archive/visibility (AC6).
 */

const app = createApp();
const BASE = '/api/v1';

const OPERATOR_EMAIL = 'operator@kb.test';
const OPERATOR_PASSWORD = 'Operator-Passphrase!23';
const ADMIN_EMAIL = 'admin@initech-kb.test';
const ADMIN_PASSWORD = 'Secur3-Passphrase!';
const CONTRIBUTOR_EMAIL = 'contributor@initech-kb.test';
const CONTRIBUTOR_PASSWORD = 'V7kLm2-Qz9p!x';
const AGENT_EMAIL = 'agent@initech-kb.test';
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
       article_versions, article_slug_redirects, knowledge_links, articles, article_categories,
       asset_assignments, assets, asset_types,
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

let agent: { cookie: string; csrf: string; userId: string };
let admin: { cookie: string; csrf: string };
let contributor: { cookie: string; csrf: string; userId: string };
let organizationId = '';
let teamId = '';
let incidentId = '';

describe('Knowledge base', () => {
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

  dbIt('sets up a tenant, its roles and a team', async () => {
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
    admin = sessionFrom(await login(ADMIN_EMAIL, ADMIN_PASSWORD));

    contributor = await onboard(
      CONTRIBUTOR_EMAIL,
      CONTRIBUTOR_PASSWORD,
      'KB_CONTRIBUTOR',
      'Initech Contributor',
    );
    agent = await onboard(AGENT_EMAIL, AGENT_PASSWORD, 'AGENT', 'Initech Agent');

    const team = await prisma.team.create({ data: { organizationId, name: 'Service Desk' } });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: agent.userId, organizationId, role: 'MEMBER' },
    });
    teamId = team.id;

    const reported = await request(app)
      .post(`${BASE}/incidents`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({
        title: 'Laptop will not boot',
        description: 'Power light on, no display.',
        impact: 'MINOR',
        urgency: 'MEDIUM',
        teamId,
      })
      .expect(201);
    incidentId = reported.body.incident.id;

    expect(organizationId).not.toBe('');
  });

  async function createDraft(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await request(app)
      .post(`${BASE}/kb/articles`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .send({
        title: 'VPN client setup on Windows',
        summary: 'Install and configure the VPN client.',
        body: 'Open Settings, then VPN, then add the corporate profile.',
        visibility: 'PUBLIC',
        ...overrides,
      });
    expect(response.status).toBe(201);
    return response.body.article.id as string;
  }

  dbIt('K2: a body carrying raw HTML is rejected, so stored content cannot be XSS', async () => {
    const response = await request(app)
      .post(`${BASE}/kb/articles`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .send({
        title: 'Dangerous article',
        body: 'Hello <script>alert(1)</script>',
        visibility: 'PUBLIC',
      });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
  });

  dbIt(
    'K1 + AC2: publishing needs a distinct reviewer and freezes the published version',
    async () => {
      const articleId = await createDraft();

      // The author may not publish their own article (K1).
      await request(app)
        .post(`${BASE}/kb/articles/${articleId}/submit`)
        .set('cookie', contributor.cookie)
        .set('x-csrf-token', contributor.csrf)
        .expect(200);
      const selfPublish = await request(app)
        .post(`${BASE}/kb/articles/${articleId}/publish`)
        .set('cookie', contributor.cookie)
        .set('x-csrf-token', contributor.csrf);
      expect(selfPublish.status).toBe(409);

      const published = await request(app)
        .post(`${BASE}/kb/articles/${articleId}/publish`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .expect(200);
      expect(published.body.article.status).toBe('PUBLISHED');
      expect(published.body.article.version).toBe(1);

      const versionOne = await prisma.articleVersion.findFirstOrThrow({
        where: { articleId, version: 1 },
      });
      expect(versionOne.body).toContain('Open Settings');

      // The author edits the published article: the working copy changes...
      await request(app)
        .patch(`${BASE}/kb/articles/${articleId}`)
        .set('cookie', contributor.cookie)
        .set('x-csrf-token', contributor.csrf)
        .send({ body: 'Updated instructions that have not been reviewed.' })
        .expect(200);

      // ...but a reader still sees the published snapshot (AC2).
      const readerView = await request(app)
        .get(`${BASE}/kb/articles/${articleId}`)
        .set('cookie', agent.cookie)
        .expect(200);
      expect(readerView.body.article.body).toContain('Open Settings');
      expect(readerView.body.article.body).not.toContain('Updated instructions');
      expect(readerView.body.article.servingPublishedVersion).toBe(true);

      // The author sees their draft and the pending-changes marker (§11).
      const authorView = await request(app)
        .get(`${BASE}/kb/articles/${articleId}`)
        .set('cookie', contributor.cookie)
        .expect(200);
      expect(authorView.body.article.body).toContain('Updated instructions');
      expect(authorView.body.article.hasUnpublishedChanges).toBe(true);

      // Republishing advances the immutable snapshot and makes the change visible.
      const republished = await request(app)
        .post(`${BASE}/kb/articles/${articleId}/publish`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .expect(200);
      expect(republished.body.article.version).toBe(2);
      const versionTwo = await prisma.articleVersion.findFirstOrThrow({
        where: { articleId, version: 2 },
      });
      expect(versionTwo.body).toContain('Updated instructions');
      // Version 1 is immutable history.
      expect(
        (await prisma.articleVersion.findFirstOrThrow({ where: { articleId, version: 1 } })).body,
      ).toContain('Open Settings');

      const readerAgain = await request(app)
        .get(`${BASE}/kb/articles/${articleId}`)
        .set('cookie', agent.cookie)
        .expect(200);
      expect(readerAgain.body.article.body).toContain('Updated instructions');
    },
  );

  dbIt('K3 (read layer): a RESTRICTED article is 404 for a plain reader', async () => {
    const articleId = await createDraft({ title: 'Restricted runbook', visibility: 'RESTRICTED' });
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/submit`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/publish`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    // The reader may not see it, and is told it does not exist — not that it is forbidden.
    const hidden = await request(app)
      .get(`${BASE}/kb/articles/${articleId}`)
      .set('cookie', agent.cookie);
    expect(hidden.status).toBe(404);

    // The publisher may.
    const visible = await request(app)
      .get(`${BASE}/kb/articles/${articleId}`)
      .set('cookie', admin.cookie);
    expect(visible.status).toBe(200);
  });

  dbIt('AC1 (search layer): visibility filters search results before ranking', async () => {
    const publicId = await createDraft({
      title: 'Umbrella VPN onboarding note',
      body: 'How to onboard onto the umbrella VPN.',
      visibility: 'PUBLIC',
    });
    await request(app)
      .post(`${BASE}/kb/articles/${publicId}/submit`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${publicId}/publish`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    const restrictedId = await createDraft({
      title: 'Umbrella VPN break-glass credentials',
      body: 'Secret umbrella VPN procedure.',
      visibility: 'RESTRICTED',
    });
    await request(app)
      .post(`${BASE}/kb/articles/${restrictedId}/submit`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${restrictedId}/publish`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    const readerSearch = await request(app)
      .get(`${BASE}/search?q=umbrella`)
      .set('cookie', agent.cookie)
      .expect(200);
    const readerIds = (readerSearch.body.items as Array<{ entityType: string; id: string }>)
      .filter((item) => item.entityType === 'ARTICLE')
      .map((item) => item.id);
    expect(readerIds).toContain(publicId);
    expect(readerIds).not.toContain(restrictedId);

    // The publisher sees both.
    const adminSearch = await request(app)
      .get(`${BASE}/search?q=umbrella`)
      .set('cookie', admin.cookie)
      .expect(200);
    const adminIds = (adminSearch.body.items as Array<{ entityType: string; id: string }>)
      .filter((item) => item.entityType === 'ARTICLE')
      .map((item) => item.id);
    expect(adminIds).toContain(restrictedId);
  });

  dbIt(
    'AC4: archiving removes the article from search but a direct link still resolves',
    async () => {
      const articleId = await createDraft({
        title: 'Zebra printer maintenance',
        body: 'Clean the print head monthly.',
        visibility: 'PUBLIC',
      });
      await request(app)
        .post(`${BASE}/kb/articles/${articleId}/submit`)
        .set('cookie', contributor.cookie)
        .set('x-csrf-token', contributor.csrf)
        .expect(200);
      await request(app)
        .post(`${BASE}/kb/articles/${articleId}/publish`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .expect(200);

      const before = await request(app)
        .get(`${BASE}/search?q=zebra`)
        .set('cookie', agent.cookie)
        .expect(200);
      expect((before.body.items as Array<{ id: string }>).some((i) => i.id === articleId)).toBe(
        true,
      );

      await request(app)
        .post(`${BASE}/kb/articles/${articleId}/archive`)
        .set('cookie', admin.cookie)
        .set('x-csrf-token', admin.csrf)
        .send({ reason: 'Superseded by the vendor guide' })
        .expect(200);

      // Excluded from search (AC4)...
      const after = await request(app)
        .get(`${BASE}/search?q=zebra`)
        .set('cookie', agent.cookie)
        .expect(200);
      expect((after.body.items as Array<{ id: string }>).some((i) => i.id === articleId)).toBe(
        false,
      );

      // ...but the direct link resolves, with the archived banner.
      const direct = await request(app)
        .get(`${BASE}/kb/articles/${articleId}`)
        .set('cookie', agent.cookie)
        .expect(200);
      expect(direct.body.article.archived).toBe(true);
      expect(direct.body.article.body).toContain('print head');
    },
  );

  dbIt('AC5: a slug change records a redirect so the old link still resolves', async () => {
    const articleId = await createDraft({
      title: 'Slug rename subject',
      body: 'Body of the renamed article.',
      visibility: 'PUBLIC',
    });
    const before = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
    const oldSlug = before.slug;

    await request(app)
      .patch(`${BASE}/kb/articles/${articleId}`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .send({ slug: 'a-brand-new-slug' })
      .expect(200);

    const redirect = await prisma.articleSlugRedirect.findUniqueOrThrow({
      where: { organizationId_fromSlug: { organizationId, fromSlug: oldSlug } },
    });
    expect(redirect.articleId).toBe(articleId);

    // The retired slug still resolves to the article rather than 404ing.
    const viaOldSlug = await request(app)
      .get(`${BASE}/kb/articles/${oldSlug}`)
      .set('cookie', contributor.cookie)
      .expect(200);
    expect(viaOldSlug.body.article.id).toBe(articleId);
  });

  dbIt('AC3: a record link resolves to the version linked at the time', async () => {
    const articleId = await createDraft({
      title: 'Laptop boot troubleshooting',
      body: 'Step one: hold the power button for ten seconds.',
      visibility: 'PUBLIC',
    });
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/submit`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/publish`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    // The agent resolving the incident links the article they actually read.
    const linked = await request(app)
      .post(`${BASE}/incidents/${incidentId}/knowledge-links`)
      .set('cookie', agent.cookie)
      .set('x-csrf-token', agent.csrf)
      .send({ articleId })
      .expect(201);
    expect(linked.body.link.articleVersion).toBe(1);

    // The article is then republished with different content.
    await request(app)
      .patch(`${BASE}/kb/articles/${articleId}`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .send({ body: 'Revised procedure that nobody has read yet.' })
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/publish`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);

    // The incident's history still shows what was applied at the time.
    const links = await request(app)
      .get(`${BASE}/incidents/${incidentId}/knowledge-links`)
      .set('cookie', agent.cookie)
      .expect(200);
    const link = (links.body.items as Array<{ articleId: string; linkedBody: string }>)[0];
    expect(link?.articleId).toBe(articleId);
    expect(link?.linkedBody).toContain('hold the power button');
    expect(link?.linkedBody).not.toContain('Revised procedure');
  });

  dbIt('AC6: publish, visibility change and archive are all audited', async () => {
    const articleId = await createDraft({
      title: 'Audited article',
      body: 'Content for the audit trail.',
      visibility: 'PUBLIC',
    });
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/submit`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/publish`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
    await request(app)
      .patch(`${BASE}/kb/articles/${articleId}`)
      .set('cookie', contributor.cookie)
      .set('x-csrf-token', contributor.csrf)
      .send({ visibility: 'INTERNAL' })
      .expect(200);
    await request(app)
      .post(`${BASE}/kb/articles/${articleId}/archive`)
      .set('cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({})
      .expect(200);

    const entries = await prisma.auditLog.findMany({ where: { entityId: articleId } });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain('kb.article.create');
    expect(actions).toContain('kb.article.publish');
    expect(actions).toContain('kb.article.update');
    expect(actions).toContain('kb.article.archive');

    // The visibility change is recorded before/after, so it is reconstructable.
    const visibilityChange = entries.find(
      (entry) =>
        entry.action === 'kb.article.update' &&
        (entry.after as { visibility?: string } | null)?.visibility === 'INTERNAL',
    );
    expect(visibilityChange).toBeDefined();
    expect((visibilityChange?.before as { visibility?: string } | null)?.visibility).toBe('PUBLIC');
  });
});
