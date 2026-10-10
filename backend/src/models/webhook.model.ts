import type { Prisma, WebhookDelivery, WebhookSubscription } from '@prisma/client';
import { prisma, type DataClient } from './db';

/** Re-exported so services can name the row types without importing Prisma directly. */
export type { WebhookDelivery, WebhookSubscription };

/**
 * Webhook subscription and delivery persistence (`docs/32` §4).
 *
 * The subscription holds the endpoint, the event selection and the **signing secret**; the
 * delivery holds one attempt-chain for one event to one subscription. Both are tenant-scoped,
 * and the fan-out state is a per-organisation cursor over the shared outbox stream.
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

export interface CreateWebhookSubscriptionInput {
  organizationId: string;
  description: string;
  url: string;
  secret: string;
  events: string[];
  createdById: string;
}

export function createWebhookSubscription(
  input: CreateWebhookSubscriptionInput,
  client: DataClient = prisma,
): Promise<WebhookSubscription> {
  return client.webhookSubscription.create({ data: input });
}

export function findWebhookSubscriptionById(
  id: string,
  client: DataClient = prisma,
): Promise<WebhookSubscription | null> {
  return client.webhookSubscription.findUnique({ where: { id } });
}

export function listWebhookSubscriptions(
  organizationId: string,
  client: DataClient = prisma,
): Promise<WebhookSubscription[]> {
  return client.webhookSubscription.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export function updateWebhookSubscription(
  id: string,
  data: Prisma.WebhookSubscriptionUncheckedUpdateInput,
  client: DataClient = prisma,
): Promise<WebhookSubscription> {
  return client.webhookSubscription.update({ where: { id }, data });
}

/** Enabled subscriptions in a tenant whose event selection intersects `eventTypes`. */
export function listEnabledSubscriptionsForEvent(
  organizationId: string,
  eventType: string,
  client: DataClient = prisma,
): Promise<WebhookSubscription[]> {
  return client.webhookSubscription.findMany({
    where: { organizationId, enabled: true, events: { has: eventType } },
    orderBy: [{ id: 'asc' }],
  });
}

/** Tenants that have at least one enabled subscription — the fan-out working set. */
export async function listOrganizationsWithWebhooks(
  client: DataClient = prisma,
): Promise<string[]> {
  const rows = await client.webhookSubscription.findMany({
    where: { enabled: true },
    distinct: ['organizationId'],
    select: { organizationId: true },
  });
  return rows.map((row) => row.organizationId);
}

/**
 * Outbox events for one tenant after the cursor, oldest first. Outbox ids are time-ordered
 * (uuid v7), so a lexicographic `>` is a correct watermark within the stream.
 */
