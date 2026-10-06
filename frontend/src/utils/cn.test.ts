import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins the truthy classes and drops the rest', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
  });

  it('never emits a literal "false" into className', () => {
    const isActive = false;
    expect(cn('base', isActive && 'active')).toBe('base');
  });

  it('returns an empty string when nothing applies', () => {
    expect(cn(false, null)).toBe('');
  });
});
