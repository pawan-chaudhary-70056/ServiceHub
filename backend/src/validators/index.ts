import { z } from 'zod';

/**
 * Shared validation schemas.
 *
 * These are the reusable boundary primitives that every endpoint composes, so the
 * contract for pagination or an identifier is defined once and cannot drift between
 * routes. Entity schemas are added alongside their domain documents (docs/12).
 *
 * Only server-side rules live here. Form-level UX behaviour (inline errors, field
 * focus, submit behaviour) is owned by docs/16 and never substitutes for this.
 */

/**
 * Opaque identifiers. The data model forbids sequential integers in URLs (docs/08 §1)
 * because they allow enumeration of records the caller may not be entitled to see —
 * an IDOR aid. The accepted shapes are the two schemes the model allows.
 */
export const idParam = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9a-zA-Z_-]+$/, 'Identifier format is invalid.');

export const idParamsSchema = z.object({ id: idParam });

/**
 * Cursor pagination for record listings (docs/11 §6).
 *
 * Cursor, not offset: an offset page shifts when rows are inserted concurrently, which
 * silently duplicates or skips records. The cursor is opaque to the client.
 *
 * `limit` is bounded — an unbounded page size is an unbounded query, which is the
 * database-protection failure the whole scalability strategy exists to prevent
 * (docs/33 §7).
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const cursorPaginationSchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/**
 * Sorting is a whitelisted column, never free text.
 *
 * A client-supplied sort expression is both an injection surface and an unindexed-scan
 * generator. Each resource declares the columns it may be sorted by and maps them to
 * indexed fields (docs/09, docs/30 §2.5).
 */
export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;
