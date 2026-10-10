import { z } from 'zod';

/**
 * Inbound webhook request schemas (`docs/32` §5/§12, `docs/12`).
 *
 * The `{provider}` path segment is validated as a URL-safe slug here so it cannot carry a
 * path separator, a traversal sequence or a wildcard into the lookup. The *body* of an
 * inbound delivery is deliberately **not** validated by Zod at the edge: it is untrusted
 * provider input and is validated by the processing worker, after it has been persisted
 * (`docs/32` §5).
 */

export const webhookKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'The endpoint key must be lowercase alphanumeric with hyphens.');

export const createInboundEndpointSchema = z
  .object({
    key: webhookKeySchema,
    provider: z.string().trim().min(2).max(80),
  })
  .strict();

export type CreateInboundEndpointBody = z.infer<typeof createInboundEndpointSchema>;

export const updateInboundEndpointSchema = z
  .object({
    provider: z.string().trim().min(2).max(80).optional(),
    enabled: z.boolean().optional(),
    rotateSecret: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateInboundEndpointBody = z.infer<typeof updateInboundEndpointSchema>;

export const inboundProviderParamsSchema = z.object({ provider: webhookKeySchema });

export const inboundEndpointParamsSchema = z.object({ id: z.string().min(1).max(64) });
