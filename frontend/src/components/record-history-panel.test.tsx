import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RecordHistoryPanel } from './record-history-panel';

/**
 * Record history panel tests (docs/31 §11).
 *
 * The behaviour under test: a record's own trail is visible to whoever may read the record,
 * and a withheld (security-class) entry renders as a redaction marker — the server withholds
 * the payload, so the panel must not present an empty diff as if nothing changed.
 */

vi.mock('../api/audit.api', async () => {
  const actual = await vi.importActual<typeof import('../api/audit.api')>('../api/audit.api');
  return {
    ...actual,
    getRecordHistory: vi.fn(async () => ({
      history: [
        {
          id: 'h1',
          action: 'request.status.change',
          actorId: '11111111-1111-1111-1111-111111111111',
          actorType: 'USER' as const,
          entityType: 'ServiceRequest',
          entityId: 'req-1',
          reason: 'Assigned to the desk',
          before: { status: 'NEW' },
          after: { status: 'OPEN' },
          correlationId: 'corr-1',
          sourceIp: '10.0.0.1',
          userAgent: null,
          occurredAt: new Date().toISOString(),
          security: false,
          redacted: false,
        },
        {
          id: 'h2',
          action: 'authz.override',
          actorId: null,
          actorType: 'SYSTEM' as const,
          entityType: 'ServiceRequest',
          entityId: 'req-1',
          reason: null,
          before: null,
          after: null,
          correlationId: 'corr-2',
          sourceIp: null,
          userAgent: null,
          occurredAt: new Date().toISOString(),
          security: true,
          redacted: true,
        },
      ],
    })),
  };
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RecordHistoryPanel entityType="ServiceRequest" entityId="req-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecordHistoryPanel', () => {
  it('renders the trail and both values of a changed field', async () => {
    renderPanel();

    expect(await screen.findByText('request.status.change')).toBeInTheDocument();
    expect(screen.getAllByTestId('record-history-entry')).toHaveLength(2);
    expect(screen.getByText('NEW')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('marks a withheld security entry as redacted rather than showing an empty diff', async () => {
    renderPanel();

    expect(await screen.findByText('authz.override')).toBeInTheDocument();
    expect(screen.getByText(/Redacted/)).toBeInTheDocument();
  });
});
