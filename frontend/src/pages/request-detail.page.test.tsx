import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignRequest,
  cancelRequest,
  getRequest,
  listComments,
  transitionRequest,
} from '../api/requests.api';
import { ApiError } from '../api/client';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { RequestDetailPage } from './request-detail.page';

/**
 * Request detail page tests (docs/22 §12, docs/37 §2).
 *
 * The behaviour under test is the **action surface**: which lifecycle controls are offered
 * from which state, and what the control sends when it is used. A control that posts the
 * wrong target state is a defect no screenshot catches, and a control that is missing makes
 * a whole lifecycle unreachable — which is exactly what happened to the approval step
 * before this page offered it.
 *
 * The five panels (approvals, attachments, tasks, knowledge, history) are stubbed to
 * nothing: each has its own suite, and rendering them here would test their API mocks
 * rather than this page's decisions.
 */

vi.mock('../api/requests.api', () => ({
  getRequest: vi.fn(),
  listComments: vi.fn(),
  transitionRequest: vi.fn(),
  assignRequest: vi.fn(),
  cancelRequest: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock('../components/approvals-panel', () => ({ ApprovalsPanel: () => null }));
vi.mock('../components/attachment-panel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/knowledge-panel', () => ({ KnowledgePanel: () => null }));
vi.mock('../components/record-history-panel', () => ({ RecordHistoryPanel: () => null }));
vi.mock('../components/tasks-panel', () => ({ TasksPanel: () => null }));

const REQUEST_ID = 'a1b2c3d4-1111-4111-8111-111111111111';

function requestView(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      id: REQUEST_ID,
      reference: 'REQ-2026-000042',
      title: 'A new starter laptop',
      description: 'Please provision a laptop for the new starter.',
      status: 'TRIAGED' as const,
      priority: 'MEDIUM' as const,
      catalogItem: { id: 'item-1', name: 'Standard laptop', requiresApproval: true },
      requester: { id: 'requester-1', displayName: 'Rita Reporter' },
      assignee: { id: 'agent-1', displayName: 'Alvin Agent' },
      team: null,
      slaPolicy: { id: 'sla-1', name: 'Default' },
      fields: [],
      submittedAt: new Date().toISOString(),
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
    permissions: ['request:update.any'],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => permission === 'request:update.any',
    signIn: async () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/requests/${REQUEST_ID}`]}>
          <Routes>
            <Route path="/requests/:id" element={<RequestDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRequest).mockResolvedValue(requestView() as never);
  vi.mocked(listComments).mockResolvedValue({ items: [] } as never);
  vi.mocked(transitionRequest).mockResolvedValue(requestView() as never);
  vi.mocked(assignRequest).mockResolvedValue(requestView() as never);
  vi.mocked(cancelRequest).mockResolvedValue(requestView() as never);
});

describe('RequestDetailPage', () => {
  it('sends a triaged, approval-gated request to APPROVAL_PENDING', async () => {
    const user = userEvent.setup();
    renderPage();

    const send = await screen.findByRole('button', { name: 'Send for approval' });
    await user.click(send);

    // Entry to APPROVAL_PENDING is what instantiates the workflow and starts the clocks,
    // so the target state is the assertion, not the button.
    await waitFor(() =>
      expect(transitionRequest).toHaveBeenCalledWith(REQUEST_ID, { to: 'APPROVAL_PENDING' }),
    );
  });

  it('does not offer approval when the service does not require it', async () => {
    vi.mocked(getRequest).mockResolvedValue(
      requestView({
        catalogItem: { id: 'item-1', name: 'Password reset', requiresApproval: false },
      }) as never,
    );
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'A new starter laptop' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
  });

  it('does not offer approval before the request is triaged', async () => {
    vi.mocked(getRequest).mockResolvedValue(requestView({ status: 'NEW' }) as never);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Start triage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
  });

  it('does not offer approval once the workflow has started', async () => {
    vi.mocked(getRequest).mockResolvedValue(requestView({ status: 'APPROVAL_PENDING' }) as never);
    renderPage();

    expect(await screen.findByText('APPROVAL_PENDING', { exact: true })).toBeInTheDocument();
    // Re-entering APPROVAL_PENDING would instantiate a second workflow (docs/26 §4).
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
  });

  it('requires a fulfilment note before it will mark the work done', async () => {
    const user = userEvent.setup();
    vi.mocked(getRequest).mockResolvedValue(requestView({ status: 'IN_PROGRESS' }) as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Mark fulfilled' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    // The server rejects a missing note with 422; the form does not let the caller send one.
    expect(confirm).toBeDisabled();
    expect(transitionRequest).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Fulfilment note (required)'), 'Imaged and handed over.');
    await user.click(confirm);

    await waitFor(() =>
      expect(transitionRequest).toHaveBeenCalledWith(REQUEST_ID, {
        to: 'FULFILLED',
        fulfilmentNote: 'Imaged and handed over.',
      }),
    );
  });

  it('offers no lifecycle action on a closed request', async () => {
    vi.mocked(getRequest).mockResolvedValue(requestView({ status: 'CLOSED' }) as never);
    renderPage();

    expect(await screen.findByText('CLOSED', { exact: true })).toBeInTheDocument();
    for (const label of [
      'Assign to me',
      'Start triage',
      'Start work',
      'Mark fulfilled',
      'Close',
      'Cancel',
      'Send for approval',
    ]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('surfaces a server refusal instead of hiding it', async () => {
    const user = userEvent.setup();
    vi.mocked(transitionRequest).mockRejectedValue(
      new ApiError(409, {
        type: 'about:blank',
        title: 'Illegal transition',
        status: 409,
        detail: 'A request cannot move from TRIAGED to APPROVAL_PENDING.',
        instance: `/api/v1/requests/${REQUEST_ID}/transition`,
        code: 'ILLEGAL_TRANSITION',
        correlationId: 'corr-9',
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Send for approval' }));

    // The UI offers the action; the server decides. A refusal must be visible, otherwise
    // the screen looks like it worked (docs/22 §12).
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A request cannot move from TRIAGED to APPROVAL_PENDING.',
    );
  });

  it('assigns the request to the signed-in caller', async () => {
    const user = userEvent.setup();
    vi.mocked(getRequest).mockResolvedValue(requestView({ assignee: null }) as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Assign to me' }));

    await waitFor(() =>
      expect(assignRequest).toHaveBeenCalledWith(REQUEST_ID, { assigneeId: 'agent-1' }),
    );
  });

  it('offers no work controls to a caller without an update grant', async () => {
    renderPage({
      user: {
        id: 'requester-1',
        displayName: 'Rita Reporter',
        email: 'rita@initech.test',
        organizationId: 'org-1',
        isPlatformOperator: false,
      },
      permissions: [],
      hasPermission: () => false,
    });

    expect(
      await screen.findByRole('heading', { name: 'A new starter laptop' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
    // The requester may still cancel their own request (`request:cancel.own` is enforced
    // server-side; the button is offered and the server refuses if the grant is absent).
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
