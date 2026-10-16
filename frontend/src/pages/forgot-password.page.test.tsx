import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { requestPasswordReset } from '../api/auth.api';
import { ForgotPasswordPage } from './forgot-password.page';

/**
 * Forgot-password page tests (docs/06 §5, docs/37 §2).
 *
 * The behaviour under test is a **disclosure rule**, not a layout: the page must never
 * tell the visitor whether an address has an account. A confirmation that appears for a
 * known address and not for an unknown one is an enumeration oracle, which is exactly
 * what the server's unconditional `202` exists to prevent — so it is asserted here.
 */

vi.mock('../api/auth.api', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.api')>('../api/auth.api');
  return { ...actual, requestPasswordReset: vi.fn() };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  it('confirms conditionally, so it cannot confirm that an address exists', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordReset).mockResolvedValue({ status: 'accepted' });

    renderPage();
    await user.type(screen.getByLabelText('Email'), 'lead@initech.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    const confirmation = await screen.findByText(/has a ServiceHub account/);
    expect(confirmation).toBeInTheDocument();
    expect(confirmation).toHaveTextContent(/^If lead@initech\.test has a ServiceHub account/);
  });

  it('rejects an address that is not an address without calling the API', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordReset).mockClear();

    renderPage();
    await user.type(screen.getByLabelText('Email'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit rejection, which is a fact about the caller', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordReset).mockRejectedValue(
      new ApiError(429, {
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        detail: 'Too many authentication attempts. Please try again shortly.',
        instance: '/api/v1/auth/forgot',
        code: 'RATE_LIMITED',
        correlationId: 'corr-1',
      }),
    );

    renderPage();
    await user.type(screen.getByLabelText('Email'), 'lead@initech.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many authentication attempts. Please try again shortly.',
    );
  });

  it('reports a connection failure rather than claiming the email was sent', async () => {
    const user = userEvent.setup();
    // A network failure is not an API rejection: no response ever arrived, so the caller
    // must not be told the reset email is on its way.
    vi.mocked(requestPasswordReset).mockRejectedValue(new Error('socket hang up'));

    renderPage();
    await user.type(screen.getByLabelText('Email'), 'lead@initech.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send the reset email.');
    expect(screen.queryByText(/has a ServiceHub account/)).toBeNull();
  });

  it('returns to the form so a mistyped address can be corrected', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordReset).mockResolvedValue({ status: 'accepted' });

    renderPage();
    await user.type(screen.getByLabelText('Email'), 'lead@initech.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByText(/has a ServiceHub account/);

    await user.click(screen.getByRole('button', { name: 'try another address' }));

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});
