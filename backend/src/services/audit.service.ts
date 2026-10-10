import type { ActorType, AuditLog, Prisma } from '@prisma/client';
import { assertAnyPermission, hasPermission, type Principal } from '../helpers/authorization';
import { ForbiddenError } from '../utils/errors';
import { assertArticleVisible } from './kb.service';
import { assertAssetVisible } from './asset.service';
import { assertIncidentVisible } from './incident.service';
import { assertRequestVisible } from './request.service';
import { assertTaskVisible } from './task.service';
import { buildCursorPage, type CursorPage } from '../utils/pagination';
import {
  listAuditForEntity,
  listAuditPage,
  listTeamIdsForUser,
  listTeamMemberUserIds,
  runInTransaction,
  writeAudit,
  type AuditQueryParams,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';

/**
 * Reading the audit log — docs/31 §5/§9/§10, F-17.
 *
 * Reading an audit log is itself a sensitive capability: it reveals who changed what,
 * including records the viewer may not read. Two consequences shape this service:
 *
 *   - **Scoping is a query predicate**, never a post-fetch filter (`docs/31` §5). A team
 *     lead's page can only contain rows their scope selects.
 *   - **Every access to the log is audited** (§5, AC5). The read is recorded *before* the
 *     rows are returned, in its own transaction — a failed audit write must not hand the
 *     caller a page they were not recorded as having seen.
 *
 * **Scope, stated precisely.** `audit:read.all` is tenant-wide. `audit:read.team` is
 * scoped to the *members of the caller's teams* — the "entries for their team's records
 * and members" half of §5 that can be expressed without leaking another team's rows. The
 * **record** half of §5 ("the history of a record they can read") is served by the
 * per-record projections (`GET /requests/{id}/history`, `GET /incidents/{id}/history`),
 * which apply that record's own visibility instead of an audit permission.
 */

/**
 * The security class (`docs/31` §2, §5): authentication, authorization, access denials and
 * administrative grants. Matched by action prefix so a new verb in an existing namespace is
 * classified without a code change.
 */
export const SECURITY_ACTION_PREFIXES = [
  'login.',
  'logout',
  'password.',
  'authz.',
  'role.',
  'user.',
];

export interface AuditEntryView {
  id: string;
  action: string;
  actorId: string | null;
  actorType: ActorType;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  correlationId: string;
  sourceIp: string | null;
  userAgent: string | null;
  occurredAt: Date;
  /** True when the entry belongs to the security class (`docs/31` §2). */
  security: boolean;
  /** True when the entry is a security-class entry the caller's role may not read. */
  redacted: boolean;
}

export function isSecurityAction(action: string): boolean {
  return SECURITY_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('The audit log is tenant-scoped.');
  }
  return actor.organizationId;
}

/** Whether the caller may read the audit log at all (`audit:read.team` or `.all`). */
export function canReadAudit(actor: Principal): boolean {
  return hasPermission(actor, 'audit:read.all') || hasPermission(actor, 'audit:read.team');
}

function toView(row: AuditLog, canReadSecurity: boolean): AuditEntryView {
  const security = isSecurityAction(row.action);
  const redacted = security && !canReadSecurity;
  return {
    id: row.id,
    action: row.action,
    actorId: row.actorId,
    actorType: row.actorType,
    entityType: row.entityType,
    entityId: row.entityId,
    reason: row.reason,
    // A security entry's snapshots are withheld from a caller without `audit:read.security`
    // rather than merely flagged — redaction happens before the row leaves the service
    // (`docs/31` §4: redaction must happen before the row is *written*; on the read path it
    // is the same principle applied to the viewer).
    before: redacted ? null : row.before,
    after: redacted ? null : row.after,
    correlationId: row.correlationId,
    sourceIp: redacted ? null : row.sourceIp,
    userAgent: redacted ? null : row.userAgent,
    occurredAt: row.occurredAt,
    security,
    redacted,
  };
}

export interface ListAuditInput {
  action?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  securityOnly?: boolean;
  limit: number;
  cursor?: string;
}

/**
 * Records the fact that the log was read (`docs/31` §5, AC5).
 *
 * Written in its own transaction so the access record cannot be rolled back by anything
 * that follows, and before the rows are returned to the caller.
 */
