import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { updateItem } from '../api/catalog.api';
import { CatalogPage } from './catalog.page';

/**
 * Catalog page tests (docs/37 §2, docs/21 §9).
 *
 * Two behaviours are under test:
 *
 *   1. **The permission boundary** — a requester sees the catalog but no management
 *      controls, an administrator sees them. The server enforces the same boundary
 *      independently (docs/07 §6); this asserts only that the surface does not offer a
 *      control the caller cannot use, and does not hide one they can.
 *   2. **Editing sends the whole field list.** The server reconciles field definitions as
 *      a *replace* (`catalog.service.ts`), so a payload carrying only the edited field
 *      would silently delete every other one. That is a data-loss bug a screenshot review
 *      cannot see, so it is pinned here (docs/21 §5 C9).
 */

const ITEM_DETAIL = {
  id: 'item-1',
  name: 'Standard laptop',
  description: 'A managed laptop.',
  status: 'ACTIVE' as const,
  defaultPriority: 'MEDIUM' as const,
  requiresApproval: false,
  categoryId: 'cat-1',
  categoryName: 'Hardware',
  defaultSlaPolicyId: null,
  fulfilmentTeamId: null,
  createdAt: new Date().toISOString(),
  defaultSlaPolicy: null,
  fulfilmentTeam: null,
  fields: [
    {
      id: 'field-1',
      key: 'serial',
      label: 'Serial number',
      fieldType: 'TEXT' as const,
      isRequired: true,
      options: null,
      validation: null,
      helpText: null,
      displayOrder: 0,
    },
    {
      id: 'field-2',
      key: 'asset_tag',
      label: 'Asset tag',
      fieldType: 'TEXT' as const,
      isRequired: false,
      options: null,
      validation: null,
      helpText: null,
      displayOrder: 1,
    },
  ],
};

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
  getItem: async () => ({ item: ITEM_DETAIL }),
  createCategory: async () => ({ category: {} }),
  createItem: async () => ({ item: {} }),
  updateItem: vi.fn(async () => ({ item: ITEM_DETAIL })),
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

  it('sends every field definition when an administrator edits one, so none is deleted', async () => {
    const user = userEvent.setup();
    vi.mocked(updateItem).mockClear();

    renderCatalog({
      hasPermission: (permission) =>
        permission === 'catalog:read' || permission === 'catalog:manage',
    });

    // Select the service, then open the editor.
    await user.click(await screen.findByRole('button', { name: /Standard laptop/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit service' }));

    // The editor starts from the saved definitions, not from empty ones.
    expect(screen.getByLabelText('Field 1 key')).toHaveValue('serial');
    expect(screen.getByLabelText('Field 2 key')).toHaveValue('asset_tag');

    const firstLabel = screen.getByLabelText('Field 1 label');
    await user.clear(firstLabel);
    await user.type(firstLabel, 'Serial number (as new)');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(updateItem).mock.calls[0] ?? [];
    expect(id).toBe('item-1');
    expect(payload?.fields).toEqual([
      { key: 'serial', label: 'Serial number (as new)', fieldType: 'TEXT', isRequired: true },
      { key: 'asset_tag', label: 'Asset tag', fieldType: 'TEXT', isRequired: false },
    ]);
  });
});
