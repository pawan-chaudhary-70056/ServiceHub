import { Prisma, type InboundWebhookEndpoint, type InboundWebhookEvent } from '@prisma/client';
import { prisma, type DataClient } from './db';

/** Re-exported so services can name the row types without importing Prisma directly. */
export type { InboundWebhookEndpoint, InboundWebhookEvent };

/**
 * Inbound webhook persistence (`docs/32` §5).
 *
 * An endpoint is the registered receiver (`key` is the `{provider}` path segment); an event is
 * one received delivery. The raw payload is written **before acking**, so a slow or failing
 * handler cannot lose a provider's event, and `(endpointId, providerEventId)` is unique so a
 * provider retry is a no-op.
 *
 * Only `services/` may import this module (`docs/03` §4).
 */

export interface CreateInboundEndpointInput {
  key: string;
  provider: string;
  organizationId: string | null;
  secret: string;
  createdById: string | null;
}

export function createInboundEndpoint(
  input: CreateInboundEndpointInput,
  client: DataClient = prisma,
): Promise<InboundWebhookEndpoint> {
  return client.inboundWebhookEndpoint.create({ data: input });
}

export function findInboundEndpointByKey(
  key: string,
  client: DataClient = prisma,
): Promise<InboundWebhookEndpoint | null> {
  return client.inboundWebhookEndpoint.findUnique({ where: { key } });
}

export function findInboundEndpointById(
  id: string,
  client: DataClient = prisma,
): Promise<InboundWebhookEndpoint | null> {
  return client.inboundWebhookEndpoint.findUnique({ where: { id } });
}

