import type { ArticleStatus, ArticleVisibility } from '@prisma/client';
import { assertPermission, hasPermission, type Principal } from '../helpers/authorization';
import { ConflictError, DuplicateError, NotFoundError } from '../utils/errors';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  countArticlesByCategoryId,
  countArticlesByStatus,
  countStaleArticles,
  createArticle,
  createArticleCategory,
  createArticleSlugRedirect,
  createArticleVersion,
  createKnowledgeLink,
  findArticleById,
  findArticleBySlug,
  findArticleCategoryById,
  findArticleSlugRedirect,
  findArticleVersion,
  findKnowledgeLink,
  incrementArticleCounter,
  listArticleCategories,
  listArticles,
  listKnowledgeLinksForEntity,
  publishedSnapshot,
  runInTransaction,
  updateArticle,
  updateArticleCategory,
  writeAudit,
  type ArticleLinkRow,
  type ArticleVisibilityScope,
  type ArticleWithCategory,
} from '../models';
import { assertIncidentVisible } from './incident.service';
import { assertRequestVisible } from './request.service';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Resolves a record through the owning service's own object-level check, so a knowledge
 * link can never be a back door to a record the caller may not see (`docs/07` §1).
 */
async function assertRecordVisible(
  entityType: 'REQUEST' | 'INCIDENT',
  entityId: string,
  actor: Principal,
): Promise<string> {
  return entityType === 'REQUEST'
    ? (await assertRequestVisible(entityId, actor)).organizationId
    : (await assertIncidentVisible(entityId, actor)).organizationId;
}

/**
 * Knowledge base — docs/27, F-15.
 *
 * The KB is the deflection mechanism, and this service is where its two hard rules live:
 *
 *   - **K3** — visibility is enforced server-side on **read and search**, as a SQL
 *     predicate applied before ranking (`models/kb.model.ts#articleVisibilityWhere`).
 *     A hidden article that leaks through search is the classic KB defect, so the same
 *     predicate serves both paths.
 *   - **Publishing creates an immutable version** (§4). Editing a published article
 *     produces a draft; the published snapshot is untouched until republish, so a link
 *     from a resolved incident resolves to what the resolver actually read (rule K6).
 *
 * Deletion does not exist here (rule K7): an article leaves circulation by being
 * archived, and its inbound links keep resolving.
 */

/** Authoring edits are rejected when the body carries raw HTML (rule K2, docs/17). */
const HTML_TAG = /<\/?[a-z][\s\S]*?>/i;
const DEFAULT_REVIEW_MONTHS = 12;

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new NotFoundError('Knowledge articles are tenant-scoped.');
  }
  return actor.organizationId;
}

/** The widest visibility class the caller may read (`docs/27` §7). */
export function resolveArticleScope(actor: Principal): ArticleVisibilityScope {
  if (hasPermission(actor, 'kb:article:publish')) return 'ALL';
  if (hasPermission(actor, 'kb:article:author')) return 'INTERNAL';
  return 'PUBLIC_ONLY';
}

/** Whether the caller may see unpublished work (a draft or an in-review article). */
function canAuthor(actor: Principal): boolean {
  return hasPermission(actor, 'kb:article:author') || hasPermission(actor, 'kb:article:publish');
}

function assertNoRawHtml(body: string): void {
  if (HTML_TAG.test(body)) {
    throw new ConflictError('Article bodies are Markdown; raw HTML is rejected (docs/27 K2).');
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 80);
}

function reviewDueFrom(now: Date, months = DEFAULT_REVIEW_MONTHS): Date {
  const due = new Date(now);
  due.setUTCMonth(due.getUTCMonth() + months);
  return due;
}

/** A stored article plus the flags a reader needs (`docs/27` §8, §11). */
export interface ArticleView {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  body: string;
  status: ArticleStatus;
  visibility: ArticleVisibility;
  version: number;
  category: { id: string; name: string } | null;
  authorId: string;
  reviewerId: string | null;
  publishedAt: Date | null;
  reviewedAt: Date | null;
  reviewDueAt: Date | null;
  archivedAt: Date | null;
  /** True when the article is archived — links still resolve, with a banner (§11). */
  archived: boolean;
  /**
   * A publish happened and the working copy has changed since (docs/27 §11). Readers are
   * shown the *published snapshot*; authors are shown the draft with this marker.
   */
  hasUnpublishedChanges: boolean;
  /** True when the caller is seeing the published snapshot rather than the working copy. */
  servingPublishedVersion: boolean;
  updatedAt: Date;
  createdAt: Date;
}

