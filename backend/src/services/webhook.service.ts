import type { Prisma, WebhookDelivery, WebhookSubscription } from '@prisma/client';
import { config } from '../config';
import { assertPermission, type Principal } from '../helpers/authorization';
import { randomToken } from '../helpers/crypto';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signWebhookPayload,
} from '../integrations/webhook-signature';
import { fetchWebhookClient } from '../integrations/webhook-client';
import { getCircuitBreaker, runResilient } from '../integrations/resilience';
import type { WebhookHttpClient } from '../integrations';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  countDeadLetterDeliveries,
  createWebhookDeliveries,
  createWebhookSubscription,
  findWebhookDeliveryById,
  findWebhookSubscriptionById,
  getFanoutState,
  listDeadLetterDeliveries,
  listDueWebhookDeliveries,
  listEnabledSubscriptionsForEvent,
  listOrganizationsWithWebhooks,
  listOutboxAfter,
  listWebhookSubscriptions,
  markWebhookDelivered,
  recordWebhookFailure,
  requeueWebhookDelivery,
  setFanoutState,
  updateWebhookSubscription,
  writeAudit,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY, OUTBOX_EVENT } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Outbound webhooks — docs/32 §4.
 *
 * The governing rule is that **an integration failure must never touch the core domain**
 * (`docs/32` §1). Three structural choices enforce it here:
 *
 *   1. Nothing in this module runs on the request path. Subscription changes are ordinary
 *      audited writes; delivery happens only in the worker (`fanoutWebhooks` +
 *      `deliverPendingWebhooks`) driven by the scheduler.
 *   2. Fan-out reads the **durable outbox**, the same event stream the notification drain
 *      consumes, through its own cursor. Webhooks are therefore a second reader, never a
 *      coupling: a webhook problem cannot stall a notification, and vice versa.
 *   3. Delivery never throws. A failure is a retry with bounded backoff, then a
 *      dead-letter with an alert (§4, §8); the worker's caller only ever sees counts.
 *
 * The payload is **minimal** — an event id, the type, a timestamp and identifiers only
 * (§4). Sending the full record would copy data outside the system's classification
 * controls, so a receiver that needs detail calls the API under its own credentials.
 */

/** The event subscription vocabulary: the durable outbox event types (`docs/32` §4). */
export const SUBSCRIBABLE_EVENTS: readonly string[] = Object.values(OUTBOX_EVENT);

export interface WebhookSubscriptionView {
  id: string;
  description: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The last four characters of the secret, for the operator to match a receiver. Never the secret. */
  secretHint: string;
  deadLetterCount: number;
}

/** The create response is the **only** time the secret is returned (`docs/32` §7). */
export interface WebhookSubscriptionCreated extends WebhookSubscriptionView {
  secret: string;
}

export interface WebhookDeliveryView {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: WebhookDelivery['status'];
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new NotFoundError('Webhook subscriptions are tenant-scoped.');
  }
  return actor.organizationId;
}

function secretHint(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

function toSubscriptionView(
  row: WebhookSubscription,
  deadLetterCount: number,
): WebhookSubscriptionView {
  return {
    id: row.id,
    description: row.description,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    secretHint: secretHint(row.secret),
    deadLetterCount,
  };
}

export function toDeliveryView(row: WebhookDelivery): WebhookDeliveryView {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Rejects an event selection containing anything outside the durable event vocabulary. */
function assertKnownEvents(events: readonly string[]): void {
  const unknown = events.filter((event) => !SUBSCRIBABLE_EVENTS.includes(event));
  if (unknown.length > 0) {
    throw new ValidationError([
      { field: 'events', message: `Unknown webhook event(s): ${unknown.join(', ')}.` },
    ]);
  }
}

/** A subscription URL must be absolute HTTPS; an http target would put a signed payload in the clear. */
function assertSecureUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError([
      { field: 'url', message: 'The subscription URL must be an absolute URL.' },
    ]);
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError([{ field: 'url', message: 'The subscription URL must use HTTPS.' }]);
  }
}

export interface CreateSubscriptionInput {
  description: string;
  url: string;
  events: string[];
  enabled?: boolean;
}

