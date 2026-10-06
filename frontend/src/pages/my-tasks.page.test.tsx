import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { MyTasksPage } from './my-tasks.page';

/**
 * My Tasks page tests (docs/37 §2, docs/24 §10). The behaviour under test is due-state
 * grouping — overdue is derived, never a stored status (`docs/24` §6).
 */

vi.mock('../api/tasks.api', async () => {
  const actual = await vi.importActual<typeof import('../api/tasks.api')>('../api/tasks.api');
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  return {
    ...actual,
    listMyTasks: async () => ({
      items: [
        {
          id: 't-1',
          parentType: 'INCIDENT' as const,
          parentId: 'inc-1',
          parentLabel: 'INC-2026-000001 Mail relay down',
          title: 'Restart the relay',
          description: null,
          status: 'IN_PROGRESS' as const,
          assignee: { id: 'u-1', displayName: 'Alvin Agent' },
          createdBy: { id: 'u-2', displayName: 'Lea Lead' },
          blockedReason: null,
          overdue: true,
          dueAt: past,
          completedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 't-2',
          parentType: 'REQUEST' as const,
          parentId: 'req-1',
          parentLabel: 'REQ-2026-000002 Laptop',
          title: 'Order laptop',
          description: null,
          status: 'TODO' as const,
          assignee: { id: 'u-1', displayName: 'Alvin Agent' },
          createdBy: { id: 'u-2', displayName: 'Lea Lead' },
          blockedReason: null,
          overdue: false,
          dueAt: future,
          completedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
  };
});

function renderMyTasks() {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Alvin Agent',
      email: 'agent@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: ['task:update.any'],
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
          <MyTasksPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('MyTasksPage', () => {
  it('groups tasks by derived due state and flags overdue', async () => {
    renderMyTasks();

    expect(await screen.findByText('Restart the relay')).toBeInTheDocument();
    expect(screen.getByText('Order laptop')).toBeInTheDocument();

    // The overdue task is derived into the "Overdue" bucket and badged.
    expect(screen.getByRole('heading', { name: 'Overdue' })).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('heading', { name: 'Later' })).toBeInTheDocument();
  });
});
