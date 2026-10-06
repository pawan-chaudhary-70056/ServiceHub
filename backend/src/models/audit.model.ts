import { Prisma, type ActorType, type AuditLog } from '@prisma/client';
import { prisma, type DataClient } from './db';

/**
 * Append-only audit writes — docs/31, docs/04 §10.
 *
 * Two properties this module exists to protect:
 *
 *   1. The write happens **inside the same transaction** as the mutation it records. A
 *      rolled-back mutation leaves no audit row, and a committed one cannot skip it.
 *      Callers therefore pass the transaction client, not the root client.
 *   2. There is no update or delete path here, and the database enforces the same rule
 *      with a trigger (migration `audit_append_only_trigger`). Omitting the operations
 *      in application code is the first control; the trigger is the second.
 *
 * Only `services/` may import this module (docs/03 §4).
 */

export interface AuditEntry {
  organizationId: string | null;
  actorId: string | null;
  actorType: ActorType;
  /** Dotted namespace, e.g. `login.success`, `platform.organization.create`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  reason?: string | null;
  correlationId: string;
  sourceIp?: string | null;
  userAgent?: string | null;
}

export function writeAudit(entry: AuditEntry, client: DataClient = prisma): Promise<AuditLog> {
  const { before, after, ...rest } = entry;
  return client.auditLog.create({
    data: {
      ...rest,
      // An absent/null snapshot is stored as SQL NULL, not a JSON `null` literal, so a
      // reader can distinguish "there was no prior value" from "the value was null".
      before: before === undefined || before === null ? Prisma.DbNull : before,
      after: after === undefined || after === null ? Prisma.DbNull : after,
    },
  });
}

/**
 * A record's history projection (`docs/31` §8): the audit rows for one entity, newest
 * first. Tenant-scoped by predicate like every other read (`ADR-0002`), so a caller can
 * never read another tenant's trail by guessing an id.
 */
export function listAuditForEntity(
  params: { organizationId: string; entityType: string; entityId: string; limit: number },
  client: DataClient = prisma,
): Promise<AuditLog[]> {
  return client.auditLog.findMany({
    where: {
      organizationId: params.organizationId,
      entityType: params.entityType,
      entityId: params.entityId,
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: params.limit,
  });
}

/**
 * Best-effort audit for a failure path that has no transaction to share (e.g. a failed
 * login). A failure to record this must never turn a 401 into a 500, so the error is
 * swallowed by the caller — but it is still written here so the attempt is visible.
 */
export async function writeAuditSafe(
  entry: AuditEntry,
  client: DataClient = prisma,
): Promise<void> {
  try {
    await writeAudit(entry, client);
  } catch {
    // Intentionally ignored: auditing a failed attempt must not fail the request.
  }
}