/**
 * Creates a webhook subscription (`docs/32` §11/§12). The secret is generated server-side,
 * never supplied by the caller, and is returned **once**; after this call it exists only in
 * the database and in the receiver's configuration.
 */
export async function createWebhookSubscriptionForCaller(
  input: CreateSubscriptionInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<WebhookSubscriptionCreated> {
  assertPermission(actor, 'integration:manage');
  const organizationId = requireTenant(actor);
  assertSecureUrl(input.url);
  assertKnownEvents(input.events);

  const secret = randomToken(32);
  const created = await createWebhookSubscription({
    organizationId,
    description: input.description,
    url: input.url,
    secret,
    events: [...input.events],
    createdById: actor.userId,
  });

  // The audited "after" snapshot deliberately omits the secret (`docs/32` §7: credentials
  // never appear in an audit payload).
  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_SUBSCRIPTION_CREATE,
    entityType: AUDIT_ENTITY.WEBHOOK_SUBSCRIPTION,
    entityId: created.id,
    after: { description: created.description, url: created.url, events: created.events },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return { ...toSubscriptionView(created, 0), secret };
}

export async function listWebhookSubscriptionsForCaller(
  actor: Principal,
): Promise<WebhookSubscriptionView[]> {
  assertPermission(actor, 'integration:read');
  const organizationId = requireTenant(actor);
  const rows = await listWebhookSubscriptions(organizationId);
  const deadLetterCount = await countDeadLetterDeliveries(organizationId);
  return rows.map((row) => toSubscriptionView(row, deadLetterCount));
}

export interface UpdateSubscriptionInput {
  description?: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
  /** Rotates the signing secret (`docs/32` §4 secret rotation, §7 audited). */
  rotateSecret?: boolean;
}

export async function updateWebhookSubscriptionForCaller(
  id: string,
  input: UpdateSubscriptionInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<WebhookSubscriptionView> {
  assertPermission(actor, 'integration:manage');
  const organizationId = requireTenant(actor);

  const existing = await findWebhookSubscriptionById(id);
  if (!existing || existing.organizationId !== organizationId) {
    throw new NotFoundError('Webhook subscription not found.');
  }
  if (input.url !== undefined) assertSecureUrl(input.url);
  if (input.events !== undefined) assertKnownEvents(input.events);

  const secret = input.rotateSecret ? randomToken(32) : undefined;
  const updated = await updateWebhookSubscription(id, {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.events !== undefined ? { events: [...input.events] } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(secret ? { secret } : {}),
  });

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_SUBSCRIPTION_UPDATE,
    entityType: AUDIT_ENTITY.WEBHOOK_SUBSCRIPTION,
    entityId: id,
    before: {
      description: existing.description,
      url: existing.url,
      events: existing.events,
      enabled: existing.enabled,
    },
    // `secretRotated` is a fact worth auditing; the secret itself is not.
    after: {
      description: updated.description,
      url: updated.url,
      events: updated.events,
      enabled: updated.enabled,
      ...(secret ? { secretRotated: true } : {}),
    },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });

  return toSubscriptionView(updated, await countDeadLetterDeliveries(organizationId));
}

export async function listDeadLettersForCaller(
  actor: Principal,
  limit = 50,
): Promise<{ deliveries: WebhookDeliveryView[]; total: number }> {
  assertPermission(actor, 'integration:read');
  const organizationId = requireTenant(actor);
  const rows = await listDeadLetterDeliveries(organizationId, limit);
  return {
    deliveries: rows.map(toDeliveryView),
    total: await countDeadLetterDeliveries(organizationId),
  };
}

