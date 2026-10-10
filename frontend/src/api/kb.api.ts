import { apiRequest } from './client';
import type { CursorPage } from './tasks.api';

/**
 * Knowledge Base API (docs/27 §8, docs/11 §9).
 *
 * The server owns the visibility class and the lifecycle: a caller who may not read an
 * article receives `404` rather than `403`, so the UI treats an invisible article exactly
 * like a missing one (`docs/17`). Nothing here filters by visibility — filtering in the
 * client would be a control that does not control anything.
 */

export type ArticleStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'ARCHIVED';
export type ArticleVisibility = 'PUBLIC' | 'INTERNAL' | 'RESTRICTED';
export type KnowledgeEntityType = 'REQUEST' | 'INCIDENT';

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
  publishedAt: string | null;
  reviewedAt: string | null;
  reviewDueAt: string | null;
  archivedAt: string | null;
  archived: boolean;
  /** The working copy has changed since the last publish (`docs/27` §11). */
  hasUnpublishedChanges: boolean;
  /** True when the content returned is the published snapshot rather than the draft. */
  servingPublishedVersion: boolean;
  createdAt: string;
  updatedAt: string;
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
  reviewDueAt: string | null;
  updatedAt: string;
}

export interface ArticleCategory {
  id: string;
  name: string;
  parentId: string | null;
  articleCount: number;
}

export interface KnowledgeLinkView {
  id: string;
  articleId: string;
  articleVersion: number;
  title: string;
  slug: string;
  archived: boolean;
  linkedBody: string | null;
}

export interface CreateArticleInput {
  title: string;
  summary?: string | null;
  body: string;
  visibility?: ArticleVisibility;
  categoryId?: string | null;
  slug?: string;
  submitForReview?: boolean;
}

export interface UpdateArticleInput {
  title?: string;
  summary?: string | null;
  body?: string;
  visibility?: ArticleVisibility;
  categoryId?: string | null;
  slug?: string;
  reviewDueAt?: string | null;
}

export function listArticles(
  params: { cursor?: string; limit?: number; status?: ArticleStatus; categoryId?: string } = {},
  signal?: AbortSignal,
): Promise<CursorPage<ArticleListItem>> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  if (params.categoryId) query.set('categoryId', params.categoryId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<CursorPage<ArticleListItem>>(`/kb/articles${suffix}`, { signal });
}

export function getArticle(
  idOrSlug: string,
  signal?: AbortSignal,
): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${encodeURIComponent(idOrSlug)}`, {
    signal,
  });
}

export function createArticle(input: CreateArticleInput): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>('/kb/articles', { method: 'POST', body: input });
}

export function updateArticle(
  id: string,
  input: UpdateArticleInput,
): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export function submitArticle(id: string): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}/submit`, { method: 'POST' });
}

export function rejectArticle(id: string, reason: string): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}/reject`, {
    method: 'POST',
    body: { reason },
  });
}

export function publishArticle(id: string): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}/publish`, { method: 'POST' });
}

export function archiveArticle(id: string, reason?: string): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}/archive`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

export function unarchiveArticle(id: string): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}/unarchive`, { method: 'POST' });
}

export function recordArticleFeedback(
  id: string,
  helpful: boolean,
): Promise<{ article: ArticleView }> {
  return apiRequest<{ article: ArticleView }>(`/kb/articles/${id}/feedback`, {
    method: 'POST',
    body: { helpful },
  });
}

export function listArticleCategories(signal?: AbortSignal): Promise<{ items: ArticleCategory[] }> {
  return apiRequest<{ items: ArticleCategory[] }>('/kb/categories', { signal });
}

export function createArticleCategory(input: {
  name: string;
  description?: string | null;
  parentId?: string | null;
}): Promise<{ category: { id: string; name: string; parentId: string | null } }> {
  return apiRequest<{ category: { id: string; name: string; parentId: string | null } }>(
    '/kb/categories',
    { method: 'POST', body: input },
  );
}

export function listKnowledgeLinks(
  entityType: KnowledgeEntityType,
  entityId: string,
  signal?: AbortSignal,
): Promise<{ items: KnowledgeLinkView[] }> {
  const resource = entityType === 'REQUEST' ? 'requests' : 'incidents';
  return apiRequest<{ items: KnowledgeLinkView[] }>(`/${resource}/${entityId}/knowledge-links`, {
    signal,
  });
}

export function linkArticle(
  entityType: KnowledgeEntityType,
  entityId: string,
  articleId: string,
): Promise<{ link: { id: string; articleId: string; articleVersion: number } }> {
  const resource = entityType === 'REQUEST' ? 'requests' : 'incidents';
  return apiRequest<{ link: { id: string; articleId: string; articleVersion: number } }>(
    `/${resource}/${entityId}/knowledge-links`,
    { method: 'POST', body: { articleId } },
  );
}