async function auditTheAccess(
  organizationId: string,
  actor: Principal,
  meta: RequestMeta,
  filters: Prisma.InputJsonObject,
): Promise<void> {
  await runInTransaction(async (tx) => {
    await writeAudit(
      {
        organizationId,
        actorId: actor.userId,
        actorType: 'USER',
        action: AUDIT_ACTION.AUDIT_READ,
        entityType: AUDIT_ENTITY.AUDIT_LOG,
        after: { filters },
        correlationId: meta.correlationId,
        sourceIp: meta.sourceIp ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  });
}

/** The actor ids the caller's scope admits, or `undefined` for the tenant-wide scope. */
export async function resolveScopeActorIds(
  organizationId: string,
  actor: Principal,
): Promise<string[] | undefined> {
  if (hasPermission(actor, 'audit:read.all')) return undefined;
  const teamIds = await listTeamIdsForUser(organizationId, actor.userId);
  const memberLists = await Promise.all(teamIds.map((teamId) => listTeamMemberUserIds(teamId)));
  const ids = new Set<string>(memberLists.flat());
  // A lead always sees their own actions, even with no team membership recorded.
  ids.add(actor.userId);
  return [...ids];
}

export async function listAuditEntries(
  input: ListAuditInput,
  actor: Principal,
  meta: RequestMeta,
): Promise<CursorPage<AuditEntryView>> {
  const organizationId = requireTenant(actor);
  // Either grant opens the log: `audit:read.team` narrows the scope, `audit:read.all`
  // widens it. Asserting the narrower one alone would lock out an administrator.
  assertAnyPermission(actor, ['audit:read.team', 'audit:read.all']);

  const canReadSecurity = hasPermission(actor, 'audit:read.security');
  if (input.securityOnly && !canReadSecurity) {
    throw new ForbiddenError(
      'Reading the security class of the audit log requires audit:read.security.',
    );
  }

  const scopeActorIds = await resolveScopeActorIds(organizationId, actor);
  if (scopeActorIds && input.actorId && !scopeActorIds.includes(input.actorId)) {
    // The caller asked for an actor outside their scope: an empty page, not another team's rows.
    return { items: [], nextCursor: null, hasMore: false };
  }

  const params: AuditQueryParams = {
    organizationId,
    ...(scopeActorIds ? { actorIds: scopeActorIds } : {}),
    ...(input.action ? { actions: [input.action] } : {}),
    ...(input.securityOnly ? { securityActionPrefixes: SECURITY_ACTION_PREFIXES } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.entityType ? { entityType: input.entityType } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.from ? { from: new Date(input.from) } : {}),
    ...(input.to ? { to: new Date(input.to) } : {}),
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };

  await auditTheAccess(organizationId, actor, meta, {
    action: input.action ?? null,
    actorId: input.actorId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    securityOnly: input.securityOnly ?? false,
    scope: hasPermission(actor, 'audit:read.all') ? 'all' : 'team',
  });

  const rows = await listAuditPage(params);
  const page = buildCursorPage(rows, input.limit, (row) => row.occurredAt);
  return { ...page, items: page.items.map((row) => toView(row, canReadSecurity)) };
}

/** `GET /audit/security` — the security class only (`docs/31` §10). */
export async function listSecurityAuditEntries(
  input: { limit: number; cursor?: string },
  actor: Principal,
  meta: RequestMeta,
): Promise<CursorPage<AuditEntryView>> {
  return listAuditEntries({ ...input, securityOnly: true }, actor, meta);
}

/**
 * A record's history projection (`docs/31` §10, `docs/11` §9).
 *
 * Authorisation is **the record's own**, not the audit permission: a caller entitled to
 * read a request may read its history. That is why this takes the entitlement as a
 * predicate rather than assuming one.
 */
export async function getRecordHistory(
  params: {
    entityType: string;
    entityId: string;
    limit: number;
    /** Whether the caller may see security-class entries for this record. */
    canReadSecurity: boolean;
  },
  actor: Principal,
): Promise<AuditEntryView[]> {
  // The record's tenant is the caller's tenant: every read path in the application applies
  // the tenant predicate, so a record outside it is one the caller cannot read at all.
  const organizationId = requireTenant(actor);
  const rows = await listAuditForEntity({
    organizationId,
    entityType: params.entityType,
    entityId: params.entityId,
    limit: params.limit,
  });
  // A record participant never sees security-class entries (`docs/31` §5).
  return rows
    .filter((row) => params.canReadSecurity || !isSecurityAction(row.action))
    .map((row) => toView(row, params.canReadSecurity));
}

/**
 * A record's history as **either** an auditor **or** a participant (`docs/31` §5/§10).
 *
 * The two entitlements are different, and the difference matters: an auditor may read any
 * record's trail in the tenant, while a participant may read the trail of a record they can
 * already read. The participant path therefore resolves the record through its **owning
 * service's** object-level check, so this projection can never become a back door.
 */
export async function getRecordHistoryForCaller(
  params: { entityType: string; entityId: string; limit: number },
  actor: Principal,
): Promise<AuditEntryView[]> {
  // A caller without a tenant cannot read any record's history; it is also the predicate
  // every read path applies, so this fails closed before any record is touched.
  requireTenant(actor);
  const canReadSecurity = hasPermission(actor, 'audit:read.security');

  if (!canReadAudit(actor)) {
    await assertRecordReadable(params.entityType, params.entityId, actor);
  }

  return getRecordHistory(
    {
      entityType: params.entityType,
      entityId: params.entityId,
      limit: params.limit,
      // Without `audit:read.security` the security class is withheld, whoever the caller is.
      canReadSecurity,
    },
    actor,
  );
}

/** Dispatches to the owning service's own visibility rule for the record half of §5. */
async function assertRecordReadable(
  entityType: string,
  entityId: string,
  actor: Principal,
): Promise<void> {
  switch (entityType) {
    case AUDIT_ENTITY.REQUEST:
      await assertRequestVisible(entityId, actor);
      return;
    case AUDIT_ENTITY.INCIDENT:
      await assertIncidentVisible(entityId, actor);
      return;
    case AUDIT_ENTITY.TASK:
      // A task's history inherits the parent's visibility (rule T2), resolved by getTask.
      await assertTaskVisible(entityId, actor);
      return;
    case AUDIT_ENTITY.ASSET:
      // The holder may read the asset's history; `asset:read.any` widens it to the tenant.
      await assertAssetVisible(entityId, actor);
      return;
    case AUDIT_ENTITY.ARTICLE:
      // The article's visibility class decides, not a blanket read permission (rule K3).
      await assertArticleVisible(entityId, actor);
      return;
    default:
      // A record type with no participant-readable projection is auditor-only.
      throw new ForbiddenError("Reading this record's history requires an audit read grant.");
  }
}
