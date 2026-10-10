import { config } from '../config';
import type { EmailAdapter } from '../integrations';
import { emailAdapter } from '../integrations/email';
import { runResilient } from '../integrations/resilience';
import {
  createNotification,
  findNotificationByDedupeKey,
  findNotifiableUserIds,
  findPreference,
  findUserByEmail,
  findUserById,
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
import { resolveNotificationTemplate, type NotificationTemplate } from './notification-templates';

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

/**
 * One email recipient: the address to send to, and the user row behind it when there is one
 * (a preference needs a user, and the notification record is linked to one).
 */
interface EmailRecipient {
  userId: string | null;
  address: string;
}

/**
 * Resolves an event's recipients to addresses (`docs/29` §4 step 1).
 *
 * Two sources, in the order the template declares them: an address written into the payload
 * (onboarding only), and payload **user ids** looked up at send time. The lookup is the
 * point of the id-based form — an event queued before someone changed their mailbox goes to
 * the new one, and the queue never holds a mail address. An id that no longer resolves to a
 * user, or resolves outside this event's tenant, is logged and skipped rather than failing
 * the event: the person has left and the other recipients still deserve their mail.
 */
async function resolveEmailRecipients(
  template: NotificationTemplate,
  payload: Record<string, unknown>,
  organizationId: string | null,
): Promise<EmailRecipient[]> {
  const recipients: EmailRecipient[] = [];
  const addresses = new Set<string>();

  const direct = template.recipient?.(payload) ?? null;
  if (direct) {
    addresses.add(direct);
    recipients.push({ userId: (await findUserByEmail(direct))?.id ?? null, address: direct });
  }

  const declared = template.recipientUserIds?.(payload) ?? [];
  const notifiable = new Set(await findNotifiableUserIds(declared, organizationId));
  const dropped = [...new Set(declared)].filter((id) => !notifiable.has(id));
  if (dropped.length > 0) {
    logger.warn(
      { eventType: template.eventType, dropped },
      'Notification recipients dropped: they do not resolve inside this event’s tenant',
    );
  }

  for (const id of notifiable) {
    const user = await findUserById(id);
    if (!user || addresses.has(user.email)) continue;
    addresses.add(user.email);
    recipients.push({ userId: user.id, address: user.email });
  }

  return recipients;
}

/** Creates the in-app rows for an event, if it is in-app notifiable and has recipients. */
async function deliverInApp(
  row: { id: string; organizationId: string | null; eventType: string },
  payload: Record<string, unknown>,
  result: DrainResult,
): Promise<void> {
  const definition = getEventDefinition(row.eventType);
  if (!definition?.inApp) return;

  // The payload names people; the recipients must still resolve inside the event's tenant,
  // or the row would surface another tenant's work in someone's in-app centre (ADR-0002).
  const declared = inAppRecipientIds(payload);
  const recipients = await findNotifiableUserIds(declared, row.organizationId);
  if (recipients.length < declared.length) {
    logger.warn(
      { eventType: row.eventType, outboxId: row.id, declared: declared.length },
      'In-app recipients dropped: they do not resolve inside this event’s tenant',
    );
  }

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

    const recipients = await resolveEmailRecipients(template, payload, row.organizationId);
    if (recipients.length === 0) {
      logger.warn(
        { eventType: row.eventType, outboxId: row.id },
        'Notification event has no recipient',
      );
      await markOutboxProcessed(row.id);
      result.skipped += 1;
      continue;
    }

    // Bounded backoff applies to the whole event row, before any send this pass.
    if (row.attempts > 0 && now.getTime() < row.occurredAt.getTime() + backoffMs(row.attempts)) {
      result.notDue += 1;
      continue;
    }

    // One event can address several people (an approval step has a list of approvers), so
    // each recipient is delivered independently under its own dedupe key (`29` N3). The row
    // is released only once every recipient is terminal: a recipient still awaiting a retry
    // keeps it undrained, and the recipients already SENT are skipped on the next pass
    // rather than mailed twice (N4).
    let retry = false;
    let failureReason: string | null = null;

    for (const recipient of recipients) {
      const dedupeKey = `${row.eventType}:${row.id}:${recipient.address}:EMAIL`;
      let notification = await findNotificationByDedupeKey(dedupeKey);

      if (notification && TERMINAL_STATUSES.has(notification.status)) {
        result.alreadyDone += 1;
        continue;
      }

      // Preference is applied at the last moment (`29` N5), except for mandatory events (N6).
      if (recipient.userId && (await isSuppressed(recipient.userId, row.eventType, 'EMAIL'))) {
        notification ??= await createNotification({
          organizationId: row.organizationId,
          userId: recipient.userId,
          recipient: recipient.address,
          channel: 'EMAIL',
          eventType: row.eventType,
          templateVersion: template.version,
          dedupeKey,
        });
        await markNotificationSkipped(notification.id, 'Suppressed by the recipient’s preference.');
        result.skipped += 1;
        continue;
      }

      notification ??= await createNotification({
        organizationId: row.organizationId,
        userId: recipient.userId,
        recipient: recipient.address,
        channel: 'EMAIL',
        eventType: row.eventType,
        templateVersion: template.version,
        dedupeKey,
      });

      const message = template.render(payload);
      // The email provider is one named integration (`docs/32` §8): while it is down its
      // breaker is open, so the rest of this batch fails fast instead of each recipient
      // paying a full provider timeout. A rejection is recorded like any provider failure,
      // so the row retries and eventually dead-letters rather than silently disappearing.
      const outcome = await runResilient(
        'email',
        () =>
          adapter.send({
            to: recipient.address,
            from: config.EMAIL_FROM ?? 'no-reply@servicehub.local',
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
        { isFailure: (result) => !result.accepted },
      );

      if (outcome.ok && outcome.value.accepted) {
        await markNotificationSent(notification.id, outcome.value.providerMessageId ?? null);
        result.delivered += 1;
        continue;
      }

      const reason =
        (outcome.ok ? outcome.value.failureReason : outcome.reason) ??
        'Delivery was rejected by the provider.';
      const updated = await recordNotificationFailure(notification.id, reason);

      if (updated.attempts >= config.NOTIFICATION_MAX_ATTEMPTS) {
        await markNotificationDead(notification.id, reason);
        logger.error(
          {
            eventType: row.eventType,
            outboxId: row.id,
            recipient: recipient.address,
            attempts: updated.attempts,
          },
          'Notification dead-lettered after exhausting retries',
        );
        result.deadLettered += 1;
        continue;
      }

      retry = true;
      failureReason = reason;
      result.failed += 1;
    }

    if (retry) {
      await recordOutboxFailure(row.id, failureReason ?? 'Delivery failed.');
      continue;
    }

    await markOutboxProcessed(row.id);
  }

  return result;
}
