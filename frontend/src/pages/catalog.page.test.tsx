import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { CatalogPage } from './catalog.page';

/**
 * Catalog page tests (docs/37 §2, docs/21 §9).
 *
 * The behaviour under test is the permission boundary: a requester sees the catalog but
 * no management controls, while an administrator sees the controls. The server enforces
 * the same boundary independently (docs/07 §6) — this only asserts the surface does not
 * offer a control the caller cannot use, and does not hide one they can.
 */

vi.mock('../api/catalog.api', () => ({
  listCategories: async () => ({
    items: [
      {
        id: 'cat-1',
        name: 'Hardware',
        parentId: null,
        description: null,
        displayOrder: 0,
        isActive: true,
        itemCount: 1,
      },
    ],
  }),
  listItems: async () => ({
    items: [
      {
        id: 'item-1',
        name: 'Standard laptop',
        description: 'A managed laptop.',
        status: 'ACTIVE',
        defaultPriority: 'MEDIUM',
        requiresApproval: false,
        categoryId: 'cat-1',
        categoryName: 'Hardware',
        defaultSlaPolicyId: null,
        fulfilmentTeamId: null,
        createdAt: new Date().toISOString(),
      },
    ],
    nextCursor: null,
    hasMore: false,
  }),
  getItem: async () => ({ item: undefined }),
  createCategory: async () => ({ category: {} }),
  createItem: async () => ({ item: {} }),
  updateItem: async () => ({ item: {} }),
  activateItem: async () => ({ item: {} }),
  retireItem: async () => ({ item: {} }),
}));

vi.mock('../api/sla.api', () => ({ listPolicies: async () => ({ items: [] }) }));
vi.mock('../api/teams.api', () => ({ listTeams: async () => ({ items: [] }) }));

function renderCatalog(overrides: Partial<AuthContextValue>) {
  const auth: AuthContextValue = {
    user: null,
    permissions: [],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: () => false,
    signIn: async () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <CatalogPage />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('CatalogPage', () => {
  it('shows a requester the catalog without management controls', async () => {
    renderCatalog({ hasPermission: (permission) => permission === 'catalog:read' });

    expect(await screen.findByText('Standard laptop')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '+ New service' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('New category')).not.toBeInTheDocument();
  });

  it('shows an administrator the management controls', async () => {
    renderCatalog({
      hasPermission: (permission) =>
        permission === 'catalog:read' || permission === 'catalog:manage',
    });

    expect(await screen.findByText('Standard laptop')).toBeInTheDocument();
    expect(screen.getByText('New category')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New service' })).toBeInTheDocument();
  });
});