export interface ArticleListItem {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  status: ArticleStatus;
  visibility: ArticleVisibility;
  version: number;
  category: { id: string; name: string } | null;
  reviewDueAt: Date | null;
  updatedAt: Date;
}

function toListRow(article: ArticleWithCategory, readerFacing: boolean): ArticleListItem {
  const snapshot = readerFacing ? publishedSnapshot(article) : null;
  return {
    id: article.id,
    title: snapshot?.title ?? article.title,
    slug: article.slug,
    summary: snapshot ? snapshot.summary : article.summary,
    status: article.status,
    visibility: snapshot?.visibility ?? article.visibility,
    version: article.version,
    category: article.category ? { id: article.category.id, name: article.category.name } : null,
    reviewDueAt: article.reviewDueAt,
    updatedAt: article.updatedAt,
  };
}

/**
 * Shapes an article for a caller.
 *
 * `readerFacing` serves the **published snapshot** rather than the working copy: editing a
 * published article must not change what readers see until republish (`docs/27` §12 AC2).
 * An author sees the working copy, with `hasUnpublishedChanges` as the marker (§11).
 */
function toView(article: ArticleWithCategory, readerFacing: boolean): ArticleView {
  const snapshot = readerFacing ? publishedSnapshot(article) : null;
  return {
    id: article.id,
    title: snapshot?.title ?? article.title,
    slug: article.slug,
    summary: snapshot ? snapshot.summary : article.summary,
    body: snapshot?.body ?? article.body,
    status: article.status,
    visibility: snapshot?.visibility ?? article.visibility,
    version: article.version,
    category: article.category ? { id: article.category.id, name: article.category.name } : null,
    authorId: article.authorId,
    reviewerId: article.reviewerId,
    publishedAt: article.publishedAt,
    reviewedAt: article.reviewedAt,
    reviewDueAt: article.reviewDueAt,
    archivedAt: article.archivedAt,
    archived: article.status === 'ARCHIVED',
    hasUnpublishedChanges: article.draftChangedAt !== null,
    servingPublishedVersion: snapshot !== null,
    updatedAt: article.updatedAt,
    createdAt: article.createdAt,
  };
}

/**
 * The object-level read rule (docs/07 stage 3, docs/27 K3).
 *
 * A caller who may not read this article receives `NOT_FOUND`, never `FORBIDDEN` — the
 * API must not disclose that a restricted article exists (`docs/17`).
 */
function assertArticleReadable(article: ArticleWithCategory, actor: Principal): void {
  const scope = resolveArticleScope(actor);
  if (scope === 'ALL') return;

  const unpublished = article.status !== 'PUBLISHED' && article.status !== 'ARCHIVED';
  if (unpublished && !canAuthor(actor)) {
    // Archived is readable, but only within the visibility class.
    throw new NotFoundError('Article not found.');
  }

  if (article.visibility === 'PUBLIC') return;
  if (article.visibility === 'INTERNAL' && scope === 'INTERNAL') return;
  if (
    article.visibility === 'RESTRICTED' &&
    (article.authorId === actor.userId || article.reviewerId === actor.userId)
  ) {
    return;
  }
  throw new NotFoundError('Article not found.');
}

// ===========================================================================
// Reading
// ===========================================================================

export interface ListArticlesInput {
  status?: ArticleStatus;
  categoryId?: string;
  limit: number;
  cursor?: string;
}

export async function listArticlesPage(
  input: ListArticlesInput,
  actor: Principal,
): Promise<CursorPage<ArticleListItem>> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:read');

  const scope = resolveArticleScope(actor);
  const rows = await listArticles({
    organizationId,
    scope,
    userId: actor.userId,
    includeUnpublished: canAuthor(actor),
    status: input.status,
    categoryId: input.categoryId,
    limit: input.limit,
    cursor: input.cursor,
  });

  const readerFacing = !canAuthor(actor);
  const page = buildCursorPage(rows, input.limit, (row) => row.updatedAt);
  return { ...page, items: page.items.map((row) => toListRow(row, readerFacing)) };
}

