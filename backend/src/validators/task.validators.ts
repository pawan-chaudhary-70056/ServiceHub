import { z } from 'zod';
import { cursorPaginationSchema } from './index';

/**
 * Task request schemas (docs/24, docs/12).
 *
 * `dueAt` is a plan, not a commitment — the parent's SLA is the commitment (`docs/24`
 * §6) — so it is optional and nullable. `blockedReason` is required only on the
 * transition to BLOCKED, which the state machine enforces.
 */

export const taskStatusSchema = z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']);

export type TaskStatusInput = z.infer<typeof taskStatusSchema>;

const dueAtSchema = z.string().datetime({ offset: true }).nullable().optional();

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000).nullable().default(null),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    dueAt: dueAtSchema,
  })
  .strict();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    dueAt: dueAtSchema,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const transitionTaskSchema = z
  .object({
    to: taskStatusSchema,
    /** Required to enter BLOCKED; recorded on the task (`docs/24` §3). */
    blockedReason: z.string().trim().min(1).max(2000).optional(),
    /** Required to cancel; recorded in the audit trail (`docs/24` §3). */
    reason: z.string().trim().max(2000).optional(),
    /** Free-text note captured with a completion. */
    completionNote: z.string().trim().max(2000).optional(),
  })
  .strict();

export type TransitionTaskInput = z.infer<typeof transitionTaskSchema>;

export const assignTaskSchema = z
  .object({ assigneeId: z.string().min(1).max(64).nullable() })
  .strict();

export type AssignTaskInput = z.infer<typeof assignTaskSchema>;

export const listTasksQuerySchema = cursorPaginationSchema
  .extend({ status: taskStatusSchema.optional() })
  .strict();
