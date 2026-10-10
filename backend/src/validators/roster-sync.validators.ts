import { z } from 'zod';

/**
 * Roster sync request schemas (`docs/32` §6, `docs/12`).
 *
 * The only input is the operator's confirmation that a large removal is intended. Everything
 * else — the roster's shape — is the directory's, validated by the adapter and the mapping
 * rules, never by this boundary.
 */
export const rosterSyncSchema = z
  .object({
    confirmDrift: z.boolean().optional(),
  })
  .strict();

export type RosterSyncBody = z.infer<typeof rosterSyncSchema>;
