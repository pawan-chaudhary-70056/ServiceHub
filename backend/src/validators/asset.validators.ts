import { z } from 'zod';
import { cursorPaginationSchema } from './index';

/**
 * Asset request schemas (docs/28 §8, docs/12).
 *
 * `state` is deliberately absent from the create/update envelopes for the states that are
 * *actions* — ASSIGNED and DISPOSED come from `assign`/`dispose`, never from a field edit.
 * That is what keeps `state` and the open assignment from disagreeing (rule AM6).
 */

export const assetStateSchema = z.enum([
  'PROCURED',
  'IN_STOCK',
  'ASSIGNED',
  'IN_REPAIR',
  'RETIRED',
  'DISPOSED',
]);

/** The states an edit may set directly; the rest are transitions. */
export const editableAssetStateSchema = z.enum(['PROCURED', 'IN_STOCK', 'IN_REPAIR']);

const attributesSchema = z.record(z.unknown());

export const createAssetTypeSchema = z
  .object({
    key: z.string().trim().min(2).max(60),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    attributeSchema: z
      .object({ required: z.array(z.string().trim().min(1).max(60)).max(50).optional() })
      .passthrough()
      .optional(),
  })
  .strict();

export type CreateAssetTypeInput = z.infer<typeof createAssetTypeSchema>;

export const updateAssetTypeSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    attributeSchema: z
      .object({ required: z.array(z.string().trim().min(1).max(60)).max(50).optional() })
      .passthrough()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export const createAssetSchema = z
  .object({
    assetTypeId: z.string().min(1).max(64),
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    serialNumber: z.string().trim().max(120).nullable().optional(),
    state: z.enum(['PROCURED', 'IN_STOCK']).optional(),
    attributes: attributesSchema.optional(),
    purchaseDate: z.string().date().nullable().optional(),
    warrantyExpiresAt: z.string().date().nullable().optional(),
  })
  .strict();

export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    serialNumber: z.string().trim().max(120).nullable().optional(),
    attributes: attributesSchema.optional(),
    state: editableAssetStateSchema.optional(),
    purchaseDate: z.string().date().nullable().optional(),
    warrantyExpiresAt: z.string().date().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

export const assignAssetSchema = z
  .object({
    holderType: z.enum(['USER', 'TEAM']),
    userId: z.string().min(1).max(64).nullable().optional(),
    teamId: z.string().min(1).max(64).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => (value.holderType === 'USER' ? Boolean(value.userId) : Boolean(value.teamId)),
    { message: 'The holder must match its type.', path: ['holderType'] },
  );

export type AssignAssetInput = z.infer<typeof assignAssetSchema>;

export const assetNotesSchema = z
  .object({
    notes: z.string().trim().max(2000).nullable().optional(),
    reason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const listAssetsQuerySchema = cursorPaginationSchema
  .extend({
    state: assetStateSchema.optional(),
    assetTypeId: z.string().max(64).optional(),
    holderUserId: z.string().max(64).optional(),
  })
  .strict();
