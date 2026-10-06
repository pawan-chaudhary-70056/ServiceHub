import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../api/search.api';
import { SearchPage } from './search.page';

/**
 * Search page tests (docs/37 §2, docs/30 §6). The behaviour under test is that results are
 * grouped and rendered exactly as the server returned them — the page never adds or hides
 * rows, because visibility is the server's decision (`docs/30` §2.3 S1).
 */

const searchMock = vi.fn();

vi.mock('../api/search.api', async () => {
  const actual = await vi.importActual<typeof import('../api/search.api')>('../api/search.api');
  return { ...actual, search: (...args: unknown[]) => searchMock(...args) };
});

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const result: SearchResult = {
  items: [
    {
      entityType: 'REQUEST',
      id: 'req-1',
      reference: 'REQ-2026-000001',
      title: 'VPN access for Alice',
      subtitle: 'Needs remote access',
      status: 'NEW',
      href: '/requests/req-1',
      snippet: '…VPN access for Alice…',
    },
  ],
  nextCursor: null,
  hasMore: false,
  fallback: null,
  searchedTypes: ['REQUEST'],
};

describe('SearchPage', () => {
  it('groups and renders results returned by the server', async () => {
    searchMock.mockResolvedValue(result);
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText('Search terms'), 'VPN');

    expect(await screen.findByText('VPN access for Alice')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByText('REQ-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('…VPN access for Alice…')).toBeInTheDocument();
  });

  it('states when only exact references were matched (docs/30 §2.4)', async () => {
    searchMock.mockResolvedValue({ ...result, items: [], fallback: 'EXACT_ONLY' });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText('Search terms'), 'R');

    expect(
      await screen.findByText('Very short queries match exact references only.'),
    ).toBeInTheDocument();
  });
});
