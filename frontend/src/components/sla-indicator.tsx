import { StatusBadge } from './status-badge';
import { SLA_STATE_TONE, type Tone } from '../themes/tokens';
import type { SlaClock, SlaClockState } from '../api/sla.api';
import { formatRemaining, spokenRemaining } from '../utils/sla';

/**
 * SLA indicator — `docs/25` §12.
 *
 * > *"State plus **time remaining** — a state without a number is not actionable."*
 *
 * The indicator renders both or it renders nothing. It is deliberately one component rather
 * than a badge plus ad-hoc text per screen: an SLA state that reads green in a list and
 * amber in the detail view destroys trust in the colour, which is the same reason
 * `status-badge.tsx` exists.
 *
 * Accessibility: colour is never the only signal — the state is spelled out, and the whole
 * indicator carries a `title` that names the target instant, so a screen-reader user hears
 * "SLA at risk, 4 hours 12 minutes remaining" rather than "amber".
 */

/**
 * The tone a state renders with.
 *
 * The four live states come from the shared `SLA_STATE_TONE` map in `themes/tokens.ts` — it
 * is the one place the meaning of a state is defined, and a badge that disagreed with it
 * would be the "green in the list, amber in the detail" defect `status-badge.tsx` warns
 * about. `STOPPED` is not in that map because it is not an SLA state at all: the clock has
 * finished, so it renders neutral.
 */
const STATE_TONE: Record<SlaClockState, Tone> = { ...SLA_STATE_TONE, STOPPED: 'neutral' };

/** The words a user reads. `SLA` jargon stays out of it where a plain phrase works. */
const STATE_LABEL: Record<SlaClockState, string> = {
  ON_TRACK: 'On track',
  AT_RISK: 'At risk',
  PAUSED: 'Paused',
  BREACHED: 'Breached',
  STOPPED: 'Stopped',
};

export interface SlaIndicatorProps {
  /** The clock, or null for a record whose clock has stopped and which has no live SLA. */
  sla: SlaClock | null;
}

export function SlaIndicator({ sla }: SlaIndicatorProps) {
  // No clock is not a breach and not a pass: it is the absence of an SLA to report, so
  // there is nothing honest to render.
  if (!sla) {
    return null;
  }

  const overdue = sla.state !== 'STOPPED' && sla.remainingSeconds < 0;
  const effectiveState: SlaClockState = overdue ? 'BREACHED' : sla.state;
  const remaining = sla.state === 'STOPPED' ? 'closed' : formatRemaining(sla.remainingSeconds);

  return (
    <span
      className="inline-flex items-center gap-2"
      title={`SLA ${STATE_LABEL[effectiveState]} — target ${new Date(sla.targetAt).toLocaleString()}`}
      aria-label={`SLA ${STATE_LABEL[effectiveState]}, ${
        sla.state === 'STOPPED'
          ? 'no longer running'
          : `${spokenRemaining(sla.remainingSeconds)} remaining`
      }`}
    >
      <StatusBadge tone={STATE_TONE[effectiveState]}>{STATE_LABEL[effectiveState]}</StatusBadge>
      {sla.state === 'STOPPED' ? (
        <span className="text-xs text-content-muted">closed</span>
      ) : (
        <time dateTime={sla.targetAt} className="text-xs text-content-muted">
          {remaining}
        </time>
      )}
    </span>
  );
}