export function listOutboxAfter(
  organizationId: string,
  afterId: string | null,
  limit: number,
  client: DataClient = prisma,
) {
  return client.outbox.findMany({
    where: {
      organizationId,
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: limit,
  });
}

export interface FanoutState {
  lastEventId: string | null;
}

export async function getFanoutState(
  organizationId: string,
  client: DataClient = prisma,
): Promise<FanoutState> {
  const row = await client.webhookFanoutState.findUnique({ where: { organizationId } });
  return { lastEventId: row?.lastEventId ?? null };
}

export function setFanoutState(
  organizationId: string,
  lastEventId: string,
  client: DataClient = prisma,
): Promise<unknown> {
  return client.webhookFanoutState.upsert({
    where: { organizationId },
    create: { organizationId, lastEventId },
    update: { lastEventId },
  });
}

export interface CreateWebhookDeliveryInput {
  organizationId: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Fans an event out to its subscriptions. `skipDuplicates` on `(subscriptionId, eventId)`
 * makes the write idempotent, so a replayed outbox row cannot create a second delivery
 * (`docs/32` §4 idempotency).
 */
export async function createWebhookDeliveries(
  rows: CreateWebhookDeliveryInput[],
  client: DataClient = prisma,
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await client.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/** A delivery is due when it is pending, or failed and past its backoff window. */
export function listDueWebhookDeliveries(
  now: Date,
  limit: number,
  client: DataClient = prisma,
): Promise<WebhookDelivery[]> {
  return client.webhookDelivery.findMany({
    where: {
      OR: [{ status: 'PENDING' }, { status: 'FAILED', nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

export function findWebhookDeliveryById(
  id: string,
  client: DataClient = prisma,
): Promise<WebhookDelivery | null> {
  return client.webhookDelivery.findUnique({ where: { id } });
}

export function listWebhookDeliveriesForSubscription(
  subscriptionId: string,
  limit: number,
  client: DataClient = prisma,
): Promise<WebhookDelivery[]> {
  return client.webhookDelivery.findMany({
    where: { subscriptionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
}

export function markWebhookDelivered(
  id: string,
  responseStatus: number | undefined,
  deliveredAt: Date,
  client: DataClient = prisma,
): Promise<WebhookDelivery> {
  return client.webhookDelivery.update({
    where: { id },
    data: {
      status: 'DELIVERED',
      deliveredAt,
      responseStatus: responseStatus ?? null,
      lastError: null,
      nextAttemptAt: null,
    },
  });
}

export function recordWebhookFailure(
  id: string,
  input: {
    attempts: number;
    error: string;
    nextAttemptAt: Date | null;
    responseStatus: number | undefined;
  },
  client: DataClient = prisma,
): Promise<WebhookDelivery> {
  return client.webhookDelivery.update({
    where: { id },
    data: {
      status: input.nextAttemptAt ? 'FAILED' : 'DEAD_LETTER',
      attempts: input.attempts,
      lastError: input.error,
      lastAttemptAt: new Date(),
      nextAttemptAt: input.nextAttemptAt,
      responseStatus: input.responseStatus ?? null,
    },
  });
}

/** Returns a dead-lettered delivery to the queue for one more attempt chain (`docs/32` §12). */
export function requeueWebhookDelivery(
  id: string,
  client: DataClient = prisma,
): Promise<WebhookDelivery> {
  return client.webhookDelivery.update({
    where: { id },
    data: { status: 'PENDING', nextAttemptAt: null, lastError: null },
  });
}

/** Dead-lettered deliveries in a tenant, newest first (§13 dead-letter viewer). */
export function listDeadLetterDeliveries(
  organizationId: string,
  limit: number,
  client: DataClient = prisma,
): Promise<WebhookDelivery[]> {
  return client.webhookDelivery.findMany({
    where: { organizationId, status: 'DEAD_LETTER' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
}

export function countDeadLetterDeliveries(
  organizationId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.webhookDelivery.count({
    where: { organizationId, status: 'DEAD_LETTER' },
  });
}

/** Per-subscription health (`docs/32` §13): last success, last error and counts. */
export interface WebhookHealthRow {
  subscriptionId: string;
  delivered: number;
  failed: number;
  deadLettered: number;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}

/**
 * Aggregates a tenant's outbound delivery health **per subscription in a fixed number of
 * queries**, never a loop — a health board that runs one query per integration is the N+1
 * that takes the page down as the tenant grows (`docs/09`, `docs/33` §7).
 */
export async function webhookHealthBySubscription(
  organizationId: string,
  client: DataClient = prisma,
): Promise<WebhookHealthRow[]> {
  const [delivered, failed, dead, errors] = await Promise.all([
    client.webhookDelivery.groupBy({
      by: ['subscriptionId'],
      where: { organizationId, status: 'DELIVERED' },
      _count: { _all: true },
      _max: { deliveredAt: true },
    }),
    client.webhookDelivery.groupBy({
      by: ['subscriptionId'],
      where: { organizationId, status: { in: ['FAILED', 'DEAD_LETTER'] } },
      _count: { _all: true },
      _max: { lastAttemptAt: true },
    }),
    client.webhookDelivery.groupBy({
      by: ['subscriptionId'],
      where: { organizationId, status: 'DEAD_LETTER' },
      _count: { _all: true },
    }),
    client.webhookDelivery.findMany({
      where: { organizationId, lastError: { not: null } },
      orderBy: [{ subscriptionId: 'asc' }, { lastAttemptAt: 'desc' }],
      distinct: ['subscriptionId'],
      select: { subscriptionId: true, lastError: true },
    }),
  ]);

  const rows = new Map<string, WebhookHealthRow>();
  const ensure = (id: string): WebhookHealthRow => {
    const existing = rows.get(id);
    if (existing) return existing;
    const row: WebhookHealthRow = {
      subscriptionId: id,
      delivered: 0,
      failed: 0,
      deadLettered: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
    };
    rows.set(id, row);
    return row;
  };

  for (const group of delivered) {
    const row = ensure(group.subscriptionId);
    row.delivered = group._count._all;
    row.lastSuccessAt = group._max.deliveredAt ?? null;
  }
  for (const group of failed) {
    const row = ensure(group.subscriptionId);
    row.failed = group._count._all;
    row.lastErrorAt = group._max.lastAttemptAt ?? null;
  }
  for (const group of dead) {
    ensure(group.subscriptionId).deadLettered = group._count._all;
  }
  for (const error of errors) {
    ensure(error.subscriptionId).lastError = error.lastError;
  }

  return [...rows.values()];
}
