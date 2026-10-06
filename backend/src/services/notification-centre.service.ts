import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { encodeCursor, type CursorPage } from '../utils/pagination';
import {
  countUnreadNotifications,
  listPreferences,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  upsertPreference,
  prisma,
  type Notification,
} from '../models';
import {
  isMandatory,
  listEventDefinitions,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationClass,
} from './notification-events';

/**
 * The notification centre and preferences (`docs/29` §7, §12).
 *
 * Everything here is **self-scoped**: a caller reads and changes only their own
 * notifications and preferences. There is no cross-user path, which is what makes the
 * surface safe without a bespoke permission.
 *
 * Preferences are per event and per channel (`§7`). The list is the full matrix with the
 * stored overrides applied, so the UI can explain the mandatory classes rather than showing
 * a toggle that will be refused (`§7`).
 */

export interface PreferenceView {
  eventType: string;
  class: NotificationClass;
  channel: NotificationChannel;
  enabled: boolean;
  /** True for TRANSACTIONAL events, which cannot be silenced (`29` N6). */
  mandatory: boolean;
}

export interface PreferenceInput {
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationView {
  id: string;
  eventType: string;
  title: string | null;
  body: string | null;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage extends CursorPage<NotificationView> {
  unreadCount: number;
}

function requireActorId(actorId: string | undefined): string {
  if (!actorId) {
    throw new ForbiddenError('Only an authenticated user has a notification centre.');
  }
  return actorId;
}

function toView(notification: Notification): NotificationView {
  return {
    id: notification.id,
    eventType: notification.eventType,
    title: notification.title,
    body: notification.body,
    linkUrl: notification.linkUrl,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

/** The full preference matrix with stored overrides applied (`docs/29` §7). */
export async function listMyPreferences(actorId: string | undefined): Promise<PreferenceView[]> {
  const userId = requireActorId(actorId);
  const stored = await listPreferences(userId);
  const overrides = new Map(stored.map((row) => [`${row.eventType}:${row.channel}`, row.enabled]));

  const items: PreferenceView[] = [];
  for (const definition of listEventDefinitions()) {
    for (const channel of NOTIFICATION_CHANNELS) {
      items.push({
        eventType: definition.eventType,
        class: definition.class,
        channel,
        // Absent means the default (enabled); a mandatory class always reads enabled.
        enabled: isMandatory(definition.eventType)
          ? true
          : (overrides.get(`${definition.eventType}:${channel}`) ?? true),
        mandatory: isMandatory(definition.eventType),
      });
    }
  }
  return items;
}

/**
 * Applies preference overrides. A change that would silence a TRANSACTIONAL event is
 * refused (`29` N6) rather than silently ignored — a toggle that does nothing is worse than
 * no toggle.
 */
export async function updateMyPreferences(
  actorId: string | undefined,
  input: { preferences: PreferenceInput[] },
): Promise<PreferenceView[]> {
  const userId = requireActorId(actorId);
  const known = new Set(listEventDefinitions().map((definition) => definition.eventType));

  const details = [];
  for (const preference of input.preferences) {
    if (!known.has(preference.eventType)) {
      details.push({
        field: 'preferences',
        code: 'UNKNOWN_EVENT',
        message: `Unknown notification event: ${preference.eventType}.`,
      });
    }
    if (isMandatory(preference.eventType) && preference.enabled === false) {
      details.push({
        field: 'preferences',
        code: 'MANDATORY',
        message: `${preference.eventType} is a transactional notification and cannot be disabled.`,
      });
    }
  }
  if (details.length > 0) {
    throw new ValidationError(details);
  }

  if (input.preferences.length > 0) {
    await prisma.$transaction(
      input.preferences.map((preference) =>
        upsertPreference({
          userId,
          eventType: preference.eventType,
          channel: preference.channel,
          enabled: preference.enabled,
        }),
      ),
    );
  }

  return listMyPreferences(userId);
}

/** The caller's own in-app notifications, newest first (`docs/29` §12). */
export async function listMyNotifications(
  actorId: string | undefined,
  params: { unreadOnly?: boolean; limit: number; cursor?: string },
): Promise<NotificationPage> {
  const userId = requireActorId(actorId);
  const rows = await listUserNotifications({
    userId,
    unreadOnly: params.unreadOnly,
    limit: params.limit,
    cursor: params.cursor,
  });

  const hasMore = rows.length > params.limit;
  const page = rows.slice(0, params.limit);
  const last = page[page.length - 1];
  const unreadCount = await countUnreadNotifications(userId);

  return {
    items: page.map(toView),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    hasMore,
    unreadCount,
  };
}

/** Marks one of the caller's notifications read; another user's row is a `404`. */
export async function readNotification(
  actorId: string | undefined,
  id: string,
): Promise<NotificationView> {
  const userId = requireActorId(actorId);
  const notification = await findOwnedNotification(userId, id);
  const updated = notification.readAt ? notification : await markNotificationRead(id);
  return toView(updated);
}

/** Marks every unread notification read; idempotent (`§12`). */
export async function readAllNotifications(
  actorId: string | undefined,
): Promise<{ updated: number }> {
  const userId = requireActorId(actorId);
  const result = await markAllNotificationsRead(userId);
  return { updated: result.count };
}

async function findOwnedNotification(userId: string, id: string): Promise<Notification> {
  const notification = await prisma.notification.findUnique({ where: { id } });
  // A notification the caller does not own is indistinguishable from one that does not exist.
  if (!notification || notification.userId !== userId) {
    throw new NotFoundError('Notification not found.');
  }
  return notification;
}