/** Resolves an id **or** a slug; a retired slug redirects to its article (AC5). */
export async function getArticle(identifier: string, actor: Principal): Promise<ArticleView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:read');

  let article = await findArticleById(identifier);
  if (!article) {
    const redirect = await findArticleSlugRedirect(organizationId, identifier);
    article = redirect
      ? await findArticleById(redirect.articleId)
      : await findArticleBySlug(organizationId, identifier);
  }
  if (!article || article.organizationId !== organizationId) {
    throw new NotFoundError('Article not found.');
  }
  assertArticleReadable(article, actor);

  // A read is not itself a mutation for the audit log, but the view counter is the KB's
  // only usage signal (`docs/27` §6); it is deliberately not audited.
  await incrementArticleCounter(article.id, 'viewCount');
  return toView(article, !canAuthor(actor));
}

export interface RecordHelpfulInput {
  helpful: boolean;
}

/** Records a helpful/not-helpful vote (`docs/27` §9). */
export async function recordArticleFeedback(
  id: string,
  input: RecordHelpfulInput,
  actor: Principal,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  await incrementArticleCounter(article.id, input.helpful ? 'helpfulCount' : 'notHelpfulCount');
  return toView(article, !canAuthor(actor));
}

async function loadReadable(id: string, actor: Principal): Promise<ArticleWithCategory> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:read');
  const article = await findArticleById(id);
  if (!article || article.organizationId !== organizationId) {
    throw new NotFoundError('Article not found.');
  }
  assertArticleReadable(article, actor);
  return article;
}

/**
 * Object-level visibility check for an article, reused by projections that must honour the
 * article's visibility class (`docs/27` rule K3) rather than assume a read permission, e.g.
 * a record's audit history (`docs/31` §5).
 */
export function assertArticleVisible(id: string, actor: Principal): Promise<ArticleWithCategory> {
  return loadReadable(id, actor);
}

/** A stale-review/status summary for the KB admin board (`docs/27` §9). */
export async function getArticleStats(
  actor: Principal,
): Promise<{ byStatus: Array<{ status: ArticleStatus; count: number }>; stale: number }> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:read');
  const [byStatus, stale] = await Promise.all([
    countArticlesByStatus(organizationId),
    countStaleArticles(organizationId, new Date()),
  ]);
  return { byStatus, stale };
}

// ===========================================================================
// Authoring
// ===========================================================================

export interface CreateArticleInput {
  title: string;
  summary?: string | null;
  body: string;
  visibility: ArticleVisibility;
  categoryId?: string | null;
  /** Overrides the derived slug; still unique per tenant. */
  slug?: string;
  /** Opt straight into review instead of leaving the article as a draft. */
  submitForReview?: boolean;
}

export async function createArticleDraft(
  input: CreateArticleInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:author');
  assertNoRawHtml(input.body);

  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  if (slug.length === 0) {
    throw new ConflictError('The title must produce a non-empty slug.');
  }
  const existing = await findArticleBySlug(organizationId, slug);
  if (existing) {
    throw new DuplicateError('An article with that slug already exists.');
  }
  await assertCategory(organizationId, input.categoryId ?? null);

  const now = new Date();
  const created = await runInTransaction(async (tx) => {
    const article = await createArticle(
      {
        organizationId,
        categoryId: input.categoryId ?? null,
        title: input.title,
        slug,
        summary: input.summary ?? null,
        body: input.body,
        visibility: input.visibility,
        authorId: actor.userId,
        reviewDueAt: reviewDueFrom(now),
      },
      tx,
    );
    if (input.submitForReview) {
      await updateArticle(article.id, { status: 'IN_REVIEW' }, tx);
    }
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ARTICLE_CREATE,
        entityType: AUDIT_ENTITY.ARTICLE,
        entityId: article.id,
        after: { title: article.title, slug, visibility: article.visibility },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return article;
  });

  const stored = await findArticleById(created.id);
  if (!stored) throw new NotFoundError('Article not found.');
  return toView(stored, false);
}

export interface UpdateArticleInput {
  title?: string;
  summary?: string | null;
  body?: string;
  visibility?: ArticleVisibility;
  categoryId?: string | null;
  /** A slug change records a redirect so inbound links do not 404 (AC5). */
  slug?: string;
  reviewDueAt?: string | null;
}

/**
 * Edits an article. When the article is **published**, the edit is a draft change: the
 * published snapshot in `ArticleVersion` is untouched until republish (AC2).
 */
