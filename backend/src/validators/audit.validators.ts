import { z } from 'zod';
import { cursorPaginationSchema, idParam } from './index';

/**
 * Audit explorer request schemas (docs/31 §10, docs/12).
 *
 * Filters are a **closed set** and each maps to an indexed column (`docs/09` §3): an
 * unindexed filter is a full-table scan wearing a feature's clothes, and on an audit log
 * that grows forever it is the query that eventually takes the database down.
 */

export const auditListQuerySchema = cursorPaginationSchema
  .extend({
    /** A dotted action namespace, e.g. `request.status.change`. */
    action: z.string().trim().min(1).max(80).optional(),
    actorId: idParam.optional(),
    entityType: z.string().trim().min(1).max(64).optional(),
    entityId: idParam.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    securityOnly: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to), {
    path: ['to'],
    message: 'The end of the range must not precede its start.',
  });

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditRecordParamsSchema = z.object({
  entityType: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z]+$/, 'Entity types are unqualified table names.'),
  entityId: idParam,
});

export type AuditRecordParams = z.infer<typeof auditRecordParamsSchema>;

export const auditRecordQuerySchema = cursorPaginationSchema.strict();

/**
 * The audit export request body (`docs/31` §10).
 *
 * The same closed, indexed filter set as the explorer, without pagination: an export is a
 * whole result set, rendered off the request path (`docs/30` §5).
 */
export const auditExportBodySchema = z
  .object({
    action: z.string().trim().min(1).max(80).optional(),
    actorId: idParam.optional(),
    entityType: z.string().trim().min(1).max(64).optional(),
    entityId: idParam.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    securityOnly: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to), {
    path: ['to'],
    message: 'The end of the range must not precede its start.',
  });

export type AuditExportBody = z.infer<typeof auditExportBodySchema>;

export const auditExportParamsSchema = z.object({ id: idParam });
