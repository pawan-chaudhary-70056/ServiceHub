import { z } from 'zod';

/**
 * Notification centre and preference schemas (`docs/29` §7/§12, docs/12).
 *
 * The event type is validated against the catalogue in the service (a closed, code-defined
 * set that changes with the code, not a client-supplied string), so the schema bounds its
 * length here and the service refuses an unknown one with a field error.
 */

export const notificationChannelSchema = z.enum(['EMAIL', 'SMS', 'IN_APP']);

export const updatePreferencesSchema = z
  .object({
    preferences: z
      .array(
        z
          .object({
            eventType: z.string().trim().min(1).max(120),
            channel: notificationChannelSchema,
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export const notificationListQuerySchema = z
  .object({
    unreadOnly: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce.number().int().positive().max(100).default(25),
    cursor: z.string().max(256).optional(),
  })
  .strict();

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
