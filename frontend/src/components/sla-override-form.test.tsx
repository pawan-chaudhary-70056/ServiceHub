import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overrideClock } from '../api/sla.api';
import { SlaOverrideForm } from './sla-override-form';
import type { SlaClock } from '../api/sla.api';

/**
 * SLA override form tests (`docs/25` §11, §14 AC8).
 *
 * The form gates the two things the server also enforces, and it stops a caller before the
 * round trip: **a reason is mandatory** (an unexplained change to a contractual deadline is
 * what the audit trail exists to prevent) and **an override that changes nothing is
 * refused** rather than recorded as a no-op entry nobody can interpret.
 */

vi.mock('../api/sla.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sla.api')>();
  return { ...actual, overrideClock: vi.fn() };
});

const clock: SlaClock = {
  id: 'clock-1',
  cycle: 1,
  priority: 'HIGH',
  state: 'BREACHED',
  startedAt: '2026-10-14T09:00:00.000Z',
  targetAt: '2026-10-15T09:00:00.000Z',
  warnAt: '2026-10-15T03:00:00.000Z',
  breachedAt: '2026-10-15T09:00:12.000Z',
  pausedAt: null,
  stoppedAt: null,
  totalPausedSeconds: 0,
  remainingSeconds: -7_200,
};

function renderForm(onOverridden = vi.fn()): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SlaOverrideForm clock={clock} onOverridden={onOverridden} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(overrideClock).mockResolvedValue({ clock } as never);
});

describe('SlaOverrideForm', () => {
  it('stays collapsed until the operator asks for it', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.queryByLabelText('Reason (required)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Override SLA' }));

    expect(screen.getByLabelText('Reason (required)')).toBeInTheDocument();
  });

  it('refuses to submit with no reason and with nothing requested', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Override SLA' }));
    const submit = screen.getByRole('button', { name: 'Record override' });

    expect(submit).toBeDisabled(); // no reason, no effect

    await user.type(screen.getByLabelText('Reason (required)'), 'Customer agreed an extension');
    expect(submit).toBeDisabled(); // a reason alone changes nothing

    await user.click(screen.getByLabelText('Clear the recorded breach'));
    expect(submit).toBeEnabled();
  });

  it('records a cleared breach with its reason and refreshes the record', async () => {
    const user = userEvent.setup();
    const onOverridden = vi.fn();
    renderForm(onOverridden);

    await user.click(screen.getByRole('button', { name: 'Override SLA' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'False alarm, already answered');
    await user.click(screen.getByLabelText('Clear the recorded breach'));
    await user.click(screen.getByRole('button', { name: 'Record override' }));

    await waitFor(() =>
      expect(overrideClock).toHaveBeenCalledWith('clock-1', {
        reason: 'False alarm, already answered',
        clearBreach: true,
      }),
    );
    expect(await screen.findByText('Override recorded.')).toBeInTheDocument();
    expect(onOverridden).toHaveBeenCalled();
  });

  it('sends a new target as an instant when one is chosen', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Override SLA' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'Parts delayed by the supplier');
    await user.type(screen.getByLabelText('New target (optional)'), '2026-10-20T17:00');
    await user.click(screen.getByRole('button', { name: 'Record override' }));

    await waitFor(() => expect(overrideClock).toHaveBeenCalled());
    const call = vi.mocked(overrideClock).mock.calls[0]?.[1];
    expect(call?.reason).toBe('Parts delayed by the supplier');
    // The picker yields a local wall time; the API takes an instant.
    expect(call?.targetAt).toBe(new Date('2026-10-20T17:00').toISOString());
  });

  it('shows the server refusal rather than silently failing', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../api/client');
    vi.mocked(overrideClock).mockRejectedValue(
      new ApiError(403, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have permission to perform this action.',
        instance: '/api/v1/sla/clocks/clock-1/override',
        code: 'FORBIDDEN',
        correlationId: 'corr-9',
      }),
    );
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Override SLA' }));
    await user.type(screen.getByLabelText('Reason (required)'), 'Attempt without the grant');
    await user.click(screen.getByLabelText('Clear the recorded breach'));
    await user.click(screen.getByRole('button', { name: 'Record override' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to perform this action.',
    );
  });
});
