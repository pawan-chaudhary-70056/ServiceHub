import { z } from 'zod';
import { cursorPaginationSchema } from './index';

/**
 * Incident request schemas (docs/23, docs/12).
 *
 * Impact and urgency are the only priority inputs a client may send: priority is
 * **derived** (docs/23 §3), so it is not part of the create envelope. An override is a
 * separate, permissioned action with its own mandatory reason (§3, rule I1).
 */

export const incidentStatusSchema = z.enum(['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

export type IncidentStatusInput = z.infer<typeof incidentStatusSchema>;

export const incidentImpactSchema = z.enum(['EXTENSIVE', 'SIGNIFICANT', 'MINOR']);
export const incidentUrgencySchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

export const createIncidentSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(1).max(5000),
    impact: incidentImpactSchema,
    urgency: incidentUrgencySchema,
    /** Optional fulfilment team; defaults to the reporter's team resolution in the service. */
    teamId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    impact: incidentImpactSchema.optional(),
    urgency: incidentUrgencySchema.optional(),
    /** Present only for a priority override; requires the override permission + reason. */
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  })
  .refine((value) => value.priority === undefined || value.reason !== undefined, {
    path: ['reason'],
    message: 'A reason is required to override the derived priority.',
  });

export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

export const assignIncidentSchema = z
  .object({
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    teamId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((value) => value.assigneeId !== undefined || value.teamId !== undefined, {
    message: 'Provide an assignee or a team.',
  });

export type AssignIncidentInput = z.infer<typeof assignIncidentSchema>;

export const resolveIncidentSchema = z
  .object({
    resolutionSummary: z.string().trim().min(1).max(5000),
    /** Required only to resolve over open child tasks with `task:override` (`docs/24` §4). */
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export type ResolveIncidentInput = z.infer<typeof resolveIncidentSchema>;

/**
 * There is deliberately no "transition" schema here. An incident's lifecycle is driven by
 * named edges, not by a client-supplied target state (`docs/23` §4, `docs/11` §9):
 * **assignment** is the `NEW → IN_PROGRESS` edge, `/resolve` is `IN_PROGRESS → RESOLVED`,
 * `/close` is `RESOLVED → CLOSED` and `/reopen` is `RESOLVED/CLOSED → IN_PROGRESS`. A
 * schema for an endpoint that does not exist only invites someone to build against it.
 */
export const reopenIncidentSchema = z
  .object({ reason: z.string().trim().max(2000).optional() })
  .strict();

export const majorIncidentSchema = z
  .object({
    isMajor: z.boolean(),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export type MajorIncidentInput = z.infer<typeof majorIncidentSchema>;

export const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(5000),
    visibility: z.enum(['PUBLIC', 'INTERNAL']).default('PUBLIC'),
  })
  .strict();

export type IncidentCommentInput = z.infer<typeof commentSchema>;

export const listIncidentsQuerySchema = cursorPaginationSchema
  .extend({
    status: incidentStatusSchema.optional(),
    majorOnly: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
