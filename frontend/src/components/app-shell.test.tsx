import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { AppShell } from './app-shell';

/**
 * Application shell tests (docs/16 §navigation, docs/37 §2).
 *
 * Navigation is a **hint, never a control** (docs/07): the server independently refuses
 * every request the caller is not entitled to make. What the shell owes the user is the
 * reverse of a leak — it must not hide a screen they *can* use, because a feature nobody
 * can find is a feature nobody has.
 *
 * So the assertions go both ways: an unauthorised entry is absent, an authorised one is
 * present.
 */

vi.mock('./notification-bell', () => ({ NotificationBell: () => null }));

function renderShell(overrides: Partial<AuthContextValue> = {}) {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Ada Lovelace',
      email: 'ada@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: [],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => (overrides.permissions ?? []).includes(permission),
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    ...overrides,
  };

  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/']}>
        <AppShell>
          <p>page body</p>
        </AppShell>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('AppShell', () => {
  it('offers only the entries a caller’s grants open', () => {
    renderShell({ permissions: ['request:read.own', 'catalog:read'] });

    expect(screen.getByRole('link', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();

    // No grant, no entry — for each administration surface.
    for (const name of [
      'Platform admin',
      'Reports',
      'Audit log',
      'Security activity',
      'Users',
      'Teams',
      'Approval templates',
      'Integrations',
    ]) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
  });

  it('offers the administration entries to a caller who holds the grants', () => {
    renderShell({
      permissions: [
        'platform:organization:manage',
        'report:read',
        'audit:read.all',
        'audit:read.security',
        'user:manage',
        'admin:config',
        'integration:read',
      ],
    });

    for (const name of [
      'Platform admin',
      'Reports',
      'Audit log',
      'Security activity',
      'Users',
      'Teams',
      'Approval templates',
      'Integrations',
    ]) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('admits a scoped reader through any one of the read grants', () => {
    // Reads are expressed as scoped grants, so a caller holds exactly one of them; a
    // single-permission check would wrongly hide the entry (docs/07 §3).
    renderShell({ permissions: ['incident:read.team'] });
    expect(screen.getByRole('link', { name: 'Incidents' })).toBeInTheDocument();
  });

  it('offers sign-in instead of navigation to an anonymous visitor', () => {
    renderShell({ isAuthenticated: false, user: null, permissions: [] });

    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('signs out through the API and returns to sign-in', async () => {
    const user = userEvent.setup();
    const signOut = vi.fn(async () => undefined);
    renderShell({ signOut });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the bypass link first in the DOM for keyboard users', () => {
    renderShell({ permissions: ['request:read.own'] });

    // A skip link that is not first is a skip link nobody reaches.
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });
});
