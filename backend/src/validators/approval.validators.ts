import { z } from 'zod';

/**
 * Approval request schemas (docs/26 §11, docs/12).
 *
 * A rejection **must** carry a comment (rule A4) — the schema enforces it at the edge so
 * a reasonless rejection never reaches the service.
 */

export const approvalModeSchema = z.enum(['ANY', 'ALL']);

export const approvalTemplateStepSchema = z
  .object({
    stepOrder: z.number().int().min(1).max(50),
    mode: approvalModeSchema,
    /** A tenant role key whose active holders are snapshotted at instantiation. */
    approverRoleKey: z.string().trim().min(1).max(64),
  })
  .strict();

export const createApprovalTemplateSchema = z
  .object({
    catalogItemId: z.string().min(1).max(64),
    name: z.string().trim().min(2).max(150),
    isActive: z.boolean().default(true),
    steps: z.array(approvalTemplateStepSchema).min(1).max(20),
  })
  .strict()
  .refine(
    (value) => new Set(value.steps.map((step) => step.stepOrder)).size === value.steps.length,
    { path: ['steps'], message: 'Step order values must be unique.' },
  );

export type CreateApprovalTemplateInput = z.infer<typeof createApprovalTemplateSchema>;

export const decideApprovalSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'REJECT' || Boolean(value.comment), {
    path: ['comment'],
    message: 'A comment is required to reject.',
  });

export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

export const reassignApprovalStepSchema = z
  .object({
    approverIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  })
  .strict();

export type ReassignApprovalStepInput = z.infer<typeof reassignApprovalStepSchema>;
