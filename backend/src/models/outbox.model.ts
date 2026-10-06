import type { Outbox, Prisma } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Transactional outbox writes — docs/13 §7, docs/29 §3, docs/04 §11.
 *
 * An email is never sent inline from a request. The domain event is persisted in the
 * **same transaction** as the mutation, and a worker drains it afterwards. That is what
 * makes "enqueue after commit" safe: a crash between commit and send cannot lose the
 * notification, and a rolled-back change cannot produce one (docs/04 §2.4).
 *
 * The `idempotencyKey` is unique, so re-processing the same event is a no-op rather than
 * a duplicate email.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface OutboxEvent {
  organizationId: string | null;
  eventType: string;
  payload: Prisma.InputJsonValue;
  idempotencyKey: string;
}

export function writeOutboxEvent(event: OutboxEvent, client: DataClient = prisma): Promise<Outbox> {
  return client.outbox.create({ data: event });
}
