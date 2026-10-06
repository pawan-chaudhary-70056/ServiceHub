import { config } from '../config';

/**
 * Session window arithmetic (docs/06 §7, `ADR-0001`).
 *
 * A session is bounded by two independent clocks and dies at whichever fires first:
 *
 *   - IDLE — the time since the last request. A forgotten browser tab should not stay
 *     authenticated indefinitely.
 *   - ABSOLUTE — the time since login, regardless of activity. An active session still
 *     has a ceiling, so a stolen session cannot be renewed forever by using it.
 *
 * Bounding the arithmetic here keeps the two clocks consistent between issue, read and
 * refresh; computing them ad hoc at each call site is how one clock silently stops
 * being applied.
 */
export interface SessionWindow {
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export function newSessionWindow(now: Date = new Date()): SessionWindow {
  return {
    idleExpiresAt: new Date(now.getTime() + config.SESSION_IDLE_MINUTES * 60_000),
    absoluteExpiresAt: new Date(now.getTime() + config.SESSION_ABSOLUTE_HOURS * 3_600_000),
  };
}

/**
 * Refreshes the idle expiry after a request, without ever moving the absolute limit.
 *
 * `min(now + idle, absoluteExpiresAt)` is the whole point: activity can extend the idle
 * clock only up to the session's hard ceiling (docs/06 §7).
 */
export function refreshedIdleExpiry(absoluteExpiresAt: Date, now: Date = new Date()): Date {
  const idle = new Date(now.getTime() + config.SESSION_IDLE_MINUTES * 60_000);
  return idle.getTime() < absoluteExpiresAt.getTime() ? idle : absoluteExpiresAt;
}

/** True when either clock has passed. Both must be inside their bound to be valid. */
export function isSessionExpired(
  session: { idleExpiresAt: Date; absoluteExpiresAt: Date; revokedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (session.revokedAt) {
    return true;
  }
  return (
    now.getTime() >= session.idleExpiresAt.getTime() ||
    now.getTime() >= session.absoluteExpiresAt.getTime()
  );
}
