import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { LoginPage } from './login.page';

/**
 * Sign-in page tests (docs/06, docs/14).
 *
 * Two behaviours that a screenshot review would not catch:
 *
 *   1. **The post-sign-in landing must work for every identity.** It previously defaulted
 *      to `/superadmin`, so a tenant member was shown "Access denied" the instant they
 *      signed in successfully. The landing route is a correctness property, not a styling
 *      preference, so it is asserted.
 *   2. **The reset flow must be reachable from sign-in.** A user who cannot sign in has no
 *      other surface from which to start a reset (docs/06 §5).
 */

function renderPage() {
  const auth: AuthContextValue = {
    user: null,
    permissions: [],
    isLoading: false,
    isAuthenticated: false,
    hasPermission: () => false,
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
  };

  return {
    auth,
    ...render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>home-landing</p>} />
            <Route path="/superadmin" element={<p>superadmin-landing</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    ),
  };
}

describe('LoginPage', () => {
  it('lands a signed-in user on the home page, not on platform administration', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'lead@initech.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('home-landing')).toBeInTheDocument();
    expect(screen.queryByText('superadmin-landing')).toBeNull();
  });

  it('offers the password-reset route', () => {
    renderPage();

    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});
