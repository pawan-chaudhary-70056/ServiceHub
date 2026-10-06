import { z } from 'zod';

/**
 * SLA policy, target and calendar request schemas (docs/25, docs/12, ADR-0008).
 *
 * These schemas protect the two things SLA reporting depends on: a **valid IANA time
 * zone** (all arithmetic happens in the calendar's zone — docs/25 §4 rule 1) and
 * **positive targets** (a zero-minute target is not a policy, it is a permanent breach).
 */

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM in 24-hour form.');

const workingWindow = z
  .object({ start: timeOfDay, end: timeOfDay })
  .strict()
  .superRefine((window, ctx) => {
    if (window.start >= window.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'A working window must end after it starts.',
      });
    }
  });

const workingHoursSchema = z
  .record(z.enum(WEEKDAYS), z.array(workingWindow).max(4))
  .refine((hours) => Object.keys(hours).length > 0, 'At least one working day is required.');

const holidaysSchema = z
  .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Holiday must be an ISO date (YYYY-MM-DD).'))
  .max(366);

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    try {
      // An unknown zone throws; catching it here keeps an invalid zone out of the
      // database, where it would later break every clock computation for the policy.
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unknown time zone. Use an IANA zone such as Europe/London.',
      });
    }
  });

export const createBusinessCalendarSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    timeZone: timeZoneSchema,
    model: z.enum(['WORKING_HOURS', 'WALL_CLOCK']).default('WORKING_HOURS'),
    workingHours: workingHoursSchema,
    holidays: holidaysSchema.default([]),
  })
  .strict();

export type CreateBusinessCalendarInput = z.infer<typeof createBusinessCalendarSchema>;

const slaTargetSchema = z
  .object({
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    responseMinutes: z.number().int().positive().max(525_600),
    resolveMinutes: z.number().int().positive().max(525_600),
    warnPercent: z.number().int().min(1).max(99).default(75),
  })
  .strict()
  .refine(
    (target) => target.responseMinutes <= target.resolveMinutes,
    'Response target cannot exceed the resolution target.',
  );

export const createSlaPolicySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    calendarId: z.string().min(1).max(64),
    pauseStates: z
      .array(
        z.enum([
          'NEW',
          'TRIAGED',
          'APPROVAL_PENDING',
          'APPROVED',
          'REJECTED',
          'IN_PROGRESS',
          'FULFILLED',
          'CLOSED',
          'CANCELLED',
        ]),
      )
      .max(9)
      .default([]),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    targets: z.array(slaTargetSchema).min(1, 'A policy needs at least one priority target.').max(4),
  })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.targets.map((target) => target.priority)).size === policy.targets.length,
    'A priority may appear only once in a policy target set.',
  );

export type CreateSlaPolicyInput = z.infer<typeof createSlaPolicySchema>;

export const updateSlaPolicySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    calendarId: z.string().min(1).max(64).optional(),
    pauseStates: z.array(z.string().min(1).max(40)).max(9).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    targets: z.array(slaTargetSchema).min(1).max(4).optional(),
  })
  .strict();
