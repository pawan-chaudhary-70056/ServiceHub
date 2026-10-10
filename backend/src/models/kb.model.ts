import type {
  Article,
  ArticleCategory,
  ArticleStatus,
  ArticleVersion,
  ArticleVisibility,
  KnowledgeLink,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Knowledge-base data access — docs/27, F-15.
 *
 * Two rules shape every query here:
 *
 *   - **K3** — visibility is a **SQL predicate, applied before ranking or pagination**
 *     (never fetch-then-filter). `ArticleVisibilityScope` is resolved by the service
 *     from the caller's permissions; this module turns it into the predicate, so the
 *     rule is enforced in the same place for the list, the read and the search branch.
 *   - **K7** — there is no delete path. Only published snapshots are addressable and an
 *     article leaves circulation by being archived.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

/** The widest visibility class the caller may read (resolved from permissions by the service). */
export type ArticleVisibilityScope = 'ALL' | 'INTERNAL' | 'PUBLIC_ONLY';

export interface ArticleWithCategory extends Article {
  category: Pick<ArticleCategory, 'id' | 'name' | 'parentId'> | null;
  /** Newest-first; `[0]` is the currently published snapshot, if any (`docs/27` §4). */
  versions: ArticleVersion[];
}

export interface ArticleListRow extends Article {
  category: Pick<ArticleCategory, 'id' | 'name' | 'parentId'> | null;
  versions: ArticleVersion[];
}

/**
 * The currently published snapshot.
 *
 * Readers are served this content, never the working copy: editing a published article
 * must not alter what is published until republish (`docs/27` §12 AC2, §11).
 */
export function publishedSnapshot(article: { versions: ArticleVersion[] }): ArticleVersion | null {
  return article.versions[0] ?? null;
}

export interface ArticleLinkRow extends KnowledgeLink {
  article: Pick<Article, 'id' | 'title' | 'slug' | 'status' | 'visibility' | 'version' | 'summary'>;
}

/**
 * The visibility predicate, applied as SQL (rule K3 — never fetch-then-filter).
 *
 * Exported because the search branch must apply **the same** predicate as the read
 * path; a hidden article leaking through search is the classic KB defect (`docs/27` §5
 * K3, `docs/30` §2.3 S1).
 *
 *   PUBLIC_ONLY  PUBLIC
 *   INTERNAL     PUBLIC + INTERNAL, plus a RESTRICTED article the caller authors or
 *                reviews (the object-level grant of `docs/27` §7)
 *   ALL          everything the tenant holds (`kb:article:publish`)
 */
export function articleVisibilityWhere(
  scope: ArticleVisibilityScope,
  userId: string,
): Prisma.ArticleWhereInput {
  if (scope === 'ALL') return {};
  if (scope === 'INTERNAL') {
    return {
      OR: [
        { visibility: { in: ['PUBLIC', 'INTERNAL'] } },
        { visibility: 'RESTRICTED', authorId: userId },
        { visibility: 'RESTRICTED', reviewerId: userId },
      ],
    };
  }
  return { visibility: 'PUBLIC' };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function listArticleCategories(
  organizationId: string,
  client: DataClient = prisma,
): Promise<ArticleCategory[]> {
  return client.articleCategory.findMany({
    where: { organizationId },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });
}

export function findArticleCategoryById(
  id: string,
  client: DataClient = prisma,
): Promise<ArticleCategory | null> {
  return client.articleCategory.findUnique({ where: { id } });
}

export function createArticleCategory(
  data: {
    organizationId: string;
    parentId: string | null;
    name: string;
    description: string | null;
    displayOrder: number;
  },
  client: DataClient = prisma,
): Promise<ArticleCategory> {
  return client.articleCategory.create({ data });
}

export function updateArticleCategory(
  id: string,
  data: { name?: string; description?: string | null; displayOrder?: number; isActive?: boolean },
  client: DataClient = prisma,
): Promise<ArticleCategory> {
  return client.articleCategory.update({ where: { id }, data });
}

export function countChildArticleCategories(
  id: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.articleCategory.count({ where: { parentId: id } });
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

const articleInclude = {
  category: { select: { id: true, name: true, parentId: true } },
  versions: { orderBy: { version: 'desc' }, take: 1 },
} as const;

export function findArticleById(
  id: string,
  client: DataClient = prisma,
): Promise<ArticleWithCategory | null> {
  return client.article.findUnique({ where: { id }, include: articleInclude });
}

export function findArticleBySlug(
  organizationId: string,
  slug: string,
  client: DataClient = prisma,
): Promise<ArticleWithCategory | null> {
  return client.article.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    include: articleInclude,
  });
}

/** A retired slug still resolves to its article (docs/27 §12 AC5). */
export function findArticleSlugRedirect(
  organizationId: string,
  fromSlug: string,
  client: DataClient = prisma,
): Promise<{ id: string; articleId: string } | null> {
  return client.articleSlugRedirect.findUnique({
    where: { organizationId_fromSlug: { organizationId, fromSlug } },
    select: { id: true, articleId: true },
  });
}

export interface ListArticlesParams {
  organizationId: string;
  scope: ArticleVisibilityScope;
  /** The caller, for the RESTRICTED author/reviewer grant in the predicate. */
  userId: string;
  /** Include DRAFT/IN_REVIEW — only an author/publisher may (docs/27 §4). */
  includeUnpublished: boolean;
  status?: ArticleStatus;
  categoryId?: string;
  limit: number;
  /** Opaque cursor encoding the last `(updatedAt, id)`; absent starts at the newest. */
  cursor?: string;
  client?: DataClient;
}

/**
 * Cursor-paginated article list. Fetches `limit + 1` rows so `hasMore` needs no second
 * count query (`docs/11` §6); the service builds the page.
 */
export function listArticles(params: ListArticlesParams): Promise<ArticleListRow[]> {
  const client = params.client ?? prisma;
  const where: Prisma.ArticleWhereInput = {
    organizationId: params.organizationId,
    ...articleVisibilityWhere(params.scope, params.userId),
  };
  if (params.status) {
    where.status = params.status;
  } else if (!params.includeUnpublished) {
    // Readers only ever see published content; a draft is not merely filtered out of the
    // list, it is not selectable.
    where.status = 'PUBLISHED';
  }
  if (params.categoryId) where.categoryId = params.categoryId;

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    const updatedAt = new Date(decoded.sortValue);
    where.AND = [
      {
        OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: decoded.id } }],
      },
    ];
  }

  return client.article.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
    include: articleInclude,
  });
}

