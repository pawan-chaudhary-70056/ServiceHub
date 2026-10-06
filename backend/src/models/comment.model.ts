import type { Comment, CommentVisibility } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/**
 * Comment data access — docs/22 §6.
 *
 * A comment is attached to any record by `(entityType, entityId)`, the shared child-table
 * design from docs/08 §3. The one rule that matters here is audience: an `INTERNAL` note
 * is never returned to a requester, and that filter is applied **in the query** (docs/22
 * §5 R5), not after the fetch. Filtering in application code is how an internal note
 * eventually leaks through an export or a notification.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface CommentWithAuthor extends Comment {
  author: { id: string; email: string; displayName: string };
}

export function createComment(
  data: {
    organizationId: string;
    entityType: string;
    entityId: string;
    authorId: string;
    visibility: CommentVisibility;
    body: string;
  },
  client: DataClient = prisma,
): Promise<Comment> {
  return client.comment.create({ data });
}

export function findCommentById(
  id: string,
  client: DataClient = prisma,
): Promise<CommentWithAuthor | null> {
  return client.comment.findUnique({
    where: { id },
    include: { author: { select: { id: true, email: true, displayName: true } } },
  });
}

export function listComments(
  params: {
    organizationId: string;
    entityType: string;
    entityId: string;
    /** When false, INTERNAL notes are excluded from the query entirely. */
    includeInternal: boolean;
    limit: number;
    cursor?: string;
  },
  client: DataClient = prisma,
): Promise<CommentWithAuthor[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  return client.comment.findMany({
    where: {
      organizationId: params.organizationId,
      entityType: params.entityType,
      entityId: params.entityId,
      ...(params.includeInternal ? {} : { visibility: 'PUBLIC' }),
      ...(params.cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(sortValue) } },
              { createdAt: new Date(sortValue), id: { lt: id } },
            ],
          }
        : {}),
    },
    include: { author: { select: { id: true, email: true, displayName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: params.limit + 1,
  });
}
