/**
 * Design tokens for JavaScript consumers (docs/15).
 *
 * `global.css` holds the values; this module gives components a typed way to refer to
 * the same tokens without repeating string literals. The important export is the status
 * mapping: a status must mean the same thing in a badge, a chart and a report, and the
 * only way to guarantee that is to define it once.
 */

export const TOKEN_NAMES = [
  'surface',
  'surface-muted',
  'surface-raised',
  'content',
  'content-muted',
  'border',
  'brand',
  'success',
  'warning',
  'danger',
  'info',
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

/** Visual tone of a status indicator. */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * SLA clock states, per docs/25 §5.
 *
 * `PAUSED` is deliberately its own tone rather than "warning": time is not elapsing,
 * so showing it as a risk would train people to misread a paused record as a late one.
 */
export type SlaState = 'ON_TRACK' | 'AT_RISK' | 'BREACHED' | 'PAUSED';

export const SLA_STATE_TONE: Record<SlaState, Tone> = {
  ON_TRACK: 'success',
  AT_RISK: 'warning',
  BREACHED: 'danger',
  PAUSED: 'neutral',
};

/** Record priorities. */
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const PRIORITY_TONE: Record<Priority, Tone> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  CRITICAL: 'danger',
};

/** Approval outcomes. */
export type ApprovalDecision = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export const APPROVAL_DECISION_TONE: Record<ApprovalDecision, Tone> = {
  PENDING: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'neutral',
};
