import { z } from 'zod';
import { cursorPaginationSchema } from './index';

/**
 * Service catalog request schemas (docs/21, docs/12).
 *
 * Strict by default (docs/12 §2): an unknown field is rejected, which is both a
 * mass-assignment defence and a way to surface client bugs. The schema bounds every
 * string and collection — an unbounded input is an unbounded write (docs/33 §7).
 */

const fieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Field key must be lower-case letters, digits and underscores.');

const displayOrderSchema = z.number().int().min(0).max(10000).default(0);

export const catalogFieldTypeSchema = z.enum([
  'TEXT',
  'LONG_TEXT',
  'NUMBER',
  'DATE',
  'DATETIME',
  'SELECT',
  'MULTI_SELECT',
  'BOOLEAN',
  'FILE',
  'USER',
]);

/** A field definition. Options are required for the choice types (rule C4). */
export const catalogFieldSchema = z
  .object({
    key: fieldKeySchema,
    label: z.string().trim().min(1).max(120),
    fieldType: catalogFieldTypeSchema,
    isRequired: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    validation: z.record(z.unknown()).optional(),
    helpText: z.string().trim().max(500).optional(),
    displayOrder: displayOrderSchema,
  })
  .strict()
  .superRefine((field, ctx) => {
    if (
      (field.fieldType === 'SELECT' || field.fieldType === 'MULTI_SELECT') &&
      (field.options?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A choice field must declare at least one option.',
      });
    }
  });

export type CatalogFieldInput = z.infer<typeof catalogFieldSchema>;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    parentId: z.string().min(1).max(64).nullable().default(null),
    description: z.string().trim().max(500).nullable().default(null),
    displayOrder: displayOrderSchema,
  })
  .strict();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    parentId: z.string().min(1).max(64).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    displayOrder: displayOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listCategoriesQuerySchema = z
  .object({ includeInactive: z.coerce.boolean().default(false) })
  .strict();

// ---------------------------------------------------------------------------
// Catalog items
// ---------------------------------------------------------------------------

export const createCatalogItemSchema = z
  .object({
    categoryId: z.string().min(1).max(64),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).nullable().default(null),
    defaultPriority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    defaultSlaPolicyId: z.string().min(1).max(64).nullable().default(null),
    fulfilmentTeamId: z.string().min(1).max(64).nullable().default(null),
    requiresApproval: z.boolean().default(false),
    fields: z.array(catalogFieldSchema).max(50).default([]),
  })
  .strict();

export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

export const updateCatalogItemSchema = z
  .object({
    categoryId: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    defaultPriority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    defaultSlaPolicyId: z.string().min(1).max(64).nullable().optional(),
    fulfilmentTeamId: z.string().min(1).max(64).nullable().optional(),
    requiresApproval: z.boolean().optional(),
    fields: z.array(catalogFieldSchema).max(50).optional(),
  })
  .strict();

export type UpdateCatalogItemInput = z.infer<typeof updateCatalogItemSchema>;

/** The manage list accepts a status filter; the requester list is always ACTIVE-only. */
export const listCatalogItemsQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional(),
    categoryId: z.string().min(1).max(64).optional(),
  })
  .strict();

export const listActiveItemsQuerySchema = cursorPaginationSchema
  .extend({ categoryId: z.string().min(1).max(64).optional() })
  .strict();
