import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { KbPage } from './kb.page';

/**
 * Knowledge Base page tests (docs/37 §2, docs/27 §9).
 *
 * The behaviour under test: the list renders what the server returned, including the
 * visibility class the server assigned — the page never filters by visibility itself,
 * because a client-side filter is not a control.
 */

vi.mock('../api/kb.api', async () => {
  const actual = await vi.importActual<typeof import('../api/kb.api')>('../api/kb.api');
  return {
    ...actual,
    listArticles: async () => ({
      items: [
        {
          id: 'a-1',
          title: 'VPN client setup on Windows',
          slug: 'vpn-client-setup-on-windows',
          summary: 'Install and configure the VPN client.',
          status: 'PUBLISHED' as const,
          visibility: 'PUBLIC' as const,
          version: 2,
          category: { id: 'c-1', name: 'Connectivity' },
          reviewDueAt: null,
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'a-2',
          title: 'Restricted runbook',
          slug: 'restricted-runbook',
          summary: null,
          status: 'DRAFT' as const,
          visibility: 'RESTRICTED' as const,
          version: 1,
          category: null,
          reviewDueAt: null,
          updatedAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
    listArticleCategories: async () => ({
      items: [{ id: 'c-1', name: 'Connectivity', parentId: null, articleCount: 1 }],
    }),
  };
});

function renderPage(permissions: string[]) {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Alvin Agent',
      email: 'agent@initech.test',
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
          <KbPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('KbPage', () => {
  it('lists articles with the visibility class the server assigned', async () => {
    renderPage(['kb:article:read']);

    expect(await screen.findByText('VPN client setup on Windows')).toBeInTheDocument();
    expect(screen.getByText('Restricted runbook')).toBeInTheDocument();
    expect(screen.getByText('PUBLIC')).toBeInTheDocument();
    expect(screen.getByText('RESTRICTED')).toBeInTheDocument();
    expect(screen.getByText('Connectivity (1)')).toBeInTheDocument();
  });

  it('offers the authoring form only to a caller who may author', async () => {
    renderPage(['kb:article:read']);
    expect(await screen.findByText('VPN client setup on Windows')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New article' })).toBeNull();
  });

  it('shows the editor to a knowledge author', async () => {
    renderPage(['kb:article:read', 'kb:article:author']);
    expect(await screen.findByRole('button', { name: 'New article' })).toBeInTheDocument();
  });
});
