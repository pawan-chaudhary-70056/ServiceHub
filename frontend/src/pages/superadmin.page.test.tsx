import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorPage, OrganizationSummary, PlatformOperator } from '../api/platform.api';
import { SuperAdminPage } from './superadmin.page';

/**
 * Superadmin tests (docs/04 §13, `ADR-0012`).
 *
 * The page is a dashboard, so what matters is that its numbers and rows come from the
 * server and that each action refetches what it changed — a counter that survives a
 * mutation the server refused is the kind of dashboard people stop believing.
 */

function organization(
  overrides: Partial<OrganizationSummary> & Pick<OrganizationSummary, 'id' | 'name' | 'status'>,
): OrganizationSummary {
  return {
    nameKey: overrides.name.toLowerCase(),
    slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
    defaultTimeZone: 'Europe/London',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const operators: PlatformOperator[] = [
  {
    id: 'op-1',
    email: 'root@servicehub.local',
    displayName: 'Root Operator',
    status: 'ACTIVE',
    createdAt: '2026-09-01T00:00:00.000Z',
  },
];

const pageOne: CursorPage<OrganizationSummary> = {
  items: [
    organization({ id: 'org-1', name: 'Northwind Services', status: 'ACTIVE' }),
    organization({ id: 'org-2', name: 'Fabrikam', status: 'SUSPENDED' }),
  ],
  nextCursor: 'cursor-2',
  hasMore: true,
};

const pageTwo: CursorPage<OrganizationSummary> = {
  items: [organization({ id: 'org-3', name: 'Contoso', status: 'ACTIVE' })],
  nextCursor: null,
  hasMore: false,
};

const listOrganizations = vi.fn(
  async (params: { cursor?: string; limit?: number }): Promise<CursorPage<OrganizationSummary>> =>
    params.cursor ? pageTwo : pageOne,
);
const listOperators = vi.fn(async () => ({ items: operators }));
const createOrganization = vi.fn();
const suspendOrganization = vi.fn(async () => ({ organization: pageOne.items[1] }));
const activateOrganization = vi.fn(async () => ({ organization: pageOne.items[1] }));

vi.mock('../api/platform.api', async () => {
  const actual = await vi.importActual<typeof import('../api/platform.api')>('../api/platform.api');
  return {
    ...actual,
    listOrganizations: (
      ...args: Parameters<typeof listOrganizations>
    ): ReturnType<typeof listOrganizations> => listOrganizations(...args),
    listOperators: (): ReturnType<typeof listOperators> => listOperators(),
    createOrganization: (...args: unknown[]): ReturnType<typeof createOrganization> =>
      createOrganization(...args),
    suspendOrganization: (
      ...args: Parameters<typeof suspendOrganization>
    ): ReturnType<typeof suspendOrganization> => suspendOrganization(...args),
    activateOrganization: (
      ...args: Parameters<typeof activateOrganization>
    ): ReturnType<typeof activateOrganization> => activateOrganization(...args),
  };
});

function renderSuperAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SuperAdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SuperAdminPage', () => {
  beforeEach(() => {
    listOrganizations.mockClear();
    listOperators.mockClear();
    suspendOrganization.mockClear();
  });

  it('counts what the server returned, and renders the tenant table from it', async () => {
    renderSuperAdmin();

    await screen.findByText('Northwind Services');

    expect(screen.getByText('Northwind Services').closest('tr')).toHaveTextContent('ACTIVE');
    expect(screen.getByText('Fabrikam').closest('tr')).toHaveTextContent('SUSPENDED');
    // Both tenants carry the same zone; the column is per row, so there are two.
    expect(screen.getAllByText('Europe/London')).toHaveLength(2);
    // One ACTIVE and one SUSPENDED on the loaded page — not a number the page invented.
    expect(screen.getByText('Organizations loaded')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    // Active, suspended and the operator roster each read 1.
    expect(screen.getAllByText('1')).toHaveLength(3);
    expect(screen.getByText('Platform operators')).toBeInTheDocument();
    expect(screen.getByText('Root Operator')).toBeInTheDocument();
  });

  it('loads further pages rather than hiding them behind the first', async () => {
    const user = userEvent.setup();
    renderSuperAdmin();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    await screen.findByText('Contoso');
    expect(listOrganizations).toHaveBeenCalledTimes(2);
    // Scoped to the table: the operator roster also carries an ACTIVE badge.
    expect(within(screen.getByRole('table')).getAllByText('ACTIVE')).toHaveLength(2);
  });

  it('suspends a tenant through the API and refetches the list', async () => {
    const user = userEvent.setup();
    renderSuperAdmin();

    await screen.findByText('Northwind Services');
    const [firstSuspend] = screen.getAllByRole('button', { name: 'Suspend' });
    expect(firstSuspend).toBeDefined();
    await user.click(firstSuspend as HTMLElement);

    await waitFor(() => expect(suspendOrganization).toHaveBeenCalledWith('org-1'));
    await waitFor(() => expect(listOrganizations).toHaveBeenCalledTimes(2));
  });
});
