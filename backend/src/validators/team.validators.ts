import { z } from 'zod';
import { idParam } from './index';

/**
 * Team administration schemas (docs/07 §6, docs/12).
 *
 * `role` is a closed set matching the `TeamMemberRole` enum: a free-text role would let
 * an unknown value reach the database and fail as a 500 instead of a 422.
 */

export const createTeamSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const teamParamsSchema = z.object({ id: idParam });

export const teamMemberParamsSchema = z.object({ id: idParam, userId: idParam });

export const addTeamMemberSchema = z
  .object({
    userId: idParam,
    role: z.enum(['MEMBER', 'LEAD']).default('MEMBER'),
  })
  .strict();

export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
