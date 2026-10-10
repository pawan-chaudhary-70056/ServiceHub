import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { SecurityPage } from './security.page';

/**
 * Account security page tests (docs/37 §2, docs/06 §7).
 *
 * What the page is responsible for: labelling the **current** session so a user does not
 * revoke the wrong row, showing only what the server returned, and surfacing a refusal
 * instead of silently doing nothing.
 */

const revokeSession = vi.fn();

vi.mock('../api/auth.api', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.api')>('../api/auth.api');
  return {
    ...actual,
    listSessions: async () => ({
      items: [
        {
          id: 's-1',
          createdAt: '2026-10-09T08:00:00.000Z',
          lastSeenAt: '2026-10-09T09:30:00.000Z',
          idleExpiresAt: '2026-10-09T10:00:00.000Z',
          absoluteExpiresAt: '2026-10-09T20:00:00.000Z',
          sourceIp: '203.0.113.10',
          userAgent: 'Mozilla/5.0 (Macintosh) Safari/605',
          current: true,
        },
        {
          id: 's-2',
          createdAt: '2026-10-08T07:00:00.000Z',
          lastSeenAt: '2026-10-08T07:05:00.000Z',
          idleExpiresAt: '2026-10-08T07:35:00.000Z',
          absoluteExpiresAt: '2026-10-08T19:00:00.000Z',
          sourceIp: '198.51.100.4',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
          current: false,
        },
      ],
    }),
    revokeSession: (...args: unknown[]) => revokeSession(...args),
  };
});

function renderPage() {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Alice Requester',
      email: 'alice@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: [],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: () => true,
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SecurityPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('SecurityPage', () => {
  it('lists the caller’s sessions and marks the current one', async () => {
    renderPage();

    expect(await screen.findByText('Alice Requester')).toBeInTheDocument();
    expect(await screen.findByText('This device')).toBeInTheDocument();

    const revokeButtons = screen.getAllByRole('button', { name: /sign out/i });
    expect(revokeButtons).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Sign out this device' })).toBeInTheDocument();

    // The device label is derived from what the server reported, never invented.
    expect(screen.getByText(/203\.0\.113\.10/)).toBeInTheDocument();
    expect(screen.getByText(/198\.51\.100\.4/)).toBeInTheDocument();
  });

  it('revokes the session the user chose', async () => {
    revokeSession.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    const other = await screen.findByText(/198\.51\.100\.4/);
    const row = other.closest('li');
    const button = row?.querySelector('button');
    expect(button).not.toBeNull();
    await user.click(button as HTMLButtonElement);

    await vi.waitFor(() => expect(revokeSession).toHaveBeenCalledWith('s-2'));
  });

  it('shows a refusal rather than silently failing', async () => {
    revokeSession.mockRejectedValue(
      new ApiError(404, {
        type: 'about:blank',
        title: 'Not found',
        status: 404,
        detail: 'Session not found.',
        instance: '/api/v1/auth/sessions/s-2',
        code: 'NOT_FOUND',
        correlationId: 'corr-1',
      }),
    );
    const user = userEvent.setup();
    renderPage();

    const other = await screen.findByText(/198\.51\.100\.4/);
    const button = other.closest('li')?.querySelector('button');
    await user.click(button as HTMLButtonElement);

    expect(await screen.findByRole('alert')).toHaveTextContent('Session not found.');
  });
});
