import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { KnowledgePanel } from './knowledge-panel';

/**
 * Knowledge panel tests (docs/37 §2, docs/27 §9).
 *
 * The behaviour under test is rule K6 made visible: a link shows the **version applied at
 * the time**, and an archived article still resolves with a banner instead of vanishing.
 */

vi.mock('../api/kb.api', async () => {
  const actual = await vi.importActual<typeof import('../api/kb.api')>('../api/kb.api');
  return {
    ...actual,
    listKnowledgeLinks: async () => ({
      items: [
        {
          id: 'link-1',
          articleId: 'a-1',
          articleVersion: 1,
          title: 'Laptop boot troubleshooting',
          slug: 'laptop-boot-troubleshooting',
          archived: true,
          linkedBody: 'Step one: hold the power button for ten seconds.',
        },
      ],
    }),
    linkArticle: async () => ({ link: { id: 'link-2', articleId: 'a-2', articleVersion: 1 } }),
  };
});

vi.mock('../api/search.api', async () => {
  const actual = await vi.importActual<typeof import('../api/search.api')>('../api/search.api');
  return {
    ...actual,
    search: async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
      fallback: null,
      searchedTypes: [],
    }),
  };
});

function renderPanel(permissions: string[]) {
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
          <KnowledgePanel entityType="INCIDENT" entityId="inc-1" />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('KnowledgePanel', () => {
  it('shows the linked version and the archived banner (rules K6/K7)', async () => {
    renderPanel(['kb:article:read']);

    expect(await screen.findByText('Laptop boot troubleshooting')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('offers the link form only to a caller who may read knowledge', async () => {
    renderPanel([]);
    expect(await screen.findByText('Laptop boot troubleshooting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find' })).toBeNull();
  });
});
