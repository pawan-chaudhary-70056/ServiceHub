import type { Request, Response } from 'express';
import {
  archiveArticle,
  createArticleDraft,
  createKnowledgeCategory,
  getArticle,
  getArticleStats,
  linkArticleToRecord,
  listArticlesPage,
  listKnowledgeCategories,
  listRecordKnowledgeLinks,
  publishArticle,
  recordArticleFeedback,
  rejectArticle,
  renameKnowledgeCategory,
  submitArticleForReview,
  unarchiveArticle,
  updateArticleDraft,
} from '../services';
import { validated } from '../middlewares/validate';
import { UnauthenticatedError } from '../utils/errors';
import type {
  CreateArticleCategoryInput,
  CreateArticleInput,
  UpdateArticleInput,
} from '../validators/kb.validators';
import { requestMeta } from './support';

/**
 * Knowledge-base endpoints (docs/27 §8, docs/11 §9).
 *
 * The route carries the coarse `kb:article:*` permission; the service applies the
 * visibility class and the lifecycle rules. A caller who may not read an article receives
 * `404`, not `403` — the API must not disclose that a restricted article exists.
 */

/** `GET /kb/articles` — visibility-filtered, cursor-paginated list. */
export async function getArticles(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { query } = validated<
    unknown,
    unknown,
    {
      limit: number;
      cursor?: string;
      status?: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'ARCHIVED';
      categoryId?: string;
    }
  >(res);
  res.status(200).json(await listArticlesPage(query, req.actor));
}

/** `POST /kb/articles` — creates a draft (`201`). */
export async function postArticle(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<CreateArticleInput>(res);
  const article = await createArticleDraft(body, req.actor, requestMeta(req));
  res.setHeader('Location', `/api/v1/kb/articles/${article.id}`);
  res.status(201).json({ article });
}

/** `GET /kb/articles/{id}` — id or slug; an archived article carries the banner flag. */
export async function getArticleById(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  res.status(200).json({ article: await getArticle(params.id, req.actor) });
}

/** `PATCH /kb/articles/{id}` — edits; a published article's snapshot is untouched. */
export async function patchArticle(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<UpdateArticleInput, { id: string }>(res);
  res
    .status(200)
    .json({ article: await updateArticleDraft(params.id, body, req.actor, requestMeta(req)) });
}

/** `POST /kb/articles/{id}/submit` — DRAFT → IN_REVIEW. */
export async function postSubmitReview(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  res
    .status(200)
    .json({ article: await submitArticleForReview(params.id, req.actor, requestMeta(req)) });
}

/** `POST /kb/articles/{id}/reject` — IN_REVIEW → DRAFT, with a reason. */
export async function postReject(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ reason: string }, { id: string }>(res);
  res
    .status(200)
    .json({ article: await rejectArticle(params.id, body.reason, req.actor, requestMeta(req)) });
}

/** `POST /kb/articles/{id}/publish` — creates an immutable version (`kb:article:publish`). */
export async function postPublish(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  res.status(200).json({ article: await publishArticle(params.id, req.actor, requestMeta(req)) });
}

/** `POST /kb/articles/{id}/archive` — leaves search; direct links still resolve. */
export async function postArchive(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ reason?: string }, { id: string }>(res);
  res.status(200).json({
    article: await archiveArticle(params.id, body.reason ?? null, req.actor, requestMeta(req)),
  });
}

/** `POST /kb/articles/{id}/unarchive` — ARCHIVED → PUBLISHED. */
export async function postUnarchive(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  res.status(200).json({ article: await unarchiveArticle(params.id, req.actor, requestMeta(req)) });
}

/** `POST /kb/articles/{id}/feedback` — the helpful/not-helpful vote (`docs/27` §9). */
export async function postFeedback(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ helpful: boolean }, { id: string }>(res);
  res.status(200).json({ article: await recordArticleFeedback(params.id, body, req.actor) });
}

/** `GET /kb/stats` — the status board and stale-review count (`docs/27` §9). */
export async function getStats(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json(await getArticleStats(req.actor));
}

/** `GET /kb/categories` — the browse tree. */
export async function getCategories(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  res.status(200).json({ items: await listKnowledgeCategories(req.actor) });
}

/** `POST /kb/categories` — administrator only. */
export async function postCategory(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body } = validated<CreateArticleCategoryInput>(res);
  const category = await createKnowledgeCategory(body, req.actor, requestMeta(req));
  res.status(201).json({ category });
}

/** `PATCH /kb/categories/{id}` — administrator only. */
export async function patchCategory(req: Request, res: Response): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<
    { name?: string; description?: string | null; isActive?: boolean },
    { id: string }
  >(res);
  res.status(200).json({
    category: await renameKnowledgeCategory(params.id, body, req.actor, requestMeta(req)),
  });
}

type RecordEntityType = 'REQUEST' | 'INCIDENT';

async function handlePostKnowledgeLink(
  entityType: RecordEntityType,
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { body, params } = validated<{ articleId: string }, { id: string }>(res);
  const link = await linkArticleToRecord(
    { entityType, entityId: params.id, articleId: body.articleId },
    req.actor,
    requestMeta(req),
  );
  res.status(201).json({ link });
}

async function handleGetKnowledgeLinks(
  entityType: RecordEntityType,
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.actor) throw new UnauthenticatedError();
  const { params } = validated<unknown, { id: string }>(res);
  res.status(200).json({ items: await listRecordKnowledgeLinks(entityType, params.id, req.actor) });
}

/** `POST /requests/{id}/knowledge-links` (docs/27 §8). */
export function postRequestKnowledgeLink(req: Request, res: Response): Promise<void> {
  return handlePostKnowledgeLink('REQUEST', req, res);
}

/** `GET /requests/{id}/knowledge-links` (docs/27 §8). */
export function getRequestKnowledgeLinks(req: Request, res: Response): Promise<void> {
  return handleGetKnowledgeLinks('REQUEST', req, res);
}

/** `POST /incidents/{id}/knowledge-links` (docs/27 §8). */
export function postIncidentKnowledgeLink(req: Request, res: Response): Promise<void> {
  return handlePostKnowledgeLink('INCIDENT', req, res);
}

/** `GET /incidents/{id}/knowledge-links` (docs/27 §8). */
export function getIncidentKnowledgeLinks(req: Request, res: Response): Promise<void> {
  return handleGetKnowledgeLinks('INCIDENT', req, res);
}
