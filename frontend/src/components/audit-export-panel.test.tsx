import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuditExportPanel } from './audit-export-panel';

/**
 * Audit export control tests (`docs/31` §9/§10, `docs/37` §2).
 *
 * The behaviour under test is the entitlement boundary and the async-job shape: the control
 * is absent without `audit:export`, a security-class-only export is refused locally without
 * `audit:read.security`, and a queued export is polled until it settles and only then offers
 * the server's download link.
 */

const requestAuditExport = vi.fn();
const getAuditExport = vi.fn();

vi.mock('../api/audit.api', async () => {
  const actual = await vi.importActual<typeof import('../api/audit.api')>('../api/audit.api');
  return {
    ...actual,
    requestAuditExport: (...args: unknown[]) => requestAuditExport(...args),
    getAuditExport: (...args: unknown[]) => getAuditExport(...args),
  };
});

function renderPanel(props: {
  canExport: boolean;
  canReadSecurity?: boolean;
  filters?: Record<string, unknown>;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuditExportPanel
        filters={props.filters ?? {}}
        canExport={props.canExport}
        canReadSecurity={props.canReadSecurity ?? false}
      />
    </QueryClientProvider>,
  );
}

describe('AuditExportPanel', () => {
  it('is absent for a caller without audit:export', () => {
    renderPanel({ canExport: false });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('queues an export with the current filters and offers the server download', async () => {
    requestAuditExport.mockResolvedValueOnce({ export: { id: 'x1' } });
    getAuditExport.mockResolvedValue({
      export: {
        id: 'x1',
        metric: 'audit.log',
        format: 'csv',
        status: 'SUCCEEDED',
        rowCount: 3,
        params: {},
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: null,
        downloadUrl: '/audit/exports/x1/download',
      },
    });

    renderPanel({ canExport: true, filters: { action: 'login.success' } });
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(requestAuditExport).toHaveBeenCalledWith({ action: 'login.success' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument(),
    );
    expect(screen.getByText('3 rows')).toBeInTheDocument();
  });

  it('refuses a security-class-only export without the security-read grant', async () => {
    renderPanel({ canExport: true, canReadSecurity: false, filters: { securityOnly: true } });
    expect(screen.getByRole('alert')).toHaveTextContent(/security-class export/);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});
