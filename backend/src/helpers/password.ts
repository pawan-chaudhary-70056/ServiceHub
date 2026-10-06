import { config } from '../config';
import type { ProblemDetail } from '../utils/errors';

/**
 * Password policy (docs/06 §4, docs/12 §4).
 *
 * The policy is checked at the service boundary, not only in a route schema, because
 * the same rule applies to reset, invitation acceptance and administrative change.
 * Returning `ProblemDetail[]` keeps the failure a `422 VALIDATION_FAILED` with
 * field-level detail, so a form can place the message on the password input.
 *
 * This is a *policy* check, not a strength guarantee. The mandated control is the
 * breached-password check (`FR-AUTH-004`), which is a later integration; the length
 * and construction rules here are what can be enforced without one.
 */
export function validatePasswordPolicy(
  password: string,
  context: { email?: string; displayName?: string } = {},
): ProblemDetail[] {
  const problems: ProblemDetail[] = [];
  const min = config.PASSWORD_MIN_LENGTH;
  const max = config.PASSWORD_MAX_LENGTH;

  if (password.length < min) {
    problems.push({
      field: 'password',
      code: 'TOO_SHORT',
      message: `Password must be at least ${min} characters.`,
    });
  }

  if (password.length > max) {
    problems.push({
      field: 'password',
      code: 'TOO_LONG',
      message: `Password must be at most ${max} characters.`,
    });
  }

  if (password.trim().length !== password.length) {
    problems.push({
      field: 'password',
      code: 'LEADING_OR_TRAILING_SPACE',
      message: 'Password must not begin or end with whitespace.',
    });
  }

  // These are hints an attacker with a leaked list already has; trivially guessable
  // passwords built from them are the first thing a credential-stuffing run tries.
  if (context.email) {
    const local = context.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && password.toLowerCase().includes(local)) {
      problems.push({
        field: 'password',
        code: 'CONTAINS_EMAIL',
        message: 'Password must not contain your email address.',
      });
    }
  }

  if (context.displayName) {
    const name = context.displayName.toLowerCase();
    if (name.length >= 4 && password.toLowerCase().includes(name)) {
      problems.push({
        field: 'password',
        code: 'CONTAINS_NAME',
        message: 'Password must not contain your name.',
      });
    }
  }

  return problems;
}
