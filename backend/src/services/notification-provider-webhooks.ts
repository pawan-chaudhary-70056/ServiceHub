import { z } from 'zod';
import { MalformedRequestError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  findNotificationByProviderMessageId,
  markNotificationDead,
  markNotificationDelivered,
} from '../models';
import { registerInboundHandler, type InboundHandler } from './inbound-webhook.service';

/**
 * Notification provider webhooks (`docs/29` N8).
 *
 * > "Provider webhooks (bounce, complaint, delivery) update the `Notification` record —
 * > delivery is not 'sent', it is 'delivered'."
 *
 * That distinction is the whole point of this module. `SENT` means the provider *accepted*
 * the message; only the provider can say it arrived, and only the provider can say the
 * mailbox does not exist. Without these handlers the platform reports a bounce as a
 * successful send, and keeps re-sending to an address that will never accept anything.
 *
 * Three properties make this safe, and each is a real failure mode:
 *
 *   1. **The payload is untrusted input** (`docs/32` §5, `§18`): the signature proves origin
 *      and integrity, never shape. Every field is validated with Zod and read through a
 *      tolerant alias list, because providers disagree on key names and nesting.
 *   2. **Correlation is on the vendor message id**, which is exactly why the send path stores
 *      it (`integrations/index.ts`). An event for a message this platform never sent is a
 *      no-op, not an error — a stale event must not dead-letter the endpoint forever.
 *   3. **Both terminal outcomes stop retries.** A bounce marks the record `DEAD`, which is
 *      terminal for the outbox drain, so a broken address is not mailed again on every pass.
 *
 * A malformed event **throws**, deliberately: it is a defect in the provider's contract or
 * our parsing, the raw payload is retained for diagnosis, and the worker records a failure
 * with the reason rather than silently discarding it (`docs/32` §5).
 */

/** The provider event vocabulary this module acts on. Anything else is recorded only. */
export const PROVIDER_NOTIFICATION_EVENT = {
  DELIVERED: 'email.delivered',
  BOUNCED: 'email.bounced',
  COMPLAINED: 'email.complained',
} as const;

export type ProviderNotificationEvent =
  (typeof PROVIDER_NOTIFICATION_EVENT)[keyof typeof PROVIDER_NOTIFICATION_EVENT];

/**
 * Provider key aliases, in priority order.
 *
 * Deliberately excludes a bare `id`: in every provider format we accept, the top-level `id`
 * is the *event* id (already used for idempotency), and reading it as a message id would
 * correlate the event to the wrong row — or, worse, to none.
 */
const MESSAGE_ID_KEYS = [
  'messageId',
  'providerMessageId',
  'message_id',
  'message-id',
  'sg_message_id',
] as const;

const REASON_KEYS = ['reason', 'detail', 'description', 'error'] as const;
const RECIPIENT_KEYS = ['recipient', 'email', 'to'] as const;
const TIMESTAMP_KEYS = ['timestamp', 'occurredAt', 'created_at', 'time'] as const;

/** Sub-objects a provider may nest the event under instead of sending it flat. */
const NESTED_KEYS = ['data', 'event-data'] as const;

const providerEventSchema = z.object({
  messageId: z.string().trim().min(1).max(512),
  reason: z.string().trim().max(500).optional(),
  recipient: z.string().trim().max(320).optional(),
  occurredAt: z.coerce.date().optional(),
});

export type ProviderNotificationPayload = z.infer<typeof providerEventSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The payload and each nested object a provider may have wrapped it in, in priority order. */
function sources(payload: Record<string, unknown>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [payload];
  for (const key of NESTED_KEYS) {
    const nested = payload[key];
    if (isRecord(nested)) found.push(nested);
  }
  return found;
}

function firstString(list: readonly Record<string, unknown>[], keys: readonly string[]) {
  for (const source of list) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
  }
  return undefined;
}

function firstTimestamp(list: readonly Record<string, unknown>[], keys: readonly string[]) {
  for (const source of list) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' || typeof value === 'number') return value;
    }
  }
  return undefined;
}

/**
 * Reads and validates one provider event.
 *
 * Throws when the message id is absent, because without it the event cannot be applied to
 * anything and pretending otherwise would report a delivery that was never correlated. The
 * message names the defect, because it is what the dead-letter view shows a human.
 */
