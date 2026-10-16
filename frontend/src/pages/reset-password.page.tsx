import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { resetPassword } from '../api/auth.api';
import { ApiError } from '../api/client';

/**
 * Complete a password reset (docs/06 §5, docs/14).
 *
 * **This route must stay at `/reset-password` and read its token from `?token=`**: that is
 * exactly the URL the server puts in the reset email (`services/auth.service.ts` builds
 * `${APP_BASE_URL}/reset-password?token=…`). Renaming the route breaks the flow in a way
 * no unit test would catch, because nothing else in the SPA references the path.
 *
 * The token is single-use and expires after an hour. It grants no authority on its own —
 * it authorises one password change and nothing else — so an expired or already-used
 * token is a normal, expected outcome that the page reports plainly rather than treating
 * as a crash. Completing the reset revokes every existing session server-side, which is
 * why the success state sends the user back to sign in instead of logging them in.
 *
 * Client validation mirrors the server's policy (`helpers/password.ts`, docs/12 §4) for
 * immediate feedback only; the server re-checks it.
 */
const resetFormSchema = z
  .object({
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters.')
      .max(128, 'Password must be at most 128 characters.'),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match.',
  })
  .refine((values) => values.password.trim() === values.password, {
    path: ['password'],
    message: 'Password must not begin or end with whitespace.',
  });

type ResetFormValues = z.infer<typeof resetFormSchema>;

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [formError, setFormError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetFormValues>({
    resolver: zodResolver(resetFormSchema),
    defaultValues: { password: '', confirm: '' },
  });

  if (!token) {
    return (
      <section aria-labelledby="reset-heading" className="mx-auto max-w-md space-y-3">
        <h1 id="reset-heading" className="text-2xl font-semibold text-content">
          Reset your password
        </h1>
        <p role="alert" className="text-content-muted">
          This reset link is incomplete. Request a new one and use the link from the email.
        </p>
        <Link to="/forgot-password" className="inline-block text-brand underline">
          Request a new reset link
        </Link>
      </section>
    );
  }

  if (complete) {
    return (
      <section aria-labelledby="reset-heading" className="mx-auto max-w-md space-y-3">
        <h1 id="reset-heading" className="text-2xl font-semibold text-content">
          Password updated
        </h1>
        <p className="text-content-muted">
          Your password has been changed and any other sessions have been signed out. Sign in with
          your new password.
        </p>
        <Link to="/login" className="inline-block text-brand underline">
          Go to sign in
        </Link>
      </section>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await resetPassword(token, values.password);
      setComplete(true);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Could not reset your password. Please try again.');
      }
    }
  });

  return (
    <section aria-labelledby="reset-heading" className="mx-auto max-w-md space-y-6">
      <div>
        <h1 id="reset-heading" className="text-2xl font-semibold text-content">
          Choose a new password
        </h1>
        <p className="mt-1 text-sm text-content-muted">
          Use at least 12 characters. You will be signed out of your other sessions.
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <p
            role="alert"
            className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {formError}
          </p>
        )}

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm font-medium text-content">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            {...register('password')}
          />
          {errors.password && (
            <p id="password-error" className="text-sm text-danger">
              {errors.password.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="confirm" className="block text-sm font-medium text-content">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={errors.confirm ? 'confirm-error' : undefined}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            {...register('confirm')}
          />
          {errors.confirm && (
            <p id="confirm-error" className="text-sm text-danger">
              {errors.confirm.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
        >
          {isSubmitting ? 'Saving…' : 'Set new password'}
        </button>
      </form>

      {formError && (
        <Link to="/forgot-password" className="inline-block text-sm text-brand underline">
          Request a new reset link
        </Link>
      )}
    </section>
  );
}
