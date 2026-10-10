import { z } from 'zod';
import { cursorPaginationSchema, idParam } from './index';

/**
 * Integration webhook request schemas (docs/32 §12, docs/12).
 *
 * The event selection is validated here as a non-empty list of strings; the *vocabulary* is
 * checked in the service against the durable event catalogue, so the schema owns shape and
 * the service owns whether an event name is real (`docs/32` §4).
 */

export const createWebhookSubscriptionSchema = z
  .object({
    description: z.string().trim().min(2).max(200),
    url: z.string().url().max(2048),
    events: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
    enabled: z.boolean().optional(),
  })
  .strict();

export type CreateWebhookSubscriptionBody = z.infer<typeof createWebhookSubscriptionSchema>;

export const updateWebhookSubscriptionSchema = z
  .object({
    description: z.string().trim().min(2).max(200).optional(),
    url: z.string().url().max(2048).optional(),
    events: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
    enabled: z.boolean().optional(),
    rotateSecret: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateWebhookSubscriptionBody = z.infer<typeof updateWebhookSubscriptionSchema>;

export const webhookSubscriptionParamsSchema = z.object({ id: idParam });

export const deadLetterQuerySchema = cursorPaginationSchema.strict();
