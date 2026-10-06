import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { IncidentsPage } from './incidents.page';

/**
 * Incidents page tests (docs/37 §2, docs/23 §11).
 *
 * The behaviour under test is the derived-priority preview and the list rendering. The
 * server derives the authoritative priority; the preview exists so the reporter
 * understands the consequence of the impact and urgency they choose.
 */

// `listIncidents` is stubbed; everything else (notably the real `derivePriority`) is kept
// so the preview is exercised against the same matrix the server implements.
vi.mock('../api/incidents.api', async () => {
  const actual =
    await vi.importActual<typeof import('../api/incidents.api')>('../api/incidents.api');
  return {
    ...actual,
    listIncidents: async () => ({
      items: [
        {
          id: 'inc-1',
          reference: 'INC-2026-000001',
          title: 'Email is unreachable',
          priority: 'CRITICAL' as const,
          status: 'IN_PROGRESS' as const,
          isMajor: true,
          reporterName: 'Rita Reporter',
          assigneeName: 'Alvin Agent',
          teamName: 'Service Desk',
          slaPolicyName: 'Default',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
  };
});

vi.mock('../api/teams.api', () => ({ listTeams: async () => ({ items: [] }) }));

function renderIncidents(overrides: Partial<AuthContextValue> = {}) {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Rita Reporter',
      email: 'rita@initech.test',
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

  return render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IncidentsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('IncidentsPage', () => {
  it('renders incidents with their priority, status and major flag', async () => {
    renderIncidents();

    expect(await screen.findByText('Email is unreachable')).toBeInTheDocument();
    // Scope to the list: the status filter's <option> elements repeat these labels.
    const list = screen.getByRole('list');
    expect(within(list).getByText('MAJOR')).toBeInTheDocument();
    expect(within(list).getByText('CRITICAL')).toBeInTheDocument();
    expect(within(list).getByText('IN_PROGRESS')).toBeInTheDocument();
  });

  it('shows the derived priority live in the report form (docs/23 §11)', async () => {
    const user = userEvent.setup();
    renderIncidents();

    await user.click(screen.getByRole('button', { name: 'Report an incident' }));

    // The preview badge lives beside the "Derived priority" label; the urgency <option>
    // elements also carry the word MEDIUM, so the assertion is scoped to the badge.
    const preview = (): HTMLElement =>
      screen.getByText('Derived priority').parentElement as HTMLElement;

    // Defaults: Significant + Medium → MEDIUM.
    await waitFor(() => expect(within(preview()).getByText('MEDIUM')).toBeInTheDocument());

    // Extensive + High → CRITICAL, shown without submitting.
    await user.selectOptions(screen.getByLabelText(/Impact/), 'EXTENSIVE');
    await user.selectOptions(screen.getByLabelText(/Urgency/), 'HIGH');
    await waitFor(() => expect(within(preview()).getByText('CRITICAL')).toBeInTheDocument());
  });
});
