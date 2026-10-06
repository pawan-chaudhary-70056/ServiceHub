import { z } from 'zod';
import { emailSchema } from './auth.validators';
import { cursorPaginationSchema } from './index';

/**
 * Platform provisioning and tenant-user request schemas (`ADR-0012`, docs/04 §13).
 *
 * The organization name is bounded and normalised (whitespace collapsed, case preserved)
 * so that the stored display form is stable and the derived uniqueness key is
 * deterministic (`models/organization.model.ts`).
 */

export const createOrganizationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Organization name must be at least 2 characters.')
      .max(120, 'Organization name must be at most 120 characters.')
      // Collapse internal whitespace so "Acme  Ltd" and "Acme Ltd" are one tenant.
      .transform((value) => value.replace(/\s+/g, ' ')),
    defaultTimeZone: z.string().trim().min(1).max(64).default('UTC'),
    // The first administrator is created with the tenant and onboarded by invitation;
    // there is deliberately no password field here (docs/04 §13.2, `ADR-0012`).
    administratorEmail: emailSchema,
    administratorName: z.string().trim().min(1).max(120),
  })
  .strict();

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const listOrganizationsQuerySchema = cursorPaginationSchema.strict();

export const inviteUserSchema = z
  .object({
    email: emailSchema,
    roleId: z.string().min(1).max(64),
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
