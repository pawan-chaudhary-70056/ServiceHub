import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listNotifications } from '../api/notifications.api';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { NotificationBell } from './notification-bell';

/**
 * Notification bell tests (docs/29 §13, docs/37 §2).
 *
 * The count is a **hint, not a control** (docs/07) — but a hint that is wrong is worse
 * than absent, so the two branches that matter are pinned: the count appears when there is
 * something unread, and the accessible name does not become a bare number when there is
 * not. A screen-reader user hears the link, never a floating digit.
 */

vi.mock('../api/notifications.api', () => ({ listNotifications: vi.fn() }));

function renderBell(overrides: Partial<AuthContextValue> = {}): void {
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
    hasPermission: () => false,
    signIn: async () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <NotificationBell />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotificationBell', () => {
  it('announces the unread count in the accessible name', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ items: [], unreadCount: 3 } as never);
    renderBell();

    const link = await screen.findByRole('link', { name: 'Notifications, 3 unread' });
    expect(link).toHaveAttribute('href', '/notifications');
    expect(link).toHaveTextContent('3');
  });

  it('drops the count from the accessible name when nothing is unread', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ items: [], unreadCount: 0 } as never);
    renderBell();

    // `getByRole` with the exact name proves the *accessible* name has no number in it —
    // which is the assertion that matters to a screen-reader user.
    expect(await screen.findByRole('link', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('asks the server for unread notifications only', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ items: [], unreadCount: 0 } as never);
    renderBell();

    await screen.findByRole('link', { name: 'Notifications' });
    expect(listNotifications).toHaveBeenCalledWith(
      { unreadOnly: true, limit: 1 },
      expect.anything(),
    );
  });

  it('renders nothing at all for an anonymous visitor', () => {
    vi.mocked(listNotifications).mockResolvedValue({ items: [], unreadCount: 0 } as never);
    renderBell({ isAuthenticated: false, user: null });

    expect(screen.queryByRole('link', { name: /Notifications/ })).toBeNull();
  });
});
