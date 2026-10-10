import { apiDownload, apiRequest, type DownloadedFile } from './client';
import type { CursorPage } from './tasks.api';

/**
 * Audit log reading API (docs/31 §10, docs/11 §9).
 *
 * The server owns three facts the UI must not second-guess:
 *
 *   - **Scope** is a query predicate, so a page never contains a row the caller may not
 *     read; there is nothing to filter here.
 *   - **The security class** is withheld, not flagged: a redacted entry arrives with its
 *     `before`/`after`/`sourceIp` already null and `redacted: true`, so the UI renders the
 *     marker rather than the payload.
 *   - **Reading the log is itself audited** by the server before it returns rows, so the
 *     caller of these functions does not need to record anything.
 */

export type AuditActorType = 'USER' | 'SERVICE' | 'SYSTEM';

export interface AuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorType: AuditActorType;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  correlationId: string;
  sourceIp: string | null;
  userAgent: string | null;
  occurredAt: string;
  /** True when the entry belongs to the security class (`docs/31` §2). */
  security: boolean;
  /** True when this is a security entry the caller's role may not read. */
  redacted: boolean;
}

export interface AuditListParams {
  cursor?: string;
  limit?: number;
  action?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  /** ISO-8601 instants; the server rejects a range whose end precedes its start. */
  from?: string;
  to?: string;
  securityOnly?: boolean;
}

function auditQuery(params: AuditListParams): string {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.action) query.set('action', params.action);
  if (params.actorId) query.set('actorId', params.actorId);
  if (params.entityType) query.set('entityType', params.entityType);
  if (params.entityId) query.set('entityId', params.entityId);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.securityOnly) query.set('securityOnly', 'true');
  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
}

/**
 * `GET /audit` — the scoped, filterable, cursor-paginated log (`docs/31` §10).
 *
 * Requires `audit:read.team` or `audit:read.all`; a caller without either receives `403`.
 */
export function listAudit(
  params: AuditListParams = {},
  signal?: AbortSignal,
): Promise<CursorPage<AuditEntry>> {
  return apiRequest<CursorPage<AuditEntry>>(`/audit${auditQuery(params)}`, { signal });
}

/**
 * `GET /audit/security` — the security class only (`docs/31` §10).
 *
 * Requires `audit:read.security`; the server refuses the request outright rather than
 * returning an empty page, so a screen behind this call is only offered to a caller who
 * holds the grant.
 */
export function listSecurityAudit(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CursorPage<AuditEntry>> {
  return apiRequest<CursorPage<AuditEntry>>(`/audit/security${auditQuery(params)}`, { signal });
}

/**
 * `GET /audit/records/{entityType}/{entityId}` — one record's history (`docs/31` §5).
 *
 * Authorised by the **record's own visibility** for a participant, or by an audit grant for
 * an auditor, so a caller entitled to read a request can read its trail.
 */
export function getRecordHistory(
  entityType: string,
  entityId: string,
  params: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ history: AuditEntry[] }> {
  const query = params.limit ? `?limit=${params.limit}` : '';
  return apiRequest<{ history: AuditEntry[] }>(
    `/audit/records/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}${query}`,
    { signal },
  );
}

/**
 * Async audit export (`docs/31` §9/§10, `docs/30` §5).
 *
 * Exporting the whole log is a **separate grant** from reading it — `audit:export`, not
 * `audit:read.*` — because it is a disclosure action rather than a page view, and it is
 * audited with the filters that produced it. The job is async by rule (`docs/30` §3.4): an
 * exhaustive audit query never runs on a request thread, so the client queues it, polls the
 * job, and follows the server's download link rather than constructing one.
 */

export type AuditExportStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface AuditExportJob {
  id: string;
  metric: string;
  format: string;
  status: AuditExportStatus;
  rowCount: number;
  params: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  downloadUrl: string | null;
}

/** The explorer filters that an export carries; pagination is meaningless off the page. */
function auditExportBody(params: AuditListParams): Record<string, unknown> {
  return {
    ...(params.action ? { action: params.action } : {}),
    ...(params.actorId ? { actorId: params.actorId } : {}),
    ...(params.entityType ? { entityType: params.entityType } : {}),
    ...(params.entityId ? { entityId: params.entityId } : {}),
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(params.securityOnly ? { securityOnly: true } : {}),
  };
}

/**
 * `POST /audit/export` — queues an export of the current filtered set (`docs/31` §10).
 *
 * Requires `audit:export`; a security-class-only export additionally requires
 * `audit:read.security`, and the server refuses it rather than silently widening scope.
 */
export function requestAuditExport(
  params: AuditListParams = {},
): Promise<{ export: AuditExportJob }> {
  return apiRequest<{ export: AuditExportJob }>('/audit/export', {
    method: 'POST',
    body: auditExportBody(params),
  });
}

/** `GET /audit/exports/{id}` — the caller's own export's status (`docs/30` §5). */
export function getAuditExport(
  id: string,
  signal?: AbortSignal,
): Promise<{ export: AuditExportJob }> {
  return apiRequest<{ export: AuditExportJob }>(`/audit/exports/${id}`, { signal });
}

/** Fetches the export CSV, subject to the server's ownership and expiry rules. */
export function fetchAuditExportFile(id: string, signal?: AbortSignal): Promise<DownloadedFile> {
  return apiDownload(`/audit/exports/${id}/download`, signal);
}
