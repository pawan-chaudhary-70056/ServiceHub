import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReportExport, ReportResult } from '../api/search.api';
import { ReportsPage } from './reports.page';

/**
 * Reports page tests (docs/37 §2, docs/30 §3/§5). The behaviour under test is the export
 * flow: a report is shown with its scope, and an export is queued asynchronously and only
 * offered for download once the server reports it succeeded.
 */

const report: ReportResult = {
  metric: 'requests.summary',
  period: {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
    timeZone: 'UTC',
  },
  scope: 'any',
  generatedAt: '2026-10-06T00:00:00.000Z',
  figures: { byStatus: { OPEN: 3, CLOSED: 1 } },
};

const succeeded: ReportExport = {
  id: 'exp-1',
  metric: 'requests.summary',
  format: 'CSV',
  status: 'SUCCEEDED',
  rowCount: 5,
  params: {},
  expiresAt: '2999-01-01T00:00:00.000Z',
  createdAt: '2026-10-06T00:00:00.000Z',
  completedAt: '2026-10-06T00:00:01.000Z',
  error: null,
  downloadUrl: '/api/v1/reports/jobs/exp-1/download',
};

const requestReportExport = vi.fn().mockResolvedValue({
  export: { ...succeeded, status: 'QUEUED', downloadUrl: null },
});

vi.mock('../api/search.api', async () => {
  const actual = await vi.importActual<typeof import('../api/search.api')>('../api/search.api');
  return {
    ...actual,
    runReport: async () => ({ report }),
    requestReportExport: (...args: unknown[]) => requestReportExport(...args),
    getReportExport: async () => ({ export: succeeded }),
  };
});

function renderReports() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReportsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportsPage', () => {
  it('shows the report with the scope it was run under (docs/30 §3.2 R2)', async () => {
    renderReports();

    expect(await screen.findByText('scope: any')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('queues an export and offers a download once it succeeds', async () => {
    const user = userEvent.setup();
    requestReportExport.mockClear();
    renderReports();

    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(requestReportExport).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
    expect(screen.getByText('5 rows')).toBeInTheDocument();
  });
});
