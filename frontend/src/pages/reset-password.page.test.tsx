import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { resetPassword } from '../api/auth.api';
import { ApiError } from '../api/client';
import { ResetPasswordPage } from './reset-password.page';

/**
 * Reset-password page tests (docs/06 §5, docs/37 §2).
 *
 * The token is read from `?token=`, because that is the query parameter the server writes
 * into the reset email. The tests therefore drive the page through `MemoryRouter` entries
 * rather than passing a prop — if the parameter name drifts, these fail, which is the
 * point: nothing else in the SPA references this URL, so nothing else would catch it.
 */

vi.mock('../api/auth.api', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.api')>('../api/auth.api');
  return { ...actual, resetPassword: vi.fn() };
});

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  it('explains an incomplete link instead of rendering an unusable form', () => {
    renderPage('/reset-password');

    expect(screen.getByRole('alert')).toHaveTextContent('This reset link is incomplete.');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('refuses a mismatched confirmation before calling the API', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPassword).mockClear();

    renderPage('/reset-password?token=t0ken');
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('Confirm new password'), 'correct-horse-batteryX');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('enforces the server password policy without a round trip', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPassword).mockClear();

    renderPage('/reset-password?token=t0ken');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('completes the reset with the token from the URL and sends the user back to sign in', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPassword).mockResolvedValue(undefined);

    renderPage('/reset-password?token=t0ken');
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('Confirm new password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Password updated')).toBeInTheDocument();
    expect(resetPassword).toHaveBeenCalledWith('t0ken', 'correct-horse-battery');
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
  });

  it('reports an expired or already-used token in the server’s words', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPassword).mockRejectedValue(
      new ApiError(422, {
        type: 'about:blank',
        title: 'Validation failed',
        status: 422,
        detail: 'This reset link is invalid, expired, or has already been used.',
        instance: '/api/v1/auth/reset',
        code: 'VALIDATION_FAILED',
        correlationId: 'corr-2',
      }),
    );

    renderPage('/reset-password?token=stale');
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('Confirm new password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This reset link is invalid, expired, or has already been used.',
    );
    // A dead link must offer the way out, not just the error.
    expect(screen.getByRole('link', { name: 'Request a new reset link' })).toBeInTheDocument();
  });

  it('reports a connection failure without claiming the password changed', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPassword).mockRejectedValue(new Error('socket hang up'));

    renderPage('/reset-password?token=t0ken');
    await user.type(screen.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('Confirm new password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reset your password. Please try again.',
    );
    expect(screen.queryByText('Password updated')).toBeNull();
  });
});
