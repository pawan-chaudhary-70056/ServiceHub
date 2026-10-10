import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { addTeamMember, createTeam, getTeam, listTeams, removeTeamMember } from '../api/teams.api';
import { listUsers } from '../api/users.api';
import { TeamsPage } from './teams.page';

/**
 * Teams administration page tests (docs/07 §6, docs/37 §2).
 *
 * The behaviour under test is the administrative contract, not the layout: a membership
 * change goes through the API with the right team and user, the picker offers only people
 * the server will accept, and the colleague who has left (INACTIVE) is not offered at all.
 */

vi.mock('../api/teams.api', () => ({
  listTeams: vi.fn(),
  getTeam: vi.fn(),
  createTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
}));

vi.mock('../api/users.api', async () => {
  const actual = await vi.importActual<typeof import('../api/users.api')>('../api/users.api');
  return { ...actual, listUsers: vi.fn() };
});

const TEAM_ID = '3f0a6d1e-1111-4111-8111-111111111111';
const ADA_ID = 'ada-2222-4222-8222-222222222222';
const NEWTON_ID = 'newton-3333-4333-8333-333333333333';

function teamDetail() {
  return {
    team: {
      id: TEAM_ID,
      name: 'Service Desk',
      description: 'First line',
      isActive: true,
      members: [
        {
          userId: ADA_ID,
          email: 'ada@initech.test',
          displayName: 'Ada Lovelace',
          role: 'LEAD' as const,
          addedAt: new Date().toISOString(),
        },
      ],
    },
  };
}

function renderPage(): void {
  const auth: AuthContextValue = {
    user: {
      id: 'u-1',
      displayName: 'Lena Lead',
      email: 'lead@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: ['user:manage', 'catalog:read'],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => permission === 'user:manage',
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TeamsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTeams).mockResolvedValue({
    items: [{ id: TEAM_ID, name: 'Service Desk', description: 'First line', isActive: true }],
  });
  vi.mocked(getTeam).mockResolvedValue(teamDetail());
  vi.mocked(createTeam).mockResolvedValue(teamDetail());
  vi.mocked(addTeamMember).mockResolvedValue(teamDetail());
  vi.mocked(removeTeamMember).mockResolvedValue(undefined);
  vi.mocked(listUsers).mockResolvedValue({
    items: [
      {
        id: NEWTON_ID,
        email: 'newton@initech.test',
        displayName: 'Newton',
        status: 'ACTIVE',
        roles: ['TECHNICIAN'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'gone-4444-4444-8444-444444444444',
        email: 'gone@initech.test',
        displayName: 'Departed Colleague',
        status: 'INACTIVE',
        roles: ['REQUESTER'],
        createdAt: new Date().toISOString(),
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
});

describe('TeamsPage', () => {
  it('lists the tenant’s teams', async () => {
    renderPage();
    expect(await screen.findByText('Service Desk')).toBeInTheDocument();
    expect(screen.getByText('First line')).toBeInTheDocument();
  });

  it('shows a selected team’s members with their role', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Manage members' }));

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@initech.test')).toBeInTheDocument();
    // The role badge, plus the option in the role picker.
    expect(screen.getAllByText('LEAD').length).toBeGreaterThan(0);
    expect(getTeam).toHaveBeenCalledWith(TEAM_ID, expect.anything());
  });

  it('removes a member through the API with the team and user id', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Manage members' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Ada Lovelace' }));

    await waitFor(() => expect(removeTeamMember).toHaveBeenCalledWith(TEAM_ID, ADA_ID));
  });

  it('adds a member with the chosen role', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Manage members' }));

    await userEvent.selectOptions(await screen.findByLabelText('Person'), NEWTON_ID);
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'LEAD');
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() =>
      expect(addTeamMember).toHaveBeenCalledWith(TEAM_ID, { userId: NEWTON_ID, role: 'LEAD' }),
    );
  });

  it('offers only active people in the picker (docs/07 §6)', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Manage members' }));

    const picker = await screen.findByLabelText('Person');
    expect(picker).toHaveTextContent('Newton');
    // The server refuses an inactive user, so the picker must not offer one.
    expect(picker).not.toHaveTextContent('Departed Colleague');
  });

  it('creates a team and selects it', async () => {
    renderPage();
    await userEvent.type(await screen.findByLabelText('Name'), 'Network Operations');
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }));

    // The mutation function receives react-query's context as a second argument, so the
    // assertion is on the request body it was handed.
    await waitFor(() =>
      expect(vi.mocked(createTeam).mock.calls[0]?.[0]).toEqual({ name: 'Network Operations' }),
    );
    // The newly created team becomes the selected one, so its membership is next.
    expect(await screen.findByRole('heading', { name: 'Membership' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Selected' })).toBeInTheDocument();
  });
});
