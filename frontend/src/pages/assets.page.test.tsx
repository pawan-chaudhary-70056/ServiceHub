import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { AssetsPage } from './assets.page';

/**
 * Asset register page tests (docs/37 §2, docs/28 §9).
 *
 * The behaviour under test: the holder is displayed from the server's `holder` field —
 * never inferred from `state` — and the management affordance appears only for a caller
 * who may manage the register.
 */

vi.mock('../api/assets.api', async () => {
  const actual = await vi.importActual<typeof import('../api/assets.api')>('../api/assets.api');
  return {
    ...actual,
    listAssets: async () => ({
      items: [
        {
          id: 'asset-1',
          tag: 'AST-000001',
          serialNumber: 'SN-1',
          name: 'ThinkPad X1',
          state: 'ASSIGNED' as const,
          assetType: { id: 'type-1', key: 'laptop', name: 'Laptop' },
          holder: {
            type: 'USER' as const,
            user: { id: 'u-9', displayName: 'Bea Holder', email: 'bea@initech.test' },
            team: null,
          },
          warrantyExpiresAt: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'asset-2',
          tag: 'AST-000002',
          serialNumber: null,
          name: 'Spare dock',
          state: 'IN_STOCK' as const,
          assetType: { id: 'type-2', key: 'dock', name: 'Dock' },
          holder: { type: null, user: null, team: null },
          warrantyExpiresAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
    listAssetTypes: async () => ({
      items: [
        {
          id: 'type-1',
          key: 'laptop',
          name: 'Laptop',
          description: null,
          attributeSchema: { required: ['cpu'] },
          isActive: true,
        },
      ],
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
          <AssetsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('AssetsPage', () => {
  it('shows the holder the server reported, not a state-derived guess', async () => {
    renderPage(['asset:read.any', 'asset:manage']);

    expect(await screen.findByText('AST-000001')).toBeInTheDocument();

    const table = within(screen.getByRole('table'));
    expect(table.getByText('Bea Holder')).toBeInTheDocument();
    expect(table.getByText('ASSIGNED')).toBeInTheDocument();
    // An unheld asset shows no invented holder name.
    expect(table.getByText('Spare dock')).toBeInTheDocument();
    expect(table.getByText('IN_STOCK')).toBeInTheDocument();
    expect(table.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('hides the register form from a read-only caller', async () => {
    renderPage(['asset:read.own']);
    expect(await screen.findByText('AST-000001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register asset' })).toBeNull();
  });

  it('offers the register form to a caller who may manage assets', async () => {
    renderPage(['asset:read.any', 'asset:manage']);
    expect(await screen.findByRole('button', { name: 'Register asset' })).toBeInTheDocument();
  });
});
