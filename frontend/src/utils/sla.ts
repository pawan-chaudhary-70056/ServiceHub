/**
 * SLA countdown formatting (`docs/25` §12).
 *
 * Kept out of the component file for two reasons: it is pure and therefore unit-testable
 * without rendering, and a component module that also exports functions breaks Vite's
 * fast-refresh boundary.
 */

/**
 * Formats a countdown for a human: two units at most.
 *
 * Two units because "3d 4h 12m 9s" is noise in a list — the reader wants the order of
 * magnitude, and the exact target instant is on the record. Negative input means the target
 * has already passed, which is reachable only for a clock whose breach the sweep has not yet
 * recorded, so it reads "overdue" rather than showing a minus sign.
 */
export function formatRemaining(seconds: number): string {
  const magnitude = Math.abs(Math.trunc(seconds));
  const days = Math.floor(magnitude / 86_400);
  const hours = Math.floor((magnitude % 86_400) / 3_600);
  const minutes = Math.floor((magnitude % 3_600) / 60);

  // A trailing zero unit is dropped rather than printed: "4h 0m" is noise, and at the top
  // of the range it would read "1d 0h".
  const units: string[] = [];
  if (days > 0) units.push(`${days}d`);
  if (days > 0 || hours > 0) units.push(`${hours}h`);
  if (days === 0 && minutes > 0) units.push(`${minutes}m`);
  if (units.length === 0) units.push(`${magnitude % 60}s`);

  return `${units.slice(0, 2).join(' ')} ${seconds < 0 ? 'overdue' : 'left'}`;
}

/** Spoken form, so `d`/`h`/`m` are not read out as letters by a screen reader. */
export function spokenRemaining(seconds: number): string {
  const magnitude = Math.abs(Math.trunc(seconds));
  const days = Math.floor(magnitude / 86_400);
  const hours = Math.floor((magnitude % 86_400) / 3_600);
  const minutes = Math.floor((magnitude % 3_600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (days > 0 || hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (days === 0 && hours === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);

  return parts.slice(0, 2).join(' ');
}
