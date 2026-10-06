import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { RequireAuth } from './require-auth';

/**
 * Route guard tests (docs/37 §2).
 *
 * The guard is a UX convenience, not a control (docs/07) — but it must still do its one
 * job correctly: an unauthenticated visitor is sent to sign in, an authenticated one
 * without the permission sees a clear refusal rather than a broken screen, and a
 * permitted one sees the content.
 */

function renderGuarded(overrides: Partial<AuthContextValue>) {
  const value: AuthContextValue = {
    user: null,
    permissions: [],
    isLoading: false,
    isAuthenticated: false,
    hasPermission: () => false,
    signIn: async () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };

  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route path="/login" element={<p>login page</p>} />
          <Route
            path="/secret"
            element={
              <RequireAuth permission="platform:organization:manage">
                <p>secret content</p>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('RequireAuth', () => {
  it('redirects an unauthenticated visitor to sign in', () => {
    renderGuarded({});
    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('shows a clear access-denied message when the permission is missing', () => {
    renderGuarded({ isAuthenticated: true, permissions: [], hasPermission: () => false });
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('renders the content when the caller holds the permission', () => {
    renderGuarded({
      isAuthenticated: true,
      permissions: ['platform:organization:manage'],
      hasPermission: (permission) => permission === 'platform:organization:manage',
    });
    expect(screen.getByText('secret content')).toBeInTheDocument();
  });

  it('shows a session-check state while identity is loading', () => {
    renderGuarded({ isLoading: true });
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
  });
});
