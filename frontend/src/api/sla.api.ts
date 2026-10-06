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
