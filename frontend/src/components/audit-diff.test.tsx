import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuditDiff } from './audit-diff';

/**
 * Audit diff viewer tests (docs/31 §11).
 *
 * The behaviour under test is the honesty of the rendering: a withheld payload is a
 * redaction marker, never an empty diff, and a changed field shows both its before and
 * after values.
 */
describe('AuditDiff', () => {
  it('renders a redaction marker instead of an empty diff for a withheld entry', () => {
    render(<AuditDiff before={null} after={null} redacted />);

    expect(screen.getByText(/Redacted/)).toBeInTheDocument();
    expect(screen.queryByTestId('audit-diff')).toBeNull();
  });

  it('shows both values for a changed field', () => {
    render(<AuditDiff before={{ status: 'NEW' }} after={{ status: 'OPEN' }} redacted={false} />);

    const diff = screen.getByTestId('audit-diff');
    expect(diff).toHaveTextContent('status');
    expect(diff).toHaveTextContent('NEW');
    expect(diff).toHaveTextContent('OPEN');
  });

  it('shows an unchanged field once, without an arrow', () => {
    render(
      <AuditDiff before={{ priority: 'HIGH' }} after={{ priority: 'HIGH' }} redacted={false} />,
    );

    const diff = screen.getByTestId('audit-diff');
    expect(diff).toHaveTextContent('priority');
    expect(diff).toHaveTextContent('HIGH');
    expect(diff.textContent).not.toContain('→');
  });

  it('reports when there is no field-level detail to show', () => {
    render(<AuditDiff before={null} after={null} redacted={false} />);
    expect(screen.getByText('No field-level detail recorded.')).toBeInTheDocument();
  });
});
