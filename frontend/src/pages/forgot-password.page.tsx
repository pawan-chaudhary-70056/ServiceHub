import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { requestPasswordReset } from '../api/auth.api';
import { ApiError } from '../api/client';

/**
 * Forgot-password request (docs/06 §5, docs/14).
 *
 * The page exists because the reset email the server sends links to `/reset-password`,
 * and a user who has forgotten their password has no other way to start the flow.
 *
 * Two rules shape what this page may say:
 *
 *   - **It never confirms whether an address has an account.** The server answers `202`
 *     for a known and an unknown address alike (`docs/06` §5); if the UI showed "we sent
 *     you an email" only for a recognised address, it would recreate the enumeration
 *     oracle the server deliberately avoids. The confirmation is therefore conditional
 *     in its wording ("If … has an account"), never in its presence.
 *   - **A real error is still reported.** A `429` from the credential rate limiter is a
 *     fact about the caller, not about the address, so surfacing it leaks nothing and
 *     hiding it would leave a user retrying a form that cannot succeed.
 */
const forgotFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.'),
});

type ForgotFormValues = z.infer<typeof forgotFormSchema>;

export function ForgotPasswordPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotFormValues>({
    resolver: zodResolver(forgotFormSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await requestPasswordReset(values.email);
      setSubmittedEmail(values.email);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Could not send the reset email. Please check your connection and try again.');
      }
    }
  });

  if (submittedEmail) {
    return (
      <section aria-labelledby="forgot-heading" className="mx-auto max-w-md space-y-6">
        <div>
          <h1 id="forgot-heading" className="text-2xl font-semibold text-content">
            Check your email
          </h1>
          <p className="mt-1 text-sm text-content-muted">
            If {submittedEmail} has a ServiceHub account, a password reset link is on its way. The
            link is valid for one hour.
          </p>
        </div>

        <p className="text-sm text-content-muted">
          Nothing arrived? Check your spam folder, then{' '}
          <button
            type="button"
            onClick={() => setSubmittedEmail(null)}
            className="text-brand underline"
          >
            try another address
          </button>
          .
        </p>

        <Link to="/login" className="inline-block text-brand underline">
          Back to sign in
        </Link>
      </section>
    );
  }

  return (
    <section aria-labelledby="forgot-heading" className="mx-auto max-w-md space-y-6">
      <div>
        <h1 id="forgot-heading" className="text-2xl font-semibold text-content">
          Reset your password
        </h1>
        <p className="mt-1 text-sm text-content-muted">
          Enter your email address and we will send you a link to choose a new password.
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
          <label htmlFor="email" className="block text-sm font-medium text-content">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            {...register('email')}
          />
          {errors.email && (
            <p id="email-error" className="text-sm text-danger">
              {errors.email.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
        >
          {isSubmitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <Link to="/login" className="inline-block text-sm text-brand underline">
        Back to sign in
      </Link>
    </section>
  );
}
