import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignIncident,
  closeIncident,
  getIncident,
  listComments,
  reopenIncident,
  resolveIncident,
  setIncidentMajor,
} from '../api/incidents.api';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { IncidentDetailPage } from './incident-detail.page';

/**
 * Incident detail page tests (docs/23 §11, docs/37 §2).
 *
 * The behaviour under test is the incident lifecycle as the UI exposes it, because two of
 * the rules are only observable here:
 *
 *   - **A resolution needs a summary.** The server answers `422` without one, so the form
 *     must not be able to send an empty one (`docs/23` §4).
 *   - **Assignment is triage.** `NEW → IN_PROGRESS` is the same edge as "assignee set"
 *     (`docs/23` §4), so assigning is what moves the incident forward — and `Resolve` is
 *     not offered before it.
 *
 * The four panels are stubbed: each has its own suite (`docs/37` §2 — a component test
 * proves its own level and not the one below it).
 */

vi.mock('../api/incidents.api', () => ({
  getIncident: vi.fn(),
  listComments: vi.fn(),
  assignIncident: vi.fn(),
  resolveIncident: vi.fn(),
  closeIncident: vi.fn(),
  reopenIncident: vi.fn(),
  setIncidentMajor: vi.fn(),
  updateIncident: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock('../components/attachment-panel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/knowledge-panel', () => ({ KnowledgePanel: () => null }));
vi.mock('../components/record-history-panel', () => ({ RecordHistoryPanel: () => null }));
vi.mock('../components/tasks-panel', () => ({ TasksPanel: () => null }));

const INCIDENT_ID = 'b2c3d4e5-2222-4222-8222-222222222222';

function incidentView(overrides: Record<string, unknown> = {}) {
  return {
    incident: {
      id: INCIDENT_ID,
      reference: 'INC-2026-000007',
      title: 'Checkout is failing',
      description: 'Every payment attempt times out.',
      impact: 'HIGH' as const,
      urgency: 'HIGH' as const,
      priority: 'CRITICAL' as const,
      isMajor: false,
      status: 'IN_PROGRESS' as const,
      reporter: { id: 'reporter-1', displayName: 'Rita Reporter' },
      assignee: { id: 'agent-1', displayName: 'Alvin Agent' },
      team: null,
      slaPolicy: { id: 'sla-1', name: 'Default' },
      resolutionSummary: null,
      reopenCount: 0,
      resolvedAt: null,
      closedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

function renderPage(overrides: Partial<AuthContextValue> = {}): void {
  const auth: AuthContextValue = {
    user: {
      id: 'agent-1',
      displayName: 'Alvin Agent',
      email: 'alvin@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: ['incident:update.any'],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => permission === 'incident:update.any',
    signIn: async () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/incidents/${INCIDENT_ID}`]}>
          <Routes>
            <Route path="/incidents/:id" element={<IncidentDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getIncident).mockResolvedValue(incidentView() as never);
  vi.mocked(listComments).mockResolvedValue({
    items: [],
    nextCursor: null,
    hasMore: false,
  } as never);
  vi.mocked(assignIncident).mockResolvedValue(incidentView() as never);
  vi.mocked(resolveIncident).mockResolvedValue(incidentView() as never);
  vi.mocked(closeIncident).mockResolvedValue(incidentView() as never);
  vi.mocked(reopenIncident).mockResolvedValue(incidentView() as never);
  vi.mocked(setIncidentMajor).mockResolvedValue(incidentView() as never);
});

describe('IncidentDetailPage', () => {
  it('will not resolve without a resolution summary', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    const confirm = screen.getByRole('button', { name: 'Resolve incident' });

    // An empty summary is a `422` at the server; the form refuses to send it (docs/23 §4).
    expect(confirm).toBeDisabled();
    expect(resolveIncident).not.toHaveBeenCalled();

    await user.type(
      screen.getByLabelText('Resolution summary (required)'),
      'Raised the provider timeout and replayed the failed payments.',
    );
    await user.click(confirm);

    await waitFor(() =>
      expect(resolveIncident).toHaveBeenCalledWith(
        INCIDENT_ID,
        'Raised the provider timeout and replayed the failed payments.',
      ),
    );
  });

  it('does not offer Resolve before the incident is in progress', async () => {
    vi.mocked(getIncident).mockResolvedValue(
      incidentView({ status: 'NEW', assignee: null }) as never,
    );
    renderPage();

    expect(await screen.findByRole('button', { name: 'Assign to me' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
  });

  it('treats assignment as triage and assigns to the signed-in caller', async () => {
    const user = userEvent.setup();
    vi.mocked(getIncident).mockResolvedValue(
      incidentView({ status: 'NEW', assignee: null }) as never,
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Assign to me' }));

    await waitFor(() =>
      expect(assignIncident).toHaveBeenCalledWith(INCIDENT_ID, { assigneeId: 'agent-1' }),
    );
  });

  it('closes a resolved incident the reporter owns', async () => {
    const user = userEvent.setup();
    vi.mocked(getIncident).mockResolvedValue(
      incidentView({ status: 'RESOLVED', resolutionSummary: 'Fixed.' }) as never,
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(closeIncident).toHaveBeenCalledWith(INCIDENT_ID));
  });

  it('sends the reason when reopening', async () => {
    const user = userEvent.setup();
    vi.mocked(getIncident).mockResolvedValue(
      incidentView({ status: 'RESOLVED', resolutionSummary: 'Fixed.' }) as never,
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    await user.type(
      screen.getByLabelText('Reason (required only outside the reopen window)'),
      'It happened again this morning.',
    );
    await user.click(screen.getByRole('button', { name: 'Reopen incident' }));

    // The reason is optional inside the window and required outside it; the server decides
    // which, so the client always sends what the user typed.
    await waitFor(() =>
      expect(reopenIncident).toHaveBeenCalledWith(INCIDENT_ID, 'It happened again this morning.'),
    );
  });

  it('declares a major incident in one action', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Declare major' }));

    await waitFor(() => expect(setIncidentMajor).toHaveBeenCalledWith(INCIDENT_ID, true));
  });

  it('offers no update controls to a caller without an update grant', async () => {
    renderPage({
      user: {
        id: 'reporter-1',
        displayName: 'Rita Reporter',
        email: 'rita@initech.test',
        organizationId: 'org-1',
        isPlatformOperator: false,
      },
      permissions: [],
      hasPermission: () => false,
    });

    expect(await screen.findByRole('heading', { name: 'Checkout is failing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Declare major' })).toBeNull();
  });
});
