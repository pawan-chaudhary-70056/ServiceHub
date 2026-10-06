import { z } from 'zod';
import { cursorPaginationSchema } from './index';

/**
 * Service request request schemas (docs/22, docs/12).
 *
 * Dynamic form values are validated against the catalog item's field definitions **in the
 * service**, because only there is the item's snapshot known; this schema bounds the
 * envelope (which keys, how many, how large) so an oversized payload cannot reach it.
 */

export type RequestStatusInput = z.infer<typeof requestStatusSchema>;

export const requestStatusSchema = z.enum([
  'NEW',
  'TRIAGED',
  'APPROVAL_PENDING',
  'APPROVED',
  'REJECTED',
  'IN_PROGRESS',
  'FULFILLED',
  'CLOSED',
  'CANCELLED',
]);

export const createRequestSchema = z
  .object({
    catalogItemId: z.string().min(1).max(64),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000).nullable().default(null),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    /** Dynamic answers keyed by the catalog field key. */
    fields: z.record(z.unknown()).default({}),
    /** Client-generated key so a double submit returns the original request (docs/22 §13). */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value.fields).length <= 50, {
    path: ['fields'],
    message: 'A request may carry at most 50 field values.',
  });

export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const transitionRequestSchema = z
  .object({
    to: requestStatusSchema,
    reason: z.string().trim().max(2000).optional(),
    /** Required when fulfilling; recorded on the request (docs/22 §3 R2). */
    fulfilmentNote: z.string().trim().max(2000).optional(),
  })
  .strict();

export type TransitionRequestInput = z.infer<typeof transitionRequestSchema>;

export const assignRequestSchema = z
  .object({
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    teamId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((value) => value.assigneeId !== undefined || value.teamId !== undefined, {
    message: 'Provide an assignee or a team.',
  });

export type AssignRequestInput = z.infer<typeof assignRequestSchema>;

export const cancelRequestSchema = z
  .object({ reason: z.string().trim().max(2000).optional() })
  .strict();

export const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(5000),
    visibility: z.enum(['PUBLIC', 'INTERNAL']).default('PUBLIC'),
  })
  .strict();

export type CommentInput = z.infer<typeof commentSchema>;

export const listRequestsQuerySchema = cursorPaginationSchema
  .extend({ status: requestStatusSchema.optional() })
  .strict();

export const listCommentsQuerySchema = cursorPaginationSchema.strict();
