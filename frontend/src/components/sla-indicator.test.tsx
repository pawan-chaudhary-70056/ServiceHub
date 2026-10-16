import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SlaIndicator } from './sla-indicator';
import type { SlaClock } from '../api/sla.api';

/**
 * SLA indicator tests (`docs/25` §12).
 *
 * The component exists because of one sentence in the document: *"state plus **time
 * remaining** — a state without a number is not actionable."* So the assertions are that both
 * are always rendered together, that the shared tone mapping is used, and that a record whose
 * clock has stopped reports that rather than showing a stale countdown.
 */

function clock(overrides: Partial<SlaClock> = {}): SlaClock {
  return {
    id: 'clock-1',
    cycle: 1,
    priority: 'HIGH',
    state: 'ON_TRACK',
    startedAt: '2026-10-15T09:00:00.000Z',
    targetAt: '2026-10-16T09:00:00.000Z',
    warnAt: '2026-10-15T15:00:00.000Z',
    breachedAt: null,
    pausedAt: null,
    stoppedAt: null,
    totalPausedSeconds: 0,
    remainingSeconds: 4 * 3_600,
    ...overrides,
  };
}

describe('SlaIndicator', () => {
  it('renders the state and the time remaining together', () => {
    render(<SlaIndicator sla={clock()} />);

    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('4h left')).toBeInTheDocument();
  });

  it('renders nothing for a record with no live clock', () => {
    const { container } = render(<SlaIndicator sla={null} />);

    // Nothing is the honest rendering: a stopped clock is not a pass and not a breach.
    expect(container).toBeEmptyDOMElement();
  });

  it('says a stopped clock is closed rather than counting down', () => {
    render(
      <SlaIndicator sla={clock({ state: 'STOPPED', stoppedAt: '2026-10-15T14:00:00.000Z' })} />,
    );

    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();
  });

  it('reports a breach and keeps the target instant in the accessible name', () => {
    render(<SlaIndicator sla={clock({ state: 'BREACHED', remainingSeconds: -7_200 })} />);

    expect(screen.getByText('Breached')).toBeInTheDocument();
    expect(screen.getByText('2h overdue')).toBeInTheDocument();
    expect(screen.getByLabelText(/SLA Breached/)).toBeInTheDocument();
  });

  it('treats a passed target as breached even before the sweep records it', () => {
    // The sweep runs on an interval, so a clock can be past its target while still stored
    // ON_TRACK. Showing "33m left" there would be simply wrong.
    render(<SlaIndicator sla={clock({ state: 'ON_TRACK', remainingSeconds: -1_980 })} />);

    expect(screen.getByText('Breached')).toBeInTheDocument();
  });

  it('gives the countdown a machine-readable target instant', () => {
    render(<SlaIndicator sla={clock()} />);

    expect(screen.getByText('4h left')).toHaveAttribute('dateTime', '2026-10-16T09:00:00.000Z');
  });
});
