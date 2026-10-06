import { z } from 'zod';

/**
 * Client-side validation schemas (docs/12, docs/16).
 *
 * These mirror the server's rules so a user gets immediate feedback instead of a round
 * trip. They are **UX only**: the server validates the same input independently, because
 * client validation is trivially bypassed by calling the API directly. A rule that
 * exists only here does not exist.
 *
 * Where a bound has an operational meaning — a page size, a field length — it is
 * duplicated deliberately and both sides are reviewed together, because the client
 * cannot import the server's schemas (different build, different runtime).
 */

/** Mirrors the server's bound: an unbounded page size is an unbounded query (docs/33 §7). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const searchSchema = z.object({
  // An empty search box means "no query", not a query for the empty string.
  q: z
    .string()
    .trim()
    .max(200, 'Search terms are limited to 200 characters.')
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),
  // Cursor pagination, not offset (docs/11 §6, docs/09 §6): an offset page shifts
  // when rows change and silently duplicates or skips records. The cursor is opaque.
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type SearchInput = z.infer<typeof searchSchema>;

/**
 * A comment on a request or incident (docs/22).
 *
 * `isInternal` is intentionally not modelled here: whether an internal note may be
 * created is an authorization decision made on the server, not a field a client gets to
 * assert. Modelling it client-side would invite trusting it.
 */
export const commentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Enter a comment.')
    .max(5_000, 'Comments are limited to 5000 characters.'),
});

export type CommentInput = z.infer<typeof commentSchema>;
