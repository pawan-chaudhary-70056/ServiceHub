import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  type Principal,
} from '../helpers/authorization';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import {
  createReportExport,
  findReportExportById,
  listAuditPage,
  writeAudit,
  type ReportExport,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import { isSecurityAction, resolveScopeActorIds, SECURITY_ACTION_PREFIXES } from './audit.service';
import type { RequestMeta } from './context';
import { openStoredExport, type ReportDownloadTarget } from './report-export.service';

/**
 * Audit export (`docs/31` §9/§10, §5/§6, F-17).
 *
 * An audit export is the log leaving the building, so it is the highest-risk read on this
 * surface. Three rules shape it, all taken straight from `docs/31`:
 *
 *   - **It is itself audited** (§6, §9): the request records the filters and the requester,
 *     so disclosure is accountable.
 *   - **It is scoped like a read, not wider** (§5): the export runs under the requester's
 *     own authorization and applies the same actor scope a page would, so an export can
 *     never exceed what the requester could see on screen.
 *   - **The security class stays withheld** (§2/§5): without `audit:read.security` a
 *     security-class row is exported **redacted** — present, but with its address and reason
 *     removed — never whole.
 *
 * The job reuses the async export machinery of `docs/30` §5 (`ReportExport`), so an export
 * is queued, run off the request path, and delivered as a **time-limited** download.
 */

/** The `ReportExport.metric` value that marks a row as an audit export (`docs/30` §5). */
export const AUDIT_EXPORT_METRIC = 'audit.log';

/** Upper bound on rows in one export; an unbounded export is a database incident waiting. */
const EXPORT_ROW_LIMIT = 10_000;

export interface AuditExportFilters {
  action?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  securityOnly?: boolean;
}

export interface AuditExportView {
  id: string;
  metric: string;
  format: string;
  status: string;
  rowCount: number;
  params: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  /** Present only while a succeeded export has not expired. */
  downloadUrl: string | null;
}

function requireTenant(actor: Principal): string {
  if (!actor.organizationId) {
    throw new ForbiddenError('The audit log is tenant-scoped.');
  }
  return actor.organizationId;
}

function toView(row: ReportExport, now: Date): AuditExportView {
  const params =
    typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params)
      ? (row.params as Record<string, unknown>)
      : {};
  const live = row.status === 'SUCCEEDED' && row.expiresAt !== null && row.expiresAt > now;
  return {
    id: row.id,
    metric: row.metric,
    format: row.format,
    status: row.status,
    rowCount: row.rowCount,
    params,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    error: row.error,
    downloadUrl: live ? `/api/v1/audit/exports/${row.id}/download` : null,
  };
}

/** Flattens the filter set to a JSON-safe record for storage and the audit snapshot. */
function toJsonFilters(input: AuditExportFilters): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (input.action) out.action = input.action;
  if (input.actorId) out.actorId = input.actorId;
  if (input.entityType) out.entityType = input.entityType;
  if (input.entityId) out.entityId = input.entityId;
  if (input.from) out.from = input.from;
  if (input.to) out.to = input.to;
  if (input.securityOnly) out.securityOnly = input.securityOnly;
  return out;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Queues an audit export and audits the request with its filters (`docs/31` §6/§9). */
export async function requestAuditExport(
  input: AuditExportFilters,
  actor: Principal,
  meta: RequestMeta,
): Promise<AuditExportView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'audit:export');
  assertAnyPermission(actor, ['audit:read.team', 'audit:read.all']);

  // The security-only filter is refused without the class grant, exactly as on the read path.
  if (input.securityOnly && !hasPermission(actor, 'audit:read.security')) {
    throw new ForbiddenError(
      'Exporting the security class of the audit log requires audit:read.security.',
    );
  }

  const created = await createReportExport({
    organizationId,
    requestedById: actor.userId,
    metric: AUDIT_EXPORT_METRIC,
    params: { filters: toJsonFilters(input) },
    format: 'CSV',
  });

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.AUDIT_EXPORT_REQUESTED,
    entityType: AUDIT_ENTITY.AUDIT_EXPORT,
    entityId: created.id,
    after: { filters: toJsonFilters(input) },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return toView(created, new Date());
}