export function listInboundEndpoints(
  organizationId: string,
  client: DataClient = prisma,
): Promise<InboundWebhookEndpoint[]> {
  return client.inboundWebhookEndpoint.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export function updateInboundEndpoint(
  id: string,
  data: Prisma.InboundWebhookEndpointUncheckedUpdateInput,
  client: DataClient = prisma,
): Promise<InboundWebhookEndpoint> {
  return client.inboundWebhookEndpoint.update({ where: { id }, data });
}

export interface CreateInboundEventInput {
  endpointId: string;
  organizationId: string | null;
  providerEventId: string;
  eventType: string | null;
  rawPayload: Prisma.InputJsonValue;
  expiresAt: Date;
}

/**
 * Records a received delivery, idempotently. Returns `created: false` with the existing row
 * when the provider has already been seen for this endpoint, so the caller can ack a retry
 * without creating a duplicate (`docs/32` §5).
 */
export async function recordInboundEvent(
  input: CreateInboundEventInput,
  client: DataClient = prisma,
): Promise<{ event: InboundWebhookEvent; created: boolean }> {
  const existing = await client.inboundWebhookEvent.findUnique({
    where: {
      endpointId_providerEventId: {
        endpointId: input.endpointId,
        providerEventId: input.providerEventId,
      },
    },
  });
  if (existing) return { event: existing, created: false };

  try {
    const event = await client.inboundWebhookEvent.create({ data: input });
    return { event, created: true };
  } catch {
    // A concurrent delivery of the same event won the race; treat it as a duplicate.
    const raced = await client.inboundWebhookEvent.findUniqueOrThrow({
      where: {
        endpointId_providerEventId: {
          endpointId: input.endpointId,
          providerEventId: input.providerEventId,
        },
      },
    });
    return { event: raced, created: false };
  }
}

export function findInboundEventById(
  id: string,
  client: DataClient = prisma,
): Promise<InboundWebhookEvent | null> {
  return client.inboundWebhookEvent.findUnique({ where: { id } });
}

/** Received or retryable events that are due, oldest first. */
export function listDueInboundEvents(
  now: Date,
  limit: number,
  client: DataClient = prisma,
): Promise<InboundWebhookEvent[]> {
  return client.inboundWebhookEvent.findMany({
    where: {
      OR: [{ status: 'RECEIVED' }, { status: 'FAILED', nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

export function markInboundProcessed(
  id: string,
  processedAt: Date,
  client: DataClient = prisma,
): Promise<InboundWebhookEvent> {
  return client.inboundWebhookEvent.update({
    where: { id },
    data: { status: 'PROCESSED', processedAt, nextAttemptAt: null, lastError: null },
  });
}

export function recordInboundFailure(
  id: string,
  input: { attempts: number; error: string; nextAttemptAt: Date | null },
  client: DataClient = prisma,
): Promise<InboundWebhookEvent> {
  return client.inboundWebhookEvent.update({
    where: { id },
    data: {
      status: input.nextAttemptAt ? 'FAILED' : 'DEAD_LETTER',
      attempts: input.attempts,
      lastError: input.error,
      lastAttemptAt: new Date(),
      nextAttemptAt: input.nextAttemptAt,
    },
  });
}

/** Returns a dead-lettered inbound event to the queue for one more attempt chain. */
export function requeueInboundEvent(
  id: string,
  client: DataClient = prisma,
): Promise<InboundWebhookEvent> {
  return client.inboundWebhookEvent.update({
    where: { id },
    data: { status: 'RECEIVED', nextAttemptAt: null, lastError: null },
  });
}

export function listDeadLetterInboundEvents(
  organizationId: string,
  limit: number,
  client: DataClient = prisma,
): Promise<InboundWebhookEvent[]> {
  return client.inboundWebhookEvent.findMany({
    where: { organizationId, status: 'DEAD_LETTER' },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
}

export function countDeadLetterInboundEvents(
  organizationId: string,
  client: DataClient = prisma,
): Promise<number> {
  return client.inboundWebhookEvent.count({ where: { organizationId, status: 'DEAD_LETTER' } });
}

/** Per-endpoint health (`docs/32` §13): last success, last error and counts. */
export interface InboundHealthRow {
  endpointId: string;
  processed: number;
  failed: number;
  deadLettered: number;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}

/** The inbound half of the health board, aggregated per endpoint without an N+1. */
export async function inboundHealthByEndpoint(
  organizationId: string,
  client: DataClient = prisma,
): Promise<InboundHealthRow[]> {
  const [processed, failed, dead, errors] = await Promise.all([
    client.inboundWebhookEvent.groupBy({
      by: ['endpointId'],
      where: { organizationId, status: 'PROCESSED' },
      _count: { _all: true },
      _max: { processedAt: true },
    }),
    client.inboundWebhookEvent.groupBy({
      by: ['endpointId'],
      where: { organizationId, status: { in: ['FAILED', 'DEAD_LETTER'] } },
      _count: { _all: true },
      _max: { lastAttemptAt: true },
    }),
    client.inboundWebhookEvent.groupBy({
      by: ['endpointId'],
      where: { organizationId, status: 'DEAD_LETTER' },
      _count: { _all: true },
    }),
    client.inboundWebhookEvent.findMany({
      where: { organizationId, lastError: { not: null } },
      orderBy: [{ endpointId: 'asc' }, { lastAttemptAt: 'desc' }],
      distinct: ['endpointId'],
      select: { endpointId: true, lastError: true },
    }),
  ]);

  const rows = new Map<string, InboundHealthRow>();
  const ensure = (id: string): InboundHealthRow => {
    const existing = rows.get(id);
    if (existing) return existing;
    const row: InboundHealthRow = {
      endpointId: id,
      processed: 0,
      failed: 0,
      deadLettered: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
    };
    rows.set(id, row);
    return row;
  };

  for (const group of processed) {
    const row = ensure(group.endpointId);
    row.processed = group._count._all;
    row.lastSuccessAt = group._max.processedAt ?? null;
  }
  for (const group of failed) {
    const row = ensure(group.endpointId);
    row.failed = group._count._all;
    row.lastErrorAt = group._max.lastAttemptAt ?? null;
  }
  for (const group of dead) {
    ensure(group.endpointId).deadLettered = group._count._all;
  }
  for (const error of errors) {
    ensure(error.endpointId).lastError = error.lastError;
  }

  return [...rows.values()];
}

/** Purges expired raw payloads (`docs/32` §5): retention is bounded, and the row is kept. */
export async function purgeExpiredInboundPayloads(
  now: Date,
  client: DataClient = prisma,
): Promise<number> {
  const result = await client.inboundWebhookEvent.updateMany({
    where: { expiresAt: { lte: now }, rawPayload: { not: Prisma.DbNull } },
    data: { rawPayload: Prisma.DbNull },
  });
  return result.count;
}
