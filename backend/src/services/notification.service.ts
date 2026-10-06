import { config } from '../config';
import type { EmailAdapter } from '../integrations';
import { emailAdapter } from '../integrations/email';
import {
  createNotification,
  findNotificationByDedupeKey,
  findPreference,
  findUserByEmail,
  listUndrainedOutbox,
  markNotificationDead,
  markNotificationSent,
  markNotificationSkipped,
  markOutboxProcessed,
  outboxPayload,
  recordNotificationFailure,
  recordOutboxFailure,
} from '../models';
import { logger } from '../utils/logger';
import { getEventDefinition, inAppRecipientIds, isMandatory } from './notification-events';
import { resolveNotificationTemplate } from './notification-templates';

/**
 * The notifications drain worker (`docs/29` §3, §4, §7, §10, F-12).
 *
 * It performs the architecture's five steps — resolve recipients, apply preferences, render
 * the template, deliver via the adapter, record the `Notification` — and now delivers on two
 * channels:
 *
 *   - **EMAIL** via the provider adapter, with the full retry/dead-letter behaviour.
 *   - **IN_APP** into the notification centre, which is local and idempotent.
 *
 * Two invariants make it safe to run on every instance:
 *
 *   - **Idempotent.** `Notification.dedupeKey` is `(eventId, recipient, channel)` (`29`
 *     N3), so a redelivered event reuses the row and does not send again (N4).
 *   - **Never throws.** A provider failure is a retry, then a dead-letter with an alert
 *     (N7); it is never an exception onto the request path.
 *
 * Preferences (`§7`) are applied at send time (N5): a disabled OPERATIONAL/INFORMATIONAL
 * preference suppresses the send, while a TRANSACTIONAL event ignores its preference (N6) —
 * a password reset cannot be opted out of.
 */

export interface DrainResult {
  scanned: number;
  delivered: number;
  inApp: number;
  alreadyDone: number;
  failed: number;
  deadLettered: number;
  skipped: number;
  notDue: number;
}

/** Terminal states: a notification in one of these is never sent again. */
const TERMINAL_STATUSES = new Set(['SENT', 'DELIVERED', 'DEAD', 'SKIPPED']);

function backoffMs(attempts: number): number {
  const raw = config.NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(raw, 60 * 60_000);
}

/** Whether the recipient has opted out of this event on this channel (`docs/29` §7). */
async function isSuppressed(
  userId: string,
  eventType: string,
  channel: 'EMAIL' | 'IN_APP',
): Promise<boolean> {
  if (isMandatory(eventType)) return false;
  const preference = await findPreference(userId, eventType, channel);
  return preference ? !preference.enabled : false;
}

/** Creates the in-app rows for an event, if it is in-app notifiable and has recipients. */
async function deliverInApp(
  row: { id: string; organizationId: string | null; eventType: string },
  payload: Record<string, unknown>,
  result: DrainResult,
): Promise<void> {
  const definition = getEventDefinition(row.eventType);
  if (!definition?.inApp) return;

  const recipients = inAppRecipientIds(payload);
  for (const userId of recipients) {
    const dedupeKey = `${row.eventType}:${row.id}:${userId}:IN_APP`;
    const existing = await findNotificationByDedupeKey(dedupeKey);
    if (existing) continue;

    if (await isSuppressed(userId, row.eventType, 'IN_APP')) {
      await createNotification({
        organizationId: row.organizationId,
        userId,
        recipient: userId,
        channel: 'IN_APP',
        eventType: row.eventType,
        templateVersion: 'in-app-v1',
        dedupeKey,
        status: 'SKIPPED',
        title: definition.inApp.title,
        linkUrl: definition.inApp.link(payload),
        failureReason: 'Suppressed by the recipient’s notification preference.',
      });
      continue;
    }

    await createNotification({
      organizationId: row.organizationId,
      userId,
      recipient: userId,
      channel: 'IN_APP',
      eventType: row.eventType,
      templateVersion: 'in-app-v1',
      dedupeKey,
      status: 'SENT',
      sentAt: new Date(),
      title: definition.inApp.title,
      linkUrl: definition.inApp.link(payload),
    });
    result.inApp += 1;
  }
}

