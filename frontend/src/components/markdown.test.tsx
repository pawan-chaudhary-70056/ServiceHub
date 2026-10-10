import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

/**
 * Markdown renderer tests (docs/27 rule K2, docs/17).
 *
 * The behaviour under test is the security property, not the formatting: a body is
 * rendered as React elements, so markup in the source is **text**, never DOM. These tests
 * assert the renderer's own guarantee, independently of the API-side rejection.
 */

describe('Markdown', () => {
  it('renders a heading as a real heading', () => {
    render(<Markdown source={'# Reset your password\n\nFollow these steps.'} />);
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByText('Follow these steps.')).toBeInTheDocument();
  });

  it('renders markup in the source as literal text, never as DOM', () => {
    const { container } = render(
      <Markdown source={'Before <script>alert(1)</script> after <img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/Before <script>alert\(1\)<\/script> after/)).toBeInTheDocument();
  });

  it('renders only http(s) links as anchors', () => {
    const { container } = render(
      <Markdown source={'[safe](https://example.test/guide) and [unsafe](javascript:alert(1))'} />,
    );
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.test/guide');
    // The unsafe target survives as text so the reader can see what was written.
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });

  it('keeps fenced code verbatim and does not interpret it', () => {
    const { container } = render(<Markdown source={'```\nconst x = 1;\n**not bold**\n```'} />);
    expect(container.querySelector('pre')?.textContent).toContain('**not bold**');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('renders list items as list items', () => {
    render(<Markdown source={'- first\n- second'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
