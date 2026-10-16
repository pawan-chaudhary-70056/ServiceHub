import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../hooks/auth-context';
import { HomePage } from './home.page';

/**
 * Landing page tests (docs/16, docs/07 §3, docs/30 §3.3).
 *
 * The behaviours worth pinning: the page links each implemented area to the screen that
 * serves it; it distinguishes "not for your role" from "does not exist"; and the figures
 * it shows come from the reporting surface rather than from this page's arithmetic.
 */

// The health query is stubbed so the test does not depend on a running API, but the
// module boundary is the real one (`useHealth` is exercised, not replaced).
vi.mock('../api/health.api', async () => {
  const actual = await vi.importActual<typeof import('../api/health.api')>('../api/health.api');
  return {
    ...actual,
    fetchReadiness: async () => ({
      status: 'ready' as const,
      checks: [{ name: 'database', status: 'up' as const }],
    }),
  };
});

const runReport = vi.fn(async (metric: string) => ({
  report: {
    metric,
    period: { from: 'x', to: 'y', timeZone: 'UTC' },
    scope: 'any' as const,
    generatedAt: '2026-10-16T00:00:00.000Z',
    figures: FIGURES[metric] ?? {},
  },
}));

const FIGURES: Record<string, Record<string, unknown>> = {
  'requests.summary': { byStatus: { NEW: 1, APPROVAL_PENDING: 1, IN_PROGRESS: 1, CLOSED: 1 } },
  'incidents.summary': { byStatus: { NEW: 1, IN_PROGRESS: 1, RESOLVED: 1 } },
  'tasks.summary': { byStatus: { TODO: 2 } },
  'approvals.turnaround': { pending: 1, decisionCount: 1 },
};

vi.mock('../api/search.api', async () => {
  const actual = await vi.importActual<typeof import('../api/search.api')>('../api/search.api');
  return { ...actual, runReport: (...args: unknown[]) => runReport(...(args as [string])) };
});

const ALL_PERMISSIONS = [
  'catalog:read',
  'request:read.own',
  'incident:read.any',
  'task:update.team',
  'sla:policy:manage',
  'approval:decide',
  'kb:article:read',
  'asset:read.any',
  'report:read',
  'audit:read.all',
  'integration:read',
];

function renderHome(permissions: readonly string[], isAuthenticated = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth: AuthContextValue = {
    user: null,
    permissions,
    isLoading: false,
    isAuthenticated,
    hasPermission: (permission) => permissions.includes(permission),
    signIn: async () => {},
    signOut: async () => {},
  };

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthContext.Provider value={auth}>
          <HomePage />
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HomePage', () => {
  beforeEach(() => {
    runReport.mockClear();
  });

  it('reports the API readiness the server returned, with its dependency checks', async () => {
    renderHome(ALL_PERMISSIONS);

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('database')).toBeInTheDocument();
    expect(screen.getByText('up', { exact: false })).toBeInTheDocument();
  });

  it('links every functional area to the screen that serves it (docs/21–28)', () => {
    renderHome(ALL_PERMISSIONS);

    const expected: [string, string][] = [
      ['Service Catalog', '/catalog'],
      ['Service Requests', '/requests'],
      ['Incident Management', '/incidents'],
      ['Task Management', '/tasks'],
      ['SLA Management', '/admin/sla'],
      ['Approval Management', '/approvals'],
      ['Knowledge Base', '/kb'],
      ['Asset Management', '/assets'],
      ['Notifications', '/notifications'],
      ['Search', '/search'],
      ['Reporting', '/reports'],
      ['Audit log', '/audit'],
      ['Integrations', '/admin/integrations'],
    ];

    for (const [name, href] of expected) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  it('marks an area the caller cannot open instead of hiding it (docs/07 §3)', () => {
    renderHome(['catalog:read']);

    // Held permission: available.
    expect(screen.getByRole('link', { name: 'Service Catalog' }).closest('li')).toHaveTextContent(
      'Available',
    );
    // Not held: still listed, and labelled — a hidden area would read as a missing feature.
    expect(screen.getByRole('link', { name: 'Asset Management' }).closest('li')).toHaveTextContent(
      'No access',
    );
  });

  it('asks an unauthenticated visitor to sign in rather than claiming an area is missing', () => {
    renderHome([], false);

    // Every area is listed and none is labelled "no access": without a session the
    // question is "who are you", not "what may you do".
    const areas = screen.getAllByRole('listitem');
    expect(areas).toHaveLength(13);
    for (const area of areas) {
      expect(area).toHaveTextContent('Sign in');
    }
  });

  it('shows live workload figures read from the reporting surface (docs/30 §3.3)', async () => {
    renderHome(ALL_PERMISSIONS);

    // The tiles render immediately with a placeholder; the count only lands when the
    // report resolves, so the assertion waits for the figure rather than the element.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Open requests/ })).toHaveTextContent('3'),
    );

    // Three of the four requests are open; CLOSED is not, and the tile says 3, not 4.
    expect(screen.getByRole('link', { name: /Open incidents/ })).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: /Tasks assigned/ })).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: /Awaiting decision/ })).toHaveTextContent('1');

    expect(runReport).toHaveBeenCalledWith('requests.summary', {}, expect.anything());
  });

  it('offers no workload strip to a caller who cannot read reports', () => {
    renderHome(['request:read.own']);

    expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument();
    expect(runReport).not.toHaveBeenCalled();
  });
});
