import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { acceptInvitation } from '../api/auth.api';
import { ApiError } from '../api/client';

/**
 * Invitation acceptance (docs/06 §11, docs/04 §13.3).
 *
 * This page establishes the **first** credential for an invited identity; it is not a
 * sign-up form. The token in the link is single-use and grants no authority by itself —
 * the identity exists INACTIVE until a credential is set, and the server enforces every
 * rejection identically so this page cannot probe which addresses hold an invite.
 */
const acceptFormSchema = z
  .object({
    displayName: z.string().trim().max(120, 'Name is limited to 120 characters.').optional(),
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

type AcceptFormValues = z.infer<typeof acceptFormSchema>;

export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [formError, setFormError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AcceptFormValues>({
    resolver: zodResolver(acceptFormSchema),
    defaultValues: { displayName: '', password: '', confirm: '' },
  });

  if (!token) {
    return (
      <section aria-labelledby="invite-heading" className="mx-auto max-w-md space-y-3">
        <h1 id="invite-heading" className="text-2xl font-semibold text-content">
          Invitation
        </h1>
        <p role="alert" className="text-content-muted">
          This invitation link is incomplete. Request a new invitation from your administrator.
        </p>
      </section>
    );
  }

  if (accepted) {
    return (
      <section aria-labelledby="invite-heading" className="mx-auto max-w-md space-y-3">
        <h1 id="invite-heading" className="text-2xl font-semibold text-content">
          Account ready
        </h1>
        <p className="text-content-muted">Your account is active. You can now sign in.</p>
        <Link to="/login" className="inline-block text-brand underline">
          Go to sign in
        </Link>
      </section>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await acceptInvitation(token, values.password, values.displayName || undefined);
      setAccepted(true);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Could not complete your invitation. Please try again.');
      }
    }
  });

  return (
    <section aria-labelledby="invite-heading" className="mx-auto max-w-md space-y-6">
      <div>
        <h1 id="invite-heading" className="text-2xl font-semibold text-content">
          Set up your account
        </h1>
        <p className="mt-1 text-sm text-content-muted">
          Choose a password to activate your account.
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
          <label htmlFor="displayName" className="block text-sm font-medium text-content">
            Display name <span className="text-content-muted">(optional)</span>
          </label>
          <input
            id="displayName"
            type="text"
            autoComplete="name"
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            {...register('displayName')}
          />
          {errors.displayName && (
            <p className="text-sm text-danger">{errors.displayName.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm font-medium text-content">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            {...register('password')}
          />
          {errors.password && <p className="text-sm text-danger">{errors.password.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="confirm" className="block text-sm font-medium text-content">
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirm ? true : undefined}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            {...register('confirm')}
          />
          {errors.confirm && <p className="text-sm text-danger">{errors.confirm.message}</p>}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
        >
          {isSubmitting ? 'Activating…' : 'Activate account'}
        </button>
      </form>
    </section>
  );
}
