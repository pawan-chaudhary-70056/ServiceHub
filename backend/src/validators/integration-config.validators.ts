import { z } from 'zod';

/**
 * Integration configuration request schemas (`docs/32` §7/§11, `docs/12`).
 *
 * The reliability knobs are the tunable half of §8's patterns — breaker thresholds, bulkhead
 * bounds and retry/timeout overrides. The schema owns the *shape and bounds*; the service
 * owns which integration keys exist and what a credential reference may look like, because
 * both need the catalogue rather than a literal.
 *
 * `credentialRef` is typed as a string, not a URL or a token: it names where a secret lives
 * (`env:NAME`). The service rejects anything that is not a reference, so a client cannot use
 * this field to persist a secret (`17` §3).
 */

/** All knobs optional; each has a bounded range so a misconfiguration cannot disable the guard. */
export const reliabilityConfigSchema = z
  .object({
    breakerFailureThreshold: z.coerce.number().int().min(1).max(100).optional(),
    breakerOpenMs: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30 * 60_000)
      .optional(),
    breakerHalfOpenSuccesses: z.coerce.number().int().min(1).max(10).optional(),
    bulkheadMaxConcurrent: z.coerce.number().int().min(1).max(500).optional(),
    bulkheadMaxQueue: z.coerce.number().int().min(0).max(10_000).optional(),
    bulkheadQueueTimeoutMs: z.coerce.number().int().min(100).max(60_000).optional(),
    retryMaxAttempts: z.coerce.number().int().min(1).max(20).optional(),
    timeoutMs: z.coerce.number().int().min(250).max(60_000).optional(),
  })
  .strict();

export type IntegrationReliabilityConfig = z.infer<typeof reliabilityConfigSchema>;

export const updateIntegrationConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: reliabilityConfigSchema.optional(),
    /** A reference such as `env:SENDGRID_API_KEY`, or `null` to clear it. Never a secret. */
    credentialRef: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change.',
  });

export type UpdateIntegrationConfigBody = z.infer<typeof updateIntegrationConfigSchema>;

/** The integration key is a catalogue key, so it is a safe, bounded path segment. */
export const integrationKeyParamsSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'Integration key format is invalid.'),
});