/**
 * Drains up to `batchSize` undrained outbox rows. The adapter and clock are injectable so
 * tests can drive the pipeline deterministically (`docs/37` §3).
 */
export async function drainOutbox(
  options: { adapter?: EmailAdapter; now?: Date; batchSize?: number } = {},
): Promise<DrainResult> {
  const adapter = options.adapter ?? emailAdapter;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? config.NOTIFICATION_DRAIN_BATCH_SIZE;

  const result: DrainResult = {
    scanned: 0,
    delivered: 0,
    inApp: 0,
    alreadyDone: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
    notDue: 0,
  };

  const rows = await listUndrainedOutbox(batchSize);
  for (const row of rows) {
    result.scanned += 1;
    const payload = outboxPayload(row);

    // In-app delivery is local and independent of any provider, so it is attempted first
    // and never blocks on an email failure.
    await deliverInApp(row, payload, result);

    const template = resolveNotificationTemplate(row.eventType);
    const definition = getEventDefinition(row.eventType);

    if (!template) {
      if (!definition?.inApp) {
        logger.warn(
          { eventType: row.eventType, outboxId: row.id },
          'No notification template or in-app definition for event; skipped',
        );
        result.skipped += 1;
      }
      await markOutboxProcessed(row.id);
      continue;
    }

    const recipient = template.recipient(payload);
    if (!recipient) {
      logger.warn(
        { eventType: row.eventType, outboxId: row.id },
        'Notification event has no recipient',
      );
      await markOutboxProcessed(row.id);
      result.skipped += 1;
      continue;
    }

    const dedupeKey = `${row.eventType}:${row.id}:${recipient}:EMAIL`;
    let notification = await findNotificationByDedupeKey(dedupeKey);

    if (notification && TERMINAL_STATUSES.has(notification.status)) {
      await markOutboxProcessed(row.id);
      result.alreadyDone += 1;
      continue;
    }

    // Preference is applied at the last moment (`29` N5), except for mandatory events (N6).
    const recipientUser = await findUserByEmail(recipient);
    if (recipientUser && (await isSuppressed(recipientUser.id, row.eventType, 'EMAIL'))) {
      notification ??= await createNotification({
        organizationId: row.organizationId,
        userId: recipientUser.id,
        recipient,
        channel: 'EMAIL',
        eventType: row.eventType,
        templateVersion: template.version,
        dedupeKey,
      });
      await markNotificationSkipped(notification.id, 'Suppressed by the recipient’s preference.');
      await markOutboxProcessed(row.id);
      result.skipped += 1;
      continue;
    }

    if (row.attempts > 0 && now.getTime() < row.occurredAt.getTime() + backoffMs(row.attempts)) {
      result.notDue += 1;
      continue;
    }

    notification ??= await createNotification({
      organizationId: row.organizationId,
      userId: recipientUser?.id ?? null,
      recipient,
      channel: 'EMAIL',
      eventType: row.eventType,
      templateVersion: template.version,
      dedupeKey,
    });

    const message = template.render(payload);
    const outcome = await adapter.send({
      to: recipient,
      from: config.EMAIL_FROM ?? 'no-reply@servicehub.local',
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    if (outcome.accepted) {
      await markNotificationSent(notification.id, outcome.providerMessageId ?? null);
      await markOutboxProcessed(row.id);
      result.delivered += 1;
      continue;
    }

    const reason = outcome.failureReason ?? 'Delivery was rejected by the provider.';
    const updated = await recordNotificationFailure(notification.id, reason);

    if (updated.attempts >= config.NOTIFICATION_MAX_ATTEMPTS) {
      await markNotificationDead(notification.id, reason);
      await markOutboxProcessed(row.id);
      logger.error(
        { eventType: row.eventType, outboxId: row.id, attempts: updated.attempts },
        'Notification dead-lettered after exhausting retries',
      );
      result.deadLettered += 1;
      continue;
    }

    await recordOutboxFailure(row.id, reason);
    result.failed += 1;
  }

  return result;
}
