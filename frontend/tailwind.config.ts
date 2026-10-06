import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration — the design system's token layer (docs/15-DESIGN-SYSTEM.md).
 *
 * The colour, spacing and radius scales point at CSS custom properties defined in
 * `src/assets/global.css`. That indirection is deliberate: a theme change (or a future
 * high-contrast theme) is a token change in one stylesheet, not a search across every
 * component for hard-coded hex values.
 *
 * Rule enforced in review: components use these tokens and the design-system components
 * in `src/components/`. Arbitrary values (`text-[#1a2b3c]`) are a defect — they are how
 * a design system silently stops being a system.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic names, not literal colours: a component should say "danger", not "red".
        surface: {
          DEFAULT: 'rgb(var(--sh-surface) / <alpha-value>)',
          muted: 'rgb(var(--sh-surface-muted) / <alpha-value>)',
          raised: 'rgb(var(--sh-surface-raised) / <alpha-value>)',
        },
        content: {
          DEFAULT: 'rgb(var(--sh-content) / <alpha-value>)',
          muted: 'rgb(var(--sh-content-muted) / <alpha-value>)',
          inverted: 'rgb(var(--sh-content-inverted) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--sh-border) / <alpha-value>)',
          strong: 'rgb(var(--sh-border-strong) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--sh-brand) / <alpha-value>)',
          strong: 'rgb(var(--sh-brand-strong) / <alpha-value>)',
        },
        // Priorities and SLA states map to these, so a status reads the same everywhere.
        success: 'rgb(var(--sh-success) / <alpha-value>)',
        warning: 'rgb(var(--sh-warning) / <alpha-value>)',
        danger: 'rgb(var(--sh-danger) / <alpha-value>)',
        info: 'rgb(var(--sh-info) / <alpha-value>)',
      },
      borderRadius: {
        sm: 'var(--sh-radius-sm)',
        DEFAULT: 'var(--sh-radius)',
        lg: 'var(--sh-radius-lg)',
      },
      fontFamily: {
        sans: ['var(--sh-font-sans)'],
        mono: ['var(--sh-font-mono)'],
      },
      // Focus ring is a token so keyboard focus is consistent and never removed
      // (docs/16 accessibility rules).
      ringColor: {
        DEFAULT: 'rgb(var(--sh-brand) / <alpha-value>)',
      },
    },
  },
  plugins: [],
} satisfies Config;
