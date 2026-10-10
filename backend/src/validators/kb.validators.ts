import { z } from 'zod';
import { cursorPaginationSchema } from './index';

/**
 * Knowledge-base request schemas (docs/27, docs/12).
 *
 * The body is **Markdown, not HTML** (docs/27 rule K2): a body carrying an HTML tag is
 * rejected by the service, so stored content can never become stored XSS (docs/17). The
 * renderer escapes as well — the two controls are independent.
 */

export const articleVisibilitySchema = z.enum(['PUBLIC', 'INTERNAL', 'RESTRICTED']);

export const articleStatusSchema = z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED']);

export const createArticleSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    summary: z.string().trim().max(500).nullable().optional(),
    body: z.string().trim().min(1).max(100_000),
    visibility: articleVisibilitySchema.default('INTERNAL'),
    categoryId: z.string().min(1).max(64).nullable().optional(),
    slug: z.string().trim().min(1).max(120).optional(),
    submitForReview: z.boolean().optional(),
  })
  .strict();

export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    body: z.string().trim().min(1).max(100_000).optional(),
    visibility: articleVisibilitySchema.optional(),
    categoryId: z.string().min(1).max(64).nullable().optional(),
    slug: z.string().trim().min(1).max(120).optional(),
    reviewDueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

export const articleFeedbackSchema = z.object({ helpful: z.boolean() }).strict();

export const articleRejectSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict();

export const articleArchiveSchema = z
  .object({ reason: z.string().trim().max(2000).optional() })
  .strict();

export const listArticlesQuerySchema = cursorPaginationSchema
  .extend({
    status: articleStatusSchema.optional(),
    categoryId: z.string().max(64).optional(),
  })
  .strict();

export const createArticleCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    parentId: z.string().min(1).max(64).nullable().optional(),
    displayOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export type CreateArticleCategoryInput = z.infer<typeof createArticleCategorySchema>;

export const updateArticleCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export const knowledgeLinkSchema = z.object({ articleId: z.string().min(1).max(64) }).strict();