export async function updateArticleDraft(
  id: string,
  input: UpdateArticleInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  const organizationId = article.organizationId;
  assertPermission(actor, 'kb:article:author');
  if (article.status === 'ARCHIVED') {
    throw new ConflictError('An archived article cannot be edited; unarchive it first.');
  }
  if (input.body !== undefined) assertNoRawHtml(input.body);

  if (input.categoryId !== undefined) {
    await assertCategory(organizationId, input.categoryId);
  }

  const data: Parameters<typeof updateArticle>[1] = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.summary !== undefined) data.summary = input.summary;
  if (input.body !== undefined) data.body = input.body;
  if (input.visibility !== undefined) data.visibility = input.visibility;
  if (input.categoryId !== undefined) data.categoryId = input.categoryId;
  // The working copy changed. Readers keep seeing the published snapshot until republish
  // (AC2); this marker is how the author is told there are pending changes (§11).
  data.draftChangedAt = new Date();
  if (input.reviewDueAt !== undefined) {
    data.reviewDueAt = input.reviewDueAt ? new Date(input.reviewDueAt) : null;
  }

  const renamedSlug = input.slug !== undefined ? slugify(input.slug) : null;

  await runInTransaction(async (tx) => {
    if (renamedSlug && renamedSlug !== article.slug) {
      const clash = await findArticleBySlug(organizationId, renamedSlug, tx);
      if (clash && clash.id !== article.id) {
        throw new DuplicateError('An article with that slug already exists.');
      }
      const redirectClash = await findArticleSlugRedirect(organizationId, article.slug, tx);
      if (!redirectClash) {
        await createArticleSlugRedirect(
          { organizationId, articleId: article.id, fromSlug: article.slug },
          tx,
        );
      }
      data.slug = renamedSlug;
    }
    await updateArticle(article.id, data, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ARTICLE_UPDATE,
        entityType: AUDIT_ENTITY.ARTICLE,
        entityId: article.id,
        before: {
          title: article.title,
          visibility: article.visibility,
          slug: article.slug,
          status: article.status,
        },
        after: {
          title: data.title ?? article.title,
          visibility: data.visibility ?? article.visibility,
          slug: (data.slug as string | undefined) ?? article.slug,
          status: article.status,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  const stored = await findArticleById(article.id);
  if (!stored) throw new NotFoundError('Article not found.');
  return toView(stored, false);
}

async function assertCategory(organizationId: string, categoryId: string | null): Promise<void> {
  if (categoryId === null) return;
  const category = await findArticleCategoryById(categoryId);
  if (!category || category.organizationId !== organizationId) {
    throw new NotFoundError('Article category not found.');
  }
}

/** Moves a draft into review (`docs/27` §4). */
export async function submitArticleForReview(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  assertPermission(actor, 'kb:article:author');
  if (article.status !== 'DRAFT') {
    throw new ConflictError('Only a draft can be submitted for review.');
  }
  return setStatus(article, 'IN_REVIEW', actor, meta, null);
}

/** Returns an in-review article to its author (`docs/27` §4). */
export async function rejectArticle(
  id: string,
  reason: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  assertPermission(actor, 'kb:article:publish');
  if (article.status !== 'IN_REVIEW') {
    throw new ConflictError('Only an article in review can be rejected.');
  }
  return setStatus(article, 'DRAFT', actor, meta, reason);
}

/**
 * Publishes an article: creates an **immutable version** and advances the article to
 * `PUBLISHED` (`docs/27` §4, AC2). The reviewer must differ from the author (rule K1) —
 * unreviewed content must not reach requesters.
 */
export async function publishArticle(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  assertPermission(actor, 'kb:article:publish');
  // Republishing is allowed once the working copy has changed (`docs/27` §4: a published
  // article stays editable and publishing creates the next version).
  if (article.status === 'PUBLISHED' && article.draftChangedAt === null) {
    throw new ConflictError('The article is already published.');
  }
  if (article.authorId === actor.userId) {
    throw new ConflictError('Publishing requires a reviewer distinct from the author (K1).');
  }

  const now = new Date();
  // The first publish is version 1; each republish advances the immutable snapshot.
  const nextVersion = article.publishedAt ? article.version + 1 : 1;

  await runInTransaction(async (tx) => {
    await createArticleVersion(
      {
        organizationId: article.organizationId,
        articleId: article.id,
        version: nextVersion,
        title: article.title,
        summary: article.summary,
        body: article.body,
        visibility: article.visibility,
        publishedAt: now,
        publishedById: actor.userId,
      },
      tx,
    );
    await updateArticle(
      article.id,
      {
        status: 'PUBLISHED',
        version: nextVersion,
        publishedAt: now,
        reviewedAt: now,
        reviewerId: actor.userId,
        archivedAt: null,
        // The published snapshot now matches the working copy.
        draftChangedAt: null,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId: article.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ARTICLE_PUBLISH,
        entityType: AUDIT_ENTITY.ARTICLE,
        entityId: article.id,
        before: { status: article.status, version: article.version },
        after: { status: 'PUBLISHED', version: nextVersion },
        reason: `version ${nextVersion}`,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  const stored = await findArticleById(article.id);
  if (!stored) throw new NotFoundError('Article not found.');
  return toView(stored, false);
}

/**
 * Archives an article (AC4). It leaves search and the browse list but direct links keep
 * resolving, with an archived banner (`docs/27` §11). Deletion is prohibited (K7).
 */
export async function archiveArticle(
  id: string,
  reason: string | null,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  assertPermission(actor, 'kb:article:publish');
  if (article.status === 'ARCHIVED') {
    throw new ConflictError('The article is already archived.');
  }
  return setStatus(article, 'ARCHIVED', actor, meta, reason);
}

/** Restores an archived article to `PUBLISHED` (`docs/27` §4). */
export async function unarchiveArticle(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<ArticleView> {
  const article = await loadReadable(id, actor);
  assertPermission(actor, 'kb:article:publish');
  if (article.status !== 'ARCHIVED') {
    throw new ConflictError('Only an archived article can be unarchived.');
  }
  if (!article.publishedAt) {
    throw new ConflictError('An article that was never published cannot be unarchived.');
  }
  return setStatus(article, 'PUBLISHED', actor, meta, null);
}

async function setStatus(
  article: ArticleWithCategory,
  status: ArticleStatus,
  actor: Principal,
  meta: RequestMeta,
  reason: string | null,
): Promise<ArticleView> {
  const data: Parameters<typeof updateArticle>[1] = { status };
  if (status === 'ARCHIVED') data.archivedAt = new Date();

  await runInTransaction(async (tx) => {
    await updateArticle(article.id, data, tx);
    await writeAudit(
      {
        organizationId: article.organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action:
          status === 'ARCHIVED'
            ? AUDIT_ACTION.ARTICLE_ARCHIVE
            : status === 'PUBLISHED'
              ? AUDIT_ACTION.ARTICLE_PUBLISH
              : AUDIT_ACTION.ARTICLE_REVIEW,
        entityType: AUDIT_ENTITY.ARTICLE,
        entityId: article.id,
        before: { status: article.status },
        after: { status },
        reason,
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });

  const stored = await findArticleById(article.id);
  if (!stored) throw new NotFoundError('Article not found.');
  return toView(stored, false);
}

// ===========================================================================
// Categories
// ===========================================================================

export interface CreateArticleCategoryInput {
  name: string;
  description?: string | null;
  parentId?: string | null;
  displayOrder?: number;
}

export async function createKnowledgeCategory(
  input: CreateArticleCategoryInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<{ id: string; name: string; parentId: string | null }> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'admin:config');

  if (input.parentId) {
    const parent = await findArticleCategoryById(input.parentId);
    if (!parent || parent.organizationId !== organizationId) {
      throw new NotFoundError('Parent category not found.');
    }
  }

  const created = await runInTransaction(async (tx) => {
    const category = await createArticleCategory(
      {
        organizationId,
        parentId: input.parentId ?? null,
        name: input.name,
        description: input.description ?? null,
        displayOrder: input.displayOrder ?? 0,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ARTICLE_CATEGORY_CREATE,
        entityType: AUDIT_ENTITY.ARTICLE_CATEGORY,
        entityId: category.id,
        after: { name: category.name, parentId: category.parentId },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return category;
  });

  return { id: created.id, name: created.name, parentId: created.parentId };
}

export async function renameKnowledgeCategory(
  id: string,
  input: { name?: string; description?: string | null; isActive?: boolean },
  actor: Principal,
  meta: RequestMeta,
): Promise<{ id: string; name: string }> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'admin:config');
  const category = await findArticleCategoryById(id);
  if (!category || category.organizationId !== organizationId) {
    throw new NotFoundError('Article category not found.');
  }

  const updated = await runInTransaction(async (tx) => {
    const row = await updateArticleCategory(id, input, tx);
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ARTICLE_CATEGORY_UPDATE,
        entityType: AUDIT_ENTITY.ARTICLE_CATEGORY,
        entityId: id,
        before: { name: category.name, isActive: category.isActive },
        after: { name: row.name, isActive: row.isActive },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return row;
  });

  return { id: updated.id, name: updated.name };
}

export async function listKnowledgeCategories(
  actor: Principal,
): Promise<Array<{ id: string; name: string; parentId: string | null; articleCount: number }>> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:read');
  const [categories, counts] = await Promise.all([
    listArticleCategories(organizationId),
    countArticlesByCategoryId(organizationId),
  ]);
  const byCategory = new Map(counts.map((row) => [row.categoryId ?? '', row.count]));
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    parentId: category.parentId,
    articleCount: byCategory.get(category.id) ?? 0,
  }));
}

// ===========================================================================
// Links — what a record was resolved with (rule K6)
// ===========================================================================

export interface KnowledgeLinkInput {
  entityType: 'REQUEST' | 'INCIDENT';
  entityId: string;
  /** A reason is not required, but the link records who made it. */
  articleId: string;
}

/** Links an article, at the version current when the link is made, to a record. */
export async function linkArticleToRecord(
  input: KnowledgeLinkInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<{ id: string; articleId: string; articleVersion: number }> {
  const organizationId = requireTenant(actor);
  // Linking is not authoring: any caller who may read knowledge may attach an article they
  // can read to a record they can see (`docs/27` §5 K6). The link is audited (AC6).
  assertPermission(actor, 'kb:article:read');
  const recordOrganizationId = await assertRecordVisible(input.entityType, input.entityId, actor);
  if (recordOrganizationId !== organizationId) {
    throw new NotFoundError('Record not found.');
  }
  const article = await findArticleById(input.articleId);
  if (!article || article.organizationId !== organizationId) {
    throw new NotFoundError('Article not found.');
  }
  assertArticleReadable(article, actor);
  if (article.status !== 'PUBLISHED') {
    throw new ConflictError('Only a published article can be linked to a record.');
  }
  const existing = await findKnowledgeLink({
    organizationId,
    articleId: article.id,
    entityType: input.entityType,
    entityId: input.entityId,
  });
  if (existing) {
    throw new DuplicateError('That article is already linked to this record.');
  }

  const created = await runInTransaction(async (tx) => {
    const link = await createKnowledgeLink(
      {
        organizationId,
        articleId: article.id,
        articleVersion: article.version,
        entityType: input.entityType,
        entityId: input.entityId,
        linkedById: actor.userId,
      },
      tx,
    );
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.ARTICLE_LINK,
        entityType: AUDIT_ENTITY.ARTICLE,
        entityId: article.id,
        after: {
          entityType: input.entityType,
          entityId: input.entityId,
          articleVersion: article.version,
        },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return link;
  });

  return { id: created.id, articleId: article.id, articleVersion: created.articleVersion };
}

/**
 * The links on a record, each resolved to the version linked at the time (AC3). An
 * archived article still resolves, flagged with `archived: true` (§11).
 */
export async function listRecordKnowledgeLinks(
  entityType: 'REQUEST' | 'INCIDENT',
  entityId: string,
  actor: Principal,
): Promise<
  Array<{
    id: string;
    articleId: string;
    articleVersion: number;
    title: string;
    slug: string;
    archived: boolean;
    /** The snapshot the resolver actually read, when it still exists. */
    linkedBody: string | null;
  }>
> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'kb:article:read');
  // The parent's own visibility rule decides whether the caller may see its links.
  await assertRecordVisible(entityType, entityId, actor);
  const links = await listKnowledgeLinksForEntity({ organizationId, entityType, entityId });

  return Promise.all(
    links.map(async (link: ArticleLinkRow) => {
      const snapshot = await findArticleVersion(link.articleId, link.articleVersion);
      return {
        id: link.id,
        articleId: link.articleId,
        articleVersion: link.articleVersion,
        title: link.article.title,
        slug: link.article.slug,
        archived: link.article.status === 'ARCHIVED',
        linkedBody: snapshot?.body ?? null,
      };
    }),
  );
}