/** The requester's export, or `404` — an export is scoped to the user who asked for it. */
export async function getAuditExport(actor: Principal, id: string): Promise<AuditExportView> {
  assertPermission(actor, 'audit:export');
  const row = await findReportExportById(id);
  if (
    !row ||
    row.metric !== AUDIT_EXPORT_METRIC ||
    row.organizationId !== actor.organizationId ||
    row.requestedById !== actor.userId
  ) {
    throw new NotFoundError('Export not found.');
  }
  return toView(row, new Date());
}

/**
 * The audit export's bytes for download, enforcing ownership, readiness and expiry.
 *
 * The content itself is opened through the shared storage path (`openStoredExport`), so the
 * audit CSV and a report CSV are served identically — `ADR-0004`, `docs/19` §7.3.
 */
export async function downloadAuditExport(
  actor: Principal,
  id: string,
): Promise<ReportDownloadTarget> {
  assertPermission(actor, 'audit:export');
  const row = await findReportExportById(id);
  if (
    !row ||
    row.metric !== AUDIT_EXPORT_METRIC ||
    row.organizationId !== actor.organizationId ||
    row.requestedById !== actor.userId
  ) {
    throw new NotFoundError('Export not found.');
  }
  if (row.status !== 'SUCCEEDED') {
    throw new NotFoundError('Export is not ready.');
  }
  if (row.expiresAt !== null && row.expiresAt <= new Date()) {
    throw new NotFoundError('Export has expired. Request a new export.');
  }
  const stamp = row.createdAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return openStoredExport(row, `audit-log-${stamp}.csv`);
}

/**
 * Renders the audit CSV for one job (`docs/30` §5 dispatch, `docs/31` §5).
 *
 * Authorization is **re-derived at run time** (`docs/30` R3): the scope is resolved from the
 * requester's current teams, not from anything captured when the job was queued, so a grant
 * removed between queue and run cannot leak through a queued export.
 */
export async function renderAuditCsv(
  principal: Principal,
  params: Record<string, unknown>,
): Promise<{ content: string; rowCount: number }> {
  const organizationId = requireTenant(principal);
  assertAnyPermission(principal, ['audit:read.team', 'audit:read.all']);

  const filters = ((params.filters ?? {}) as AuditExportFilters) ?? {};
  const canReadSecurity = hasPermission(principal, 'audit:read.security');
  const scopeActorIds = await resolveScopeActorIds(organizationId, principal);

  const rows = await listAuditPage({
    organizationId,
    ...(scopeActorIds ? { actorIds: scopeActorIds } : {}),
    ...(filters.action ? { actions: [filters.action] } : {}),
    ...(filters.securityOnly ? { securityActionPrefixes: SECURITY_ACTION_PREFIXES } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.from ? { from: new Date(filters.from) } : {}),
    ...(filters.to ? { to: new Date(filters.to) } : {}),
    limit: EXPORT_ROW_LIMIT,
  });

  const lines = [
    `# metric,${AUDIT_EXPORT_METRIC}`,
    `# generated_at,${new Date().toISOString()}`,
    `# scope,${hasPermission(principal, 'audit:read.all') ? 'all' : 'team'}`,
    `# security_class,${canReadSecurity ? 'included' : 'redacted'}`,
    'occurred_at,action,actor_type,actor_id,entity_type,entity_id,reason,correlation_id,source_ip,security,redacted',
  ];

  let rowCount = 0;
  for (const row of rows) {
    const security = isSecurityAction(row.action);
    const redacted = security && !canReadSecurity;
    lines.push(
      [
        row.occurredAt.toISOString(),
        row.action,
        row.actorType,
        row.actorId,
        row.entityType,
        row.entityId,
        redacted ? null : row.reason,
        row.correlationId,
        redacted ? null : row.sourceIp,
        security ? 'true' : 'false',
        redacted ? 'true' : 'false',
      ]
        .map(csvCell)
        .join(','),
    );
    rowCount += 1;
  }

  return { content: `${lines.join('\n')}\n`, rowCount };
}
