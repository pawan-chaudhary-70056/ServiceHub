import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getItem, listItems } from '../api/catalog.api';
import { createRequest, listRequests } from '../api/requests.api';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { RequestsPage } from './requests.page';

/**
 * Requests page tests (docs/22 §12, docs/37 §2).
 *
 * The raise form is the entry point of the whole request lifecycle, and the behaviour
 * worth pinning is what the form **refuses** to send:
 *
 *   - a request with no service, because a request is always against a catalog item;
 *   - a request with no title, because an untitled request is unactionable.
 *
 * The form then posts the answers to the item's own questions, keyed by field key — a
 * payload carrying labels instead of keys would be silently dropped by the server.
 */

vi.mock('../api/catalog.api', () => ({ listItems: vi.fn(), getItem: vi.fn() }));
vi.mock('../api/requests.api', () => ({ listRequests: vi.fn(), createRequest: vi.fn() }));

const ITEM_ID = 'item-1';

function renderPage(): void {
  const auth: AuthContextValue = {
    user: {
      id: 'requester-1',
      displayName: 'Rita Reporter',
      email: 'rita@initech.test',
      organizationId: 'org-1',
      isPlatformOperator: false,
    },
    permissions: ['request:create', 'request:read.own'],
    isLoading: false,
    isAuthenticated: true,
    hasPermission: (permission: string) => permission === 'request:create',
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/requests']}>
          <Routes>
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/requests/:id" element={<p>request-landing</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRequests).mockResolvedValue({
    items: [],
    nextCursor: null,
    hasMore: false,
  } as never);
  vi.mocked(listItems).mockResolvedValue({
    items: [
      {
        id: ITEM_ID,
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
  } as never);
  vi.mocked(getItem).mockResolvedValue({
    item: {
      id: ITEM_ID,
      name: 'Standard laptop',
      fields: [
        {
          id: 'field-1',
          key: 'serial',
          label: 'Serial number',
          fieldType: 'TEXT',
          isRequired: true,
          options: null,
          validation: null,
          helpText: null,
          displayOrder: 0,
        },
      ],
    },
  } as never);
  vi.mocked(createRequest).mockResolvedValue({
    request: { id: 'req-1' },
  } as never);
});

describe('RequestsPage', () => {
  it('will not submit until a service and a title are both provided', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Raise a request' }));
    const submit = screen.getByRole('button', { name: 'Submit request' });

    expect(submit).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Service'), ITEM_ID);
    expect(submit).toBeDisabled(); // still no title

    await user.type(screen.getByLabelText('What do you need?'), 'A new starter laptop');
    expect(submit).toBeEnabled();
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('posts the answers keyed by the catalog field key and lands on the request', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Raise a request' }));
    await user.selectOptions(screen.getByLabelText('Service'), ITEM_ID);

    // The item's own questions appear once the service is chosen (docs/21 §9). The label
    // carries a `*` for a required field, so the accessible name is matched loosely.
    await user.type(await screen.findByLabelText(/Serial number/), 'SN-99123');
    await user.type(screen.getByLabelText('What do you need?'), 'A new starter laptop');
    await user.type(screen.getByLabelText('More detail (optional)'), 'Start date is Monday.');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() =>
      expect(createRequest).toHaveBeenCalledWith({
        catalogItemId: ITEM_ID,
        title: 'A new starter laptop',
        description: 'Start date is Monday.',
        fields: { serial: 'SN-99123' },
      }),
    );
    // Submitting moves the caller to the record they just created.
    expect(await screen.findByText('request-landing')).toBeInTheDocument();
  });

  it('shows the SLA state and time remaining in the list (docs/22 §14 AC5)', async () => {
    // The indicator is what makes the list triageable: a reviewer sorts by urgency without
    // opening every record (`docs/25` §12).
    vi.mocked(listRequests).mockResolvedValue({
      items: [
        {
          id: 'req-1',
          reference: 'REQ-2026-000001',
          title: 'A new starter laptop',
          status: 'IN_PROGRESS',
          priority: 'HIGH',
          catalogItemName: 'Standard laptop',
          requesterName: 'Rita Reporter',
          assigneeName: 'Ali Agent',
          slaPolicyName: 'Default',
          sla: {
            id: 'clock-1',
            cycle: 1,
            priority: 'HIGH',
            state: 'AT_RISK',
            startedAt: '2026-10-15T09:00:00.000Z',
            targetAt: '2026-10-15T17:00:00.000Z',
            warnAt: '2026-10-15T15:00:00.000Z',
            breachedAt: null,
            pausedAt: null,
            stoppedAt: null,
            totalPausedSeconds: 0,
            remainingSeconds: 3 * 3_600,
          },
          createdAt: '2026-10-15T09:00:00.000Z',
          updatedAt: '2026-10-15T10:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    } as never);

    renderPage();

    expect(await screen.findByText('At risk')).toBeInTheDocument();
    expect(screen.getByText('3h left')).toBeInTheDocument();
  });

  it('surfaces a server refusal and stays on the form', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../api/client');
    vi.mocked(createRequest).mockRejectedValue(
      new ApiError(409, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This service is retired and cannot be requested.',
        instance: '/api/v1/requests',
        code: 'CONFLICT',
        correlationId: 'corr-3',
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Raise a request' }));
    await user.selectOptions(screen.getByLabelText('Service'), ITEM_ID);
    await user.type(screen.getByLabelText('What do you need?'), 'A new starter laptop');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This service is retired and cannot be requested.',
    );
  });
});
