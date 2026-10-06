import { z } from 'zod';
import { config } from '../config';

/**
 * Authentication request schemas (docs/12, docs/11 §9).
 *
 * Strict by default (docs/12 §2): an unknown field is rejected rather than silently
 * dropped, which is both a mass-assignment defence and a way to surface client bugs.
 * Email is trimmed and lower-cased by the schema (`docs/12 §3`), so the same address in
 * different case is the same identity before it ever reaches a query.
 */

/** Trimmed, lower-cased email with a bound — never unbounded (docs/12 §4). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address.');

/**
 * Password is bounded but **not** trimmed: leading/trailing whitespace is part of the
 * secret, and silently stripping it would make two different passwords interchangeable.
 * The policy itself is enforced in the service (`helpers/password.ts`), because it needs
 * the identity context for the name/email checks.
 */
export const passwordSchema = z
  .string()
  .min(
    config.PASSWORD_MIN_LENGTH,
    `Password must be at least ${config.PASSWORD_MIN_LENGTH} characters.`,
  )
  .max(
    config.PASSWORD_MAX_LENGTH,
    `Password must be at most ${config.PASSWORD_MAX_LENGTH} characters.`,
  );

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Enter your password.').max(config.PASSWORD_MAX_LENGTH),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({ token: z.string().min(20).max(512), password: passwordSchema })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(20).max(512),
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
