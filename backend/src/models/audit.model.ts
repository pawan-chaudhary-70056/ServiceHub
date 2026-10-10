import { Prisma, type ActorType, type AuditLog } from '@prisma/client';
import { decodeCursor } from '../utils/pagination';
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
 * The audit explorer's query (`docs/31` §10).
 *
 * Every filter maps to an indexed column or is rejected (`docs/09` §3): `action`,
 * `actorId`, `(entityType, entityId)` and `occurredAt` are all indexed, and the ordering
 * uses the same tuple as the per-entity projection so the cursor is total.
 *
 * The caller's scope is applied **here, as a predicate** — never by fetching and then
 * filtering, which for an audit log means the leak is already in the page size and the
 * ranking.
 */
export interface AuditQueryParams {
  organizationId: string;
  /** Narrow to these actor ids (the team scope resolves to the caller's team members). */
  actorIds?: string[];
  actions?: string[];
  /** Restrict to the security class by action prefix (`docs/31` §5). */
  securityActionPrefixes?: string[];
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

export function listAuditPage(
  params: AuditQueryParams,
  client: DataClient = prisma,
): Promise<AuditLog[]> {
  const where: Prisma.AuditLogWhereInput = { organizationId: params.organizationId };

  if (params.actorIds) {
    // An empty list means "no scope", which must match nothing rather than everything.
    where.actorId = { in: params.actorIds };
  }
  if (params.actions && params.actions.length > 0) where.action = { in: params.actions };
  if (params.securityActionPrefixes && params.securityActionPrefixes.length > 0) {
    where.AND = [
      { OR: params.securityActionPrefixes.map((prefix) => ({ action: { startsWith: prefix } })) },
    ];
  }
  if (params.actorId) where.actorId = params.actorId;
  if (params.entityType) where.entityType = params.entityType;
  if (params.entityId) where.entityId = params.entityId;
  if (params.from || params.to) {
    where.occurredAt = {
      ...(params.from ? { gte: params.from } : {}),
      ...(params.to ? { lte: params.to } : {}),
    };
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    const occurredAt = new Date(decoded.sortValue);
    const cursorClause = {
      OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: decoded.id } }],
    };
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), cursorClause];
  }

  return client.auditLog.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: params.limit + 1,
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
