import { z } from 'zod';

/**
 * Search and report request schemas (docs/30 §2/§3/§5, docs/12).
 *
 * The search `limit` is bounded like every other page size (docs/33 §7) and `types` is a
 * closed enum, so a client cannot ask for a source the server does not scope.
 */

export const searchEntityTypeSchema = z.enum([
  'REQUEST',
  'INCIDENT',
  'CATALOG_ITEM',
  'USER',
  'ARTICLE',
  'ASSET',
]);

export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(''),
    /** Comma-separated source filter, e.g. `REQUEST,INCIDENT`. */
    types: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim().toUpperCase())
          .filter((entry) => entry.length > 0),
      )
      .pipe(z.array(searchEntityTypeSchema).max(6))
      .optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const reportParamsSchema = z.object({ metric: z.string().trim().min(1).max(64) });

export const reportQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type ReportQuery = z.infer<typeof reportQuerySchema>;
