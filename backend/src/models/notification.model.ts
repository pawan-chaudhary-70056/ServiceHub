import type { Notification, Prisma } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
import { prisma, type DataClient } from './db';

/** Re-exported so services can name the row type without importing Prisma directly. */
export type { Notification };

/**
 * Notification persistence and outbox drain queries (`docs/29` §3, §9).
 *
 * The outbox row is the domain event; a `Notification` is the per-recipient delivery
 * record. `dedupeKey` is unique, so a redelivered event reuses the same row and cannot
 * produce a visible duplicate (`docs/29` N3). Only `services/` may import this module.
 */

export interface CreateNotificationInput {
  organizationId: string | null;
  userId: string | null;
  recipient: string;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  eventType: string;
  templateVersion: string;
  dedupeKey: string;
  title?: string | null;
  body?: string | null;
  linkUrl?: string | null;
  /** Set for in-app rows, which are delivered by being inserted. */
  status?: Notification['status'];
  sentAt?: Date;
  failureReason?: string | null;
}

export interface NotificationListParams {
  userId: string;
  unreadOnly?: boolean;
  limit: number;
  /** Encodes `(createdAt, id)`; see `utils/pagination`. */
  cursor?: string;
}

/** The caller's own in-app notifications, newest first, cursor-paginated (`docs/29` §12). */
export function listUserNotifications(
  params: NotificationListParams,
  client: DataClient = prisma,
): Promise<Notification[]> {
  const { sortValue, id } = params.cursor ? decodeCursor(params.cursor) : { sortValue: '', id: '' };

  const conditions: Prisma.NotificationWhereInput[] = [];
  if (params.cursor) {
    conditions.push({
      OR: [
        { createdAt: { lt: new Date(sortValue) } },
        { createdAt: new Date(sortValue), id: { lt: id } },
      ],
    });
  }

  return client.notification.findMany({
    where: {
      userId: params.userId,
      channel: 'IN_APP',
      ...(params.unreadOnly ? { readAt: null } : {}),
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
  });
}

export function countUnreadNotifications(
  userId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.notification.count({ where: { userId, channel: 'IN_APP', readAt: null } });
}

export function findNotificationById(
  id: string,
  client: DataClient = prisma,
): Promise<Notification | null> {
  return client.notification.findUnique({ where: { id } });
}

/** Marks one in-app notification read; idempotent (`29` §12). */
export function markNotificationRead(
  id: string,
  client: DataClient = prisma,
): Promise<Notification> {
  return client.notification.update({ where: { id }, data: { readAt: new Date() } });
}

export function markAllNotificationsRead(
  userId: string,
  client: DataClient = prisma,
): Promise<Prisma.BatchPayload> {
  return client.notification.updateMany({
    where: { userId, channel: 'IN_APP', readAt: null },
    data: { readAt: new Date() },
  });
}

// ===========================================================================
// Preferences (`docs/29` §7)
// ===========================================================================

export function listPreferences(userId: string, client: DataClient = prisma) {
  return client.notificationPreference.findMany({ where: { userId } });
}

/** The stored override for one (event, channel), or null when the default applies. */
export function findPreference(
  userId: string,
  eventType: string,
  channel: 'EMAIL' | 'SMS' | 'IN_APP',
  client: DataClient = prisma,
) {
  return client.notificationPreference.findUnique({
    where: { userId_eventType_channel: { userId, eventType, channel } },
  });
}

export function upsertPreference(
  input: {
    userId: string;
    eventType: string;
    channel: 'EMAIL' | 'SMS' | 'IN_APP';
    enabled: boolean;
  },
  client: DataClient = prisma,
) {
  return client.notificationPreference.upsert({
    where: {
      userId_eventType_channel: {
        userId: input.userId,
        eventType: input.eventType,
        channel: input.channel,
      },
    },
    update: { enabled: input.enabled },
    create: input,
  });
}

export function findNotificationByDedupeKey(
  dedupeKey: string,
  client: DataClient = prisma,
): Promise<Notification | null> {
  return client.notification.findUnique({ where: { dedupeKey } });
}

export function createNotification(
  input: CreateNotificationInput,
  client: DataClient = prisma,
): Promise<Notification> {
  return client.notification.create({ data: input });
}

export function markNotificationSent(
  id: string,
  providerMessageId: string | null,
  client: DataClient = prisma,
): Promise<Notification> {
  return client.notification.update({
    where: { id },
    data: { status: 'SENT', providerMessageId, sentAt: new Date(), failureReason: null },
  });
}

export function markNotificationSkipped(
  id: string,
  reason: string,
  client: DataClient = prisma,
): Promise<Notification> {
  return client.notification.update({
    where: { id },
    data: { status: 'SKIPPED', failureReason: reason },
  });
}

/** Records a failed attempt and returns the row so the caller can read `attempts`. */
export function recordNotificationFailure(
  id: string,
  reason: string,
  client: DataClient = prisma,
): Promise<Notification> {
  return client.notification.update({
    where: { id },
    data: { status: 'FAILED', failureReason: reason, attempts: { increment: 1 } },
  });
}

export function markNotificationDead(
  id: string,
  reason: string,
  client: DataClient = prisma,
): Promise<Notification> {
  return client.notification.update({
    where: { id },
    data: { status: 'DEAD', failureReason: reason },
  });
}

// ===========================================================================
// Outbox drain
// ===========================================================================

/** Undrained rows, oldest first — the drain order, so an event cannot starve (`docs/29` N1). */
export function listUndrainedOutbox(limit: number, client: DataClient = prisma) {
  return client.outbox.findMany({
    where: { processedAt: null },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

export function markOutboxProcessed(id: string, client: DataClient = prisma) {
  return client.outbox.update({ where: { id }, data: { processedAt: new Date() } });
}

/** Bumps the attempt count and records the last error; the row stays undrained for retry. */
export function recordOutboxFailure(id: string, error: string, client: DataClient = prisma) {
  return client.outbox.update({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: error },
  });
}

/** Typed payload accessor: the JSON column is untyped at the boundary. */
export function outboxPayload(row: { payload: Prisma.JsonValue }): Record<string, unknown> {
  return typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
    ? (row.payload as Record<string, unknown>)
    : {};
}