export function parseProviderNotificationEvent(
  payload: Record<string, unknown>,
  eventType: string,
): ProviderNotificationPayload {
  const list = sources(payload);
  const parsed = providerEventSchema.safeParse({
    messageId: firstString(list, MESSAGE_ID_KEYS),
    reason: firstString(list, REASON_KEYS),
    recipient: firstString(list, RECIPIENT_KEYS),
    occurredAt: firstTimestamp(list, TIMESTAMP_KEYS),
  });

  if (!parsed.success) {
    // A `MalformedRequestError`, not a field-level `ValidationError`: the worker records
    // `error.message` as the event's `lastError`, and a generic "the request failed
    // validation" would leave an operator staring at a dead-letter with no idea which field
    // was wrong. The message must therefore name the defect itself.
    throw new MalformedRequestError(
      `A ${eventType} event must carry the provider's message id, or it cannot be matched to a notification.`,
    );
  }
  return parsed.data;
}

/** Looks up the notification an event refers to, or null when nothing matches. */
async function findTarget(parsed: ProviderNotificationPayload, eventType: string) {
  const notification = await findNotificationByProviderMessageId(parsed.messageId);
  if (!notification) {
    // Not an error: a provider may deliver an event for a message sent before a restore, or
    // for a different environment sharing the provider account. Logging once is enough.
    logger.warn(
      { eventType, providerMessageId: parsed.messageId },
      'Provider event refers to an unknown message id; nothing to update',
    );
    return null;
  }
  return notification;
}

/**
 * `email.delivered` → `DELIVERED`.
 *
 * A late "delivered" after a recorded bounce is applied rather than ignored: the two
 * terminal states are both "do not send again", and the provider's latest statement about
 * the message is the more accurate one (a soft bounce is followed by a delivery).
 */
async function applyDelivered(payload: Record<string, unknown>, eventType: string): Promise<void> {
  const parsed = parseProviderNotificationEvent(payload, eventType);
  const notification = await findTarget(parsed, eventType);
  if (!notification || notification.status === 'DELIVERED') return;

  await markNotificationDelivered(notification.id, parsed.occurredAt ?? new Date());
}

/**
 * `email.bounced` / `email.complained` → `DEAD`.
 *
 * `DEAD`, not `FAILED`, is the deliberate choice: `FAILED` is non-terminal, so the drain
 * would retry it on the next pass — mailing an address the provider has already rejected,
 * forever, on every sweep. A bounce is a permanent statement about the address.
 */
async function applyUndeliverable(
  payload: Record<string, unknown>,
  eventType: string,
  summary: string,
): Promise<void> {
  const parsed = parseProviderNotificationEvent(payload, eventType);
  const notification = await findTarget(parsed, eventType);
  if (!notification || notification.status === 'DEAD') return;

  const reason = parsed.reason ? `${summary} (${parsed.reason})` : summary;
  await markNotificationDead(notification.id, reason.slice(0, 500));
}

const HANDLERS: ReadonlyArray<readonly [ProviderNotificationEvent, InboundHandler]> = [
  [
    PROVIDER_NOTIFICATION_EVENT.DELIVERED,
    (event) => applyDelivered(event.payload, event.eventType),
  ],
  [
    PROVIDER_NOTIFICATION_EVENT.BOUNCED,
    (event) =>
      applyUndeliverable(
        event.payload,
        event.eventType,
        'The email provider reported a bounce; the address did not accept the message.',
      ),
  ],
  [
    PROVIDER_NOTIFICATION_EVENT.COMPLAINED,
    (event) =>
      applyUndeliverable(
        event.payload,
        event.eventType,
        'The recipient marked the message as spam.',
      ),
  ],
];

/**
 * Registers the three handlers on the inbound registry.
 *
 * Called from both entrypoints (`server.ts`, `worker.ts`) rather than on import, because a
 * module that registers itself by being imported is a side effect nobody can trace — and
 * the registry is only consulted by the process that runs the inbound worker.
 */
export function registerNotificationProviderHandlers(): void {
  for (const [eventType, handler] of HANDLERS) {
    registerInboundHandler(eventType, handler);
  }
}