/** Returns a dead-lettered delivery to the queue (`docs/32` §11 `integration:retry`, audited). */
export async function retryDeadLetterForCaller(
  id: string,
  actor: Principal,
  meta: RequestMeta,
): Promise<WebhookDeliveryView> {
  assertPermission(actor, 'integration:retry');
  const organizationId = requireTenant(actor);

  const delivery = await findWebhookDeliveryById(id);
  if (
    !delivery ||
    delivery.organizationId !== organizationId ||
    delivery.status !== 'DEAD_LETTER'
  ) {
    throw new NotFoundError('Dead-lettered delivery not found.');
  }

  const requeued = await requeueWebhookDelivery(id);

  // An explicit retry is an operator asserting the subscriber has been fixed, so it clears
  // that subscription's circuit breaker. Without this, the automatic fast-fail would reject
  // the retry for the rest of the cooldown and the operator's action would appear to do
  // nothing — the breaker exists to stop *automatic* retries, not to overrule a human.
  getCircuitBreaker(`webhook:${delivery.subscriptionId}`).reset();

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.INTEGRATION_DEAD_LETTER_RETRY,
    entityType: AUDIT_ENTITY.WEBHOOK_SUBSCRIPTION,
    entityId: delivery.subscriptionId,
    after: { deliveryId: id, eventId: delivery.eventId },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp,
    userAgent: meta.userAgent,
  });
  return toDeliveryView(requeued);
}

/**
 * The **minimal** webhook payload (`docs/32` §4): an id, the event type, a timestamp, and
 * identifiers only. Any outbox payload key ending in `Id` with a string value is copied as a
 * subject identifier; nothing else is. That keeps record bodies and free text out of the
 * envelope, which is the point — a webhook is an exfiltration surface.
 */
export function buildWebhookPayload(
  eventId: string,
  eventType: string,
  occurredAt: Date,
  outboxPayload: Record<string, unknown>,
): Record<string, unknown> {
  const subject: Record<string, string> = {};
  for (const [key, value] of Object.entries(outboxPayload)) {
    if (key.endsWith('Id') && typeof value === 'string') subject[key] = value;
  }
  return { id: eventId, type: eventType, occurredAt: occurredAt.toISOString(), subject };
}

export interface FanoutResult {
  organizations: number;
  scanned: number;
  created: number;
}

export interface WebhookWorkerOptions {
  batchSize?: number;
  client?: WebhookHttpClient;
  now?: Date;
}

/**
 * Advances each tenant's cursor over the outbox and materialises deliveries for the events
 * its enabled subscriptions select. The cursor advances even for an event with no matching
 * subscription, so the stream is never re-scanned; the unique key on
 * `(subscriptionId, eventId)` makes a created delivery a no-op on replay.
 *
 * The cursor is per tenant and advanced only after the deliveries are written, so a crash
 * between the two replays the event rather than losing it.
 */
export async function fanoutWebhooks(
  batchSize = config.WEBHOOK_FANOUT_BATCH_SIZE,
): Promise<FanoutResult> {
  const organizations = await listOrganizationsWithWebhooks();
  const result: FanoutResult = { organizations: organizations.length, scanned: 0, created: 0 };

  for (const organizationId of organizations) {
    const { lastEventId } = await getFanoutState(organizationId);
    const events = await listOutboxAfter(organizationId, lastEventId, batchSize);
    if (events.length === 0) continue;

    for (const event of events) {
      result.scanned += 1;
      const subscriptions = await listEnabledSubscriptionsForEvent(organizationId, event.eventType);
      if (subscriptions.length > 0) {
        const payload = buildWebhookPayload(
          event.id,
          event.eventType,
          event.occurredAt,
          (event.payload ?? {}) as Record<string, unknown>,
        );
        result.created += await createWebhookDeliveries(
          subscriptions.map((subscription) => ({
            organizationId,
            subscriptionId: subscription.id,
            eventId: event.id,
            eventType: event.eventType,
            payload: payload as Prisma.InputJsonValue,
          })),
        );
      }
      await setFanoutState(organizationId, event.id);
    }
  }

  return result;
}

function backoffMs(attempts: number, jitter: () => number): number {
  const base = config.WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(base, 60 * 60_000);
  // Full jitter dampens a retry storm when many subscriptions fail at once (`docs/32` §8).
  return Math.floor(capped * (0.5 + 0.5 * jitter()));
}

