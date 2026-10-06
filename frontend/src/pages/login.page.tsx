import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { useAuth } from '../hooks/auth-context';

/**
 * Sign-in page (docs/06, docs/16).
 *
 * Client validation matches the server's shape so a typo is caught without a round trip,
 * but it is feedback only — the server validates the same input because the client is
 * fully under the user's control (docs/12 §1).
 *
 * The failure message shown is the server's generic "email or password is incorrect",
 * never a distinction between an unknown address and a wrong password: the API does not
 * disclose which, and mirroring it in the UI would recreate the enumeration oracle the
 * server deliberately avoids (docs/06 §3).
 */
const loginFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

export function LoginPage() {
  const { signIn, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: '', password: '' },
  });

  const from = (location.state as { from?: string } | null)?.from ?? '/superadmin';

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(values.email, values.password);
      navigate(from, { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        // `423 ACCOUNT_LOCKED` and `401` both carry a safe, human-readable message.
        setFormError(error.message);
      } else {
        setFormError('Could not sign in. Please check your connection and try again.');
      }
    }
  });

  return (
    <section aria-labelledby="login-heading" className="mx-auto max-w-md space-y-6">
      <div>
        <h1 id="login-heading" className="text-2xl font-semibold text-content">
          Sign in
        </h1>
        <p className="mt-1 text-sm text-content-muted">Use your ServiceHub account.</p>
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

        <div className="space-y-1">
          <label htmlFor="password" className="block text-sm font-medium text-content">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
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

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded bg-brand px-4 py-2 text-content-inverted disabled:opacity-60"
        >
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
