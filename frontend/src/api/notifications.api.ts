import { apiRequest } from './client';

/**
 * Notification centre and preference API (docs/29 §7/§12, docs/11 §9).
 *
 * Every call is self-scoped: the server reads the subject from the session, so the client
 * never sends a user id. Preferences are per event and per channel; a transactional event
 * cannot be disabled, and the server refuses an attempt rather than ignoring it (`29` N6).
 */

export type NotificationChannel = 'EMAIL' | 'SMS' | 'IN_APP';
export type NotificationClass = 'TRANSACTIONAL' | 'OPERATIONAL' | 'INFORMATIONAL';

export interface NotificationView {
  id: string;
  eventType: string;
  title: string | null;
  body: string | null;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  hasMore: boolean;
  unreadCount: number;
}

export interface PreferenceView {
  eventType: string;
  class: NotificationClass;
  channel: NotificationChannel;
  enabled: boolean;
  /** True for transactional events, which cannot be silenced. */
  mandatory: boolean;
}

export interface PreferenceInput {
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
}

export function listNotifications(
  params: { unreadOnly?: boolean; limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<NotificationPage> {
  const query = new URLSearchParams();
  if (params.unreadOnly) query.set('unreadOnly', 'true');
  if (params.limit) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiRequest<NotificationPage>(`/notifications${suffix}`, { signal });
}

export function readNotification(id: string): Promise<{ notification: NotificationView }> {
  return apiRequest<{ notification: NotificationView }>(`/notifications/${id}/read`, {
    method: 'POST',
  });
}

export function readAllNotifications(): Promise<{ updated: number }> {
  return apiRequest<{ updated: number }>('/notifications/read-all', { method: 'POST' });
}

export function listPreferences(signal?: AbortSignal): Promise<{ items: PreferenceView[] }> {
  return apiRequest<{ items: PreferenceView[] }>('/me/notification-preferences', { signal });
}

export function updatePreferences(
  preferences: PreferenceInput[],
): Promise<{ items: PreferenceView[] }> {
  return apiRequest<{ items: PreferenceView[] }>('/me/notification-preferences', {
    method: 'PUT',
    body: { preferences },
  });
}