/**
 * Signs and sends one delivery behind its own circuit breaker and bulkhead (`docs/32` §8).
 *
 * The isolation is **per subscription**: a subscriber that has gone dark trips its own
 * breaker and is failed fast, while every other subscriber keeps its capacity. Because the
 * breaker rejects before the call, an open circuit costs one map lookup rather than a
 * timeout, which is what stops a dead endpoint from stalling the whole delivery queue.
 */
async function attemptDelivery(
  delivery: WebhookDelivery,
  subscription: WebhookSubscription,
  client: WebhookHttpClient,
  now: Date,
): Promise<{ delivered: boolean; status?: number; failureReason?: string }> {
  const body = JSON.stringify(delivery.payload);
  const signature = signWebhookPayload(subscription.secret, body, now.getTime());
  const outcome = await runResilient(
    `webhook:${subscription.id}`,
    () =>
      client.send({
        url: subscription.url,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ServiceHub-Webhooks/1.0',
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: String(Math.floor(now.getTime() / 1000)),
          'X-ServiceHub-Event': delivery.eventType,
          'X-ServiceHub-Event-Id': delivery.eventId,
        },
        body,
        timeoutMs: config.WEBHOOK_TIMEOUT_MS,
      }),
    { isFailure: (result) => !result.delivered },
  );

  // A breaker or bulkhead rejection is just another failure result: the row is retried and,
  // if the remote stays down, dead-lettered and alerted like a transport failure.
  if (!outcome.ok) {
    return { delivered: false, failureReason: outcome.reason };
  }
  return outcome.value;
}

export interface WebhookDeliveryResult {
  scanned: number;
  delivered: number;
  failed: number;
  deadLettered: number;
  skipped: number;
}

/**
 * Delivers due webhook rows. Never throws: a subscriber failure becomes a retry or a
 * dead-letter, so one bad endpoint cannot reach the request path or another integration
 * (`docs/32` §1, §8 bulkhead).
 */
export async function deliverPendingWebhooks(
  options: WebhookWorkerOptions = {},
): Promise<WebhookDeliveryResult> {
  const client = options.client ?? fetchWebhookClient;
  const now = options.now ?? new Date();
  const limit = options.batchSize ?? config.WEBHOOK_DELIVERY_BATCH_SIZE;

  const result: WebhookDeliveryResult = {
    scanned: 0,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
  };
  const rows = await listDueWebhookDeliveries(now, limit);

  for (const row of rows) {
    result.scanned += 1;
    const subscription = await findWebhookSubscriptionById(row.subscriptionId);
    if (!subscription || !subscription.enabled) {
      // A disabled or removed subscription is terminal for queued rows: dead-letter them so
      // they are visible and explicitly retryable rather than retried forever.
      await recordWebhookFailure(row.id, {
        attempts: row.attempts,
        error: 'The subscription is disabled or no longer exists.',
        nextAttemptAt: null,
        responseStatus: undefined,
      });
      result.deadLettered += 1;
      continue;
    }

    let outcome: { delivered: boolean; status?: number; failureReason?: string };
    try {
      outcome = await attemptDelivery(row, subscription, client, now);
    } catch (error) {
      // The adapter is not supposed to throw; if a fake or future adapter does, treat it as
      // a delivery failure rather than letting it escape the worker.
      outcome = {
        delivered: false,
        failureReason: error instanceof Error ? error.message : 'Delivery failed.',
      };
    }

    if (outcome.delivered) {
      await markWebhookDelivered(row.id, outcome.status, now);
      result.delivered += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    const reason = outcome.failureReason ?? 'The subscriber did not accept the delivery.';
    if (attempts >= config.WEBHOOK_MAX_ATTEMPTS) {
      await recordWebhookFailure(row.id, {
        attempts,
        error: reason,
        nextAttemptAt: null,
        responseStatus: outcome.status,
      });
      logger.error(
        { deliveryId: row.id, eventId: row.eventId, attempts },
        'Webhook delivery dead-lettered after exhausting retries',
      );
      result.deadLettered += 1;
      continue;
    }

    await recordWebhookFailure(row.id, {
      attempts,
      error: reason,
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, Math.random)),
      responseStatus: outcome.status,
    });
    result.failed += 1;
  }

  return result;
}
