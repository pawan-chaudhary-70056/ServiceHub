import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { SecurityActivityPage } from './security-activity.page';

/**
 * Security activity page tests (docs/31 §11).
 *
 * This surface is the security class only, and the endpoint it calls accepts no filters.
 * The page therefore must not offer the explorer's filter form — a filter that the server
 * rejects is worse than no filter, because it looks like it worked.
 */

vi.mock('../api/audit.api', async () => {
  const actual = await vi.importActual<typeof import('../api/audit.api')>('../api/audit.api');
  return {
    ...actual,
    listSecurityAudit: vi.fn(async () => ({
      items: [
        {
          id: 's1',
          action: 'authz.denied',
          actorId: '44444444-4444-4444-4444-444444444444',
          actorType: 'USER' as const,
          entityType: 'AuditLog',
          entityId: null,
          reason: 'insufficient permission',
          before: null,
          after: null,
          correlationId: 'corr-9',
          sourceIp: '10.1.2.3',
          userAgent: null,
          occurredAt: new Date().toISOString(),
          security: true,
          redacted: false,
        },
      ],
      nextCursor: null,
      hasMore: false,
    })),
  };
});

function renderPage() {
  const auth: AuthContextValue = {
    user: {
      id: 'u-9',
      displayName: 'Sam Security',
      email: 'security@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: ['audit:read.all', 'audit:read.security'],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) =>
      ['audit:read.all', 'audit:read.security'].includes(permission),
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SecurityActivityPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('SecurityActivityPage', () => {
  it('renders security-class entries without the explorer filter form', async () => {
    renderPage();

    expect(await screen.findByText('authz.denied')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Security activity' })).toBeInTheDocument();
    // No filters: the endpoint is unfiltered, so offering them would be a lie.
    expect(screen.queryByLabelText('Action')).toBeNull();
  });
});
