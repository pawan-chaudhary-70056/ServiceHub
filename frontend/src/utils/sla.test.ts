import { describe, expect, it } from 'vitest';
import { formatRemaining, spokenRemaining } from './sla';

/**
 * SLA countdown formatting (`docs/25` §12).
 *
 * The rule the document cares about is that a state is never shown without a number, so the
 * cases here pin the boundaries where a naive formatter produces either noise ("0d 0h 12m") or
 * a lie ("-3h left").
 */
describe('formatRemaining', () => {
  it('shows two units at most, largest first', () => {
    expect(formatRemaining(3 * 86_400 + 4 * 3_600 + 12 * 60)).toBe('3d 4h left');
    expect(formatRemaining(4 * 3_600 + 12 * 60)).toBe('4h 12m left');
  });

  it('drops the leading zero units rather than padding them', () => {
    expect(formatRemaining(12 * 60)).toBe('12m left');
    expect(formatRemaining(45)).toBe('45s left');
  });

  it('reads a passed target as overdue, never as a negative countdown', () => {
    expect(formatRemaining(-3 * 3_600)).toBe('3h overdue');
  });
});

describe('spokenRemaining', () => {
  it('spells units out, because d/h/m are read as letters aloud', () => {
    expect(spokenRemaining(86_400 + 3_600)).toBe('1 day 1 hour');
    expect(spokenRemaining(2 * 86_400)).toBe('2 days 0 hours');
    expect(spokenRemaining(90)).toBe('1 minute');
  });
});