export function createArticle(
  data: {
    organizationId: string;
    categoryId: string | null;
    title: string;
    slug: string;
    summary: string | null;
    body: string;
    visibility: ArticleVisibility;
    authorId: string;
    reviewDueAt: Date | null;
  },
  client: DataClient = prisma,
): Promise<Article> {
  return client.article.create({ data });
}

export function updateArticle(
  id: string,
  data: Prisma.ArticleUncheckedUpdateInput,
  client: DataClient = prisma,
): Promise<Article> {
  return client.article.update({ where: { id }, data });
}

export function createArticleSlugRedirect(
  data: { organizationId: string; articleId: string; fromSlug: string },
  client: DataClient = prisma,
): Promise<{ id: string }> {
  return client.articleSlugRedirect.create({ data, select: { id: true } });
}

/** Counts published articles per visibility class — the KB status board (`docs/27` §9). */
export function countArticlesByStatus(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Array<{ status: ArticleStatus; count: number }>> {
  return client.article
    .groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } })
    .then((rows) => rows.map((row) => ({ status: row.status, count: row._count._all })));
}

/** Published articles past their review date — the stale-review queue (`docs/27` §6). */
export function countStaleArticles(
  organizationId: string,
  now: Date,
  client: DataClient = prisma,
): Promise<number> {
  return client.article.count({
    where: { organizationId, status: 'PUBLISHED', reviewDueAt: { lt: now } },
  });
}

/** Article counts per category, for the KB browse tree (`docs/27` §9). */
export function countArticlesByCategoryId(
  organizationId: string,
  client: DataClient = prisma,
): Promise<Array<{ categoryId: string | null; count: number }>> {
  return client.article
    .groupBy({ by: ['categoryId'], where: { organizationId }, _count: { _all: true } })
    .then((rows) => rows.map((row) => ({ categoryId: row.categoryId, count: row._count._all })));
}

/** Records a view / helpful vote without a read-modify-write race (`docs/27` §6). */
export async function incrementArticleCounter(
  id: string,
  field: 'viewCount' | 'helpfulCount' | 'notHelpfulCount',
  client: DataClient = prisma,
): Promise<void> {
  await client.article.update({ where: { id }, data: { [field]: { increment: 1 } } });
}

// ---------------------------------------------------------------------------
// Versions — immutable published snapshots (docs/27 §4)
// ---------------------------------------------------------------------------

export function createArticleVersion(
  data: {
    organizationId: string;
    articleId: string;
    version: number;
    title: string;
    summary: string | null;
    body: string;
    visibility: ArticleVisibility;
    publishedAt: Date;
    publishedById: string;
  },
  client: DataClient = prisma,
): Promise<ArticleVersion> {
  return client.articleVersion.create({ data });
}

export function findArticleVersion(
  articleId: string,
  version: number,
  client: DataClient = prisma,
): Promise<ArticleVersion | null> {
  return client.articleVersion.findUnique({
    where: { articleId_version: { articleId, version } },
  });
}

// ---------------------------------------------------------------------------
// Links — what a record was actually resolved with (rule K6)
// ---------------------------------------------------------------------------

export function createKnowledgeLink(
  data: {
    organizationId: string;
    articleId: string;
    articleVersion: number;
    entityType: string;
    entityId: string;
    linkedById: string;
  },
  client: DataClient = prisma,
): Promise<KnowledgeLink> {
  return client.knowledgeLink.create({ data });
}

export function listKnowledgeLinksForEntity(
  params: { organizationId: string; entityType: string; entityId: string },
  client: DataClient = prisma,
): Promise<ArticleLinkRow[]> {
  return client.knowledgeLink.findMany({
    where: {
      organizationId: params.organizationId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    orderBy: { createdAt: 'desc' },
    include: {
      article: {
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          visibility: true,
          version: true,
          summary: true,
        },
      },
    },
  });
}

export function findKnowledgeLink(
  params: {
    organizationId: string;
    articleId: string;
    entityType: string;
    entityId: string;
  },
  client: DataClient = prisma,
): Promise<KnowledgeLink | null> {
  return client.knowledgeLink.findUnique({
    where: {
      organizationId_articleId_entityType_entityId: {
        organizationId: params.organizationId,
        articleId: params.articleId,
        entityType: params.entityType,
        entityId: params.entityId,
      },
    },
  });
}
