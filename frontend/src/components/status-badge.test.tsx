import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PRIORITY_TONE, SLA_STATE_TONE } from '../themes/tokens';
import { StatusBadge } from './status-badge';

/**
 * Component tests (docs/37 §2).
 *
 * These assert the two things the design system promises and a screenshot cannot:
 * the label is present (so the meaning does not depend on colour alone), and the tone
 * mapping is the shared one — a state that gains a new tone in `themes/tokens.ts` must
 * change here too, or the test fails.
 */
describe('StatusBadge', () => {
  it('renders its label so meaning does not depend on colour', () => {
    render(<StatusBadge tone="danger">Breached</StatusBadge>);

    expect(screen.getByText('Breached')).toBeInTheDocument();
  });

  it('applies the shared tone mapping for an SLA state', () => {
    const { container } = render(<StatusBadge tone={SLA_STATE_TONE.AT_RISK}>At risk</StatusBadge>);

    // The mapping is the contract; the exact utility classes are not.
    expect(SLA_STATE_TONE.AT_RISK).toBe('warning');
    expect(container.firstElementChild?.className).toContain('text-warning');
  });

  it('keeps BREACHED as danger for every priority-independent rendering', () => {
    expect(SLA_STATE_TONE.BREACHED).toBe('danger');
    expect(SLA_STATE_TONE.PAUSED).toBe('neutral');
  });

  it('renders priorities with a stable tone per level', () => {
    expect(PRIORITY_TONE.CRITICAL).toBe('danger');
    expect(PRIORITY_TONE.HIGH).toBe('warning');
    expect(PRIORITY_TONE.MEDIUM).toBe('info');
    expect(PRIORITY_TONE.LOW).toBe('neutral');
  });
});
