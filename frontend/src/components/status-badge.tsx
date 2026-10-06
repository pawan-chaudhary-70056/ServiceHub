import type { ReactNode } from 'react';
import type { Tone } from '../themes/tokens';
import { cn } from '../utils/cn';

/**
 * Design-system status indicator (docs/15, docs/16).
 *
 * Statuses appear in lists, headers, charts and reports, so this is one of the few
 * components that must be used everywhere rather than reimplemented per screen: an
 * SLA state that renders green in the list and amber in the detail view destroys trust
 * in the colour. The tone is supplied by a shared mapping in `themes/tokens.ts`, so the
 * meaning of a state is defined once.
 *
 * Accessibility: colour is never the only signal. The label text carries the meaning,
 * and the badge is not announced as an alert — a list of forty badges each firing an
 * alert would make the page unusable with a screen reader.
 */
const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-border bg-surface-muted text-content-muted',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  info: 'border-info/30 bg-info/10 text-info',
};

export interface StatusBadgeProps {
  tone?: Tone;
  children: ReactNode;
}

export function StatusBadge({ tone = 'neutral', children }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}
