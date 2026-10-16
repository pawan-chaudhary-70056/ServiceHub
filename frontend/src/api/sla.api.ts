import { apiRequest } from './client';
import type { Priority } from './catalog.api';

/** SLA configuration API (docs/25 §11). Administrator-only; the server enforces it. */

export interface SlaTarget {
  id: string;
  priority: Priority;
  responseMinutes: number;
  resolveMinutes: number;
  warnPercent: number;
}

export interface BusinessCalendar {
  id: string;
  name: string;
  timeZone: string;
  model: 'WORKING_HOURS' | 'WALL_CLOCK';
  workingHours: unknown;
  holidays: unknown;
  version: number;
  isActive: boolean;
}

export interface SlaPolicy {
  id: string;
  name: string;
  calendarId: string;
  pauseStates: string[];
  isActive: boolean;
  isDefault: boolean;
  targets: SlaTarget[];
  calendar: BusinessCalendar;
}

export function listPolicies(signal?: AbortSignal): Promise<{ items: SlaPolicy[] }> {
  return apiRequest<{ items: SlaPolicy[] }>('/sla/policies', { signal });
}

export function listCalendars(signal?: AbortSignal): Promise<{ items: BusinessCalendar[] }> {
  return apiRequest<{ items: BusinessCalendar[] }>('/sla/calendars', { signal });
}

export interface CreateCalendarInput {
  name: string;
  timeZone: string;
  model: 'WORKING_HOURS' | 'WALL_CLOCK';
  workingHours: Record<string, Array<{ start: string; end: string }>>;
  holidays: string[];
}

/**
 * Creating a calendar is one of the two calendar writes in the API. A calendar a clock
 * already references is immutable, so both writes obey the same rule: the result is a
 * **new version** rather than an edit of the row in flight records were computed against
 * (`docs/25` §4 rule 6). Creating starts version 1; editing bumps it.
 */
export function createCalendar(
  input: CreateCalendarInput,
): Promise<{ calendar: BusinessCalendar }> {
  return apiRequest<{ calendar: BusinessCalendar }>('/sla/calendars', {
    method: 'POST',
    body: input,
  });
}

/**
 * Edits a calendar by creating the next version (`docs/25` §4 rule 6, §11).
 *
 * The response is the **new** version — its id is what to address from now on. The old
 * version stays readable but superseded, in-flight clocks keep the `targetAt` computed
 * under it, and policies are moved onto the successor by the server so new records use
 * the new hours.
 */
export function updateCalendar(
  id: string,
  input: Partial<CreateCalendarInput>,
): Promise<{ calendar: BusinessCalendar }> {
  return apiRequest<{ calendar: BusinessCalendar }>(`/sla/calendars/${id}`, {
    method: 'PATCH',
    body: input,
  });
}

export interface SlaTargetInput {
  priority: Priority;
  responseMinutes: number;
  resolveMinutes: number;
  warnPercent: number;
}

export interface PolicyInput {
  name: string;
  calendarId: string;
  pauseStates: string[];
  isActive: boolean;
  isDefault: boolean;
  targets: SlaTargetInput[];
}

export function createPolicy(input: PolicyInput): Promise<{ policy: SlaPolicy }> {
  return apiRequest<{ policy: SlaPolicy }>('/sla/policies', { method: 'POST', body: input });
}

/**
 * A policy edit is safe in place: in-flight clocks store their target instants, so a change
 * here cannot retroactively move a deadline (`docs/25` §4 example 5, §14 AC4).
 */
export function updatePolicy(
  id: string,
  input: Partial<PolicyInput>,
): Promise<{ policy: SlaPolicy }> {
  return apiRequest<{ policy: SlaPolicy }>(`/sla/policies/${id}`, { method: 'PATCH', body: input });
}

/**
 * SLA clock state as the API publishes it (`docs/25` §12).
 *
 * `state` is derived server-side from the stored timestamps at read time, so it always
 * agrees with `remainingSeconds`; the UI must render both together, because a state without
 * a number is not actionable.
 */
export type SlaClockState = 'ON_TRACK' | 'AT_RISK' | 'PAUSED' | 'BREACHED' | 'STOPPED';

export interface SlaClock {
  id: string;
  cycle: number;
  priority: Priority;
  state: SlaClockState;
  startedAt: string;
  targetAt: string;
  warnAt: string;
  breachedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  totalPausedSeconds: number;
  /** Seconds until the frozen target; negative once it has passed. */
  remainingSeconds: number;
}

export function getClock(id: string, signal?: AbortSignal): Promise<{ clock: SlaClock }> {
  return apiRequest<{ clock: SlaClock }>(`/sla/clocks/${id}`, { signal });
}

/** An explicit correction to a clock: move the target, clear a breach, or both. */
export function overrideClock(
  id: string,
  input: { reason: string; targetAt?: string; clearBreach?: boolean },
): Promise<{ clock: SlaClock }> {
  return apiRequest<{ clock: SlaClock }>(`/sla/clocks/${id}/override`, {
    method: 'POST',
    body: input,
  });
}
