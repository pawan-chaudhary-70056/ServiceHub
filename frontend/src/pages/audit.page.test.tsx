import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { AuditPage } from './audit.page';

/**
 * Audit explorer page tests (docs/31 §11, docs/37 §2).
 *
 * The behaviour under test: entries arrive already scoped and redacted and the page renders
 * them as such — a withheld entry shows a **Redacted** marker rather than an empty diff —
 * and the security-class filter is offered only to a caller who holds the grant.
 */

vi.mock('../api/audit.api', async () => {
  const actual = await vi.importActual<typeof import('../api/audit.api')>('../api/audit.api');
  return {
    ...actual,
    listAudit: vi.fn(async () => ({
      items: [
        {
          id: 'e1',
          action: 'request.status.change',
          actorId: '11111111-1111-1111-1111-111111111111',
          actorType: 'USER' as const,
          entityType: 'ServiceRequest',
          entityId: '22222222-2222-2222-2222-222222222222',
          reason: null,
          before: { status: 'NEW' },
          after: { status: 'OPEN' },
          correlationId: 'corr-1',
          sourceIp: '10.0.0.1',
          userAgent: null,
          occurredAt: new Date().toISOString(),
          security: false,
          redacted: false,
        },
        {
          id: 'e2',
          action: 'login.success',
          actorId: '33333333-3333-3333-3333-333333333333',
          actorType: 'USER' as const,
          entityType: 'Session',
          entityId: null,
          reason: null,
          before: null,
          after: null,
          correlationId: 'corr-2',
          sourceIp: null,
          userAgent: null,
          occurredAt: new Date().toISOString(),
          security: true,
          redacted: true,
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: true,
    })),
  };
});

function renderPage(permissions: string[]) {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Lena Lead',
      email: 'lead@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions,
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => permissions.includes(permission),
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuditPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('AuditPage', () => {
  it('renders entries and marks a withheld security entry as redacted', async () => {
    renderPage(['audit:read.all']);

    expect(await screen.findByText('request.status.change')).toBeInTheDocument();
    expect(screen.getByText('login.success')).toBeInTheDocument();
    // The withheld entry is a marker, not an empty row.
    expect(screen.getByText('Redacted')).toBeInTheDocument();
  });

  it('offers the security-class filter only to a caller who holds the grant', async () => {
    renderPage(['audit:read.all']);
    expect(await screen.findByText('request.status.change')).toBeInTheDocument();
    expect(screen.queryByLabelText('Security class only')).toBeNull();
  });

  it('offers the security-class filter to a caller with audit:read.security', async () => {
    renderPage(['audit:read.all', 'audit:read.security']);
    expect(await screen.findByLabelText('Security class only')).toBeInTheDocument();
  });

  it('offers a load-more control when the page is not exhausted', async () => {
    renderPage(['audit:read.team']);
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});
