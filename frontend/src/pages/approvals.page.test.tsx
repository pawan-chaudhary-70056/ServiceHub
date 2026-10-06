import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalWorkflowView } from '../api/approvals.api';
import { ApprovalsPage } from './approvals.page';

/**
 * Approvals inbox tests (docs/37 §2, docs/26 §12). The behaviour under test is the
 * decision flow: the inbox lists the caller's own pending decision, and a rejection is
 * only sent once a mandatory reason has been given (rule A4).
 */

const decideApproval = vi
  .fn()
  .mockResolvedValue({ workflow: {} as ApprovalWorkflowView, recorded: true });

const workflow: ApprovalWorkflowView = {
  id: 'wf-1',
  request: { id: 'req-1', reference: 'REQ-2026-000001', title: 'Laptop with admin rights' },
  status: 'PENDING',
  currentStepOrder: 1,
  steps: [
    {
      id: 'step-1',
      stepOrder: 1,
      mode: 'ANY',
      status: 'ACTIVE',
      approvers: [
        { id: 'u-9', displayName: 'Ada Approver' },
        { id: 'u-10', displayName: 'Al Approver' },
      ],
      decisions: [],
    },
  ],
  createdAt: new Date().toISOString(),
  completedAt: null,
};

vi.mock('../api/approvals.api', async () => {
  const actual =
    await vi.importActual<typeof import('../api/approvals.api')>('../api/approvals.api');
  return {
    ...actual,
    listPendingApprovals: async () => ({ items: [workflow] }),
    decideApproval: (...args: unknown[]) => decideApproval(...args),
  };
});

function renderApprovals() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ApprovalsPage', () => {
  it('renders the pending request by reference and title, not by id', async () => {
    renderApprovals();

    expect(await screen.findByText('REQ-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('Laptop with admin rights')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('requires a reason before a rejection can be confirmed (rule A4)', async () => {
    const user = userEvent.setup();
    decideApproval.mockClear();
    renderApprovals();

    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Reason for rejection'), 'No business justification.');
    await user.click(confirm);

    expect(decideApproval).toHaveBeenCalledWith('step-1', {
      decision: 'REJECT',
      comment: 'No business justification.',
    });
  });
});
