import type { Readable } from 'node:stream';
import { config } from '../config';
import { contentDisposition, sanitizeFilename } from '../helpers/file-sniff';
import { assertPermission, type Principal } from '../helpers/authorization';
import { fileStorage, newStorageKey } from '../integrations/storage';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import {
  claimReportExport,
  createReportExport,
  findReportExportById,
  findUserById,
  listQueuedReportExports,
  markReportExportFailed,
  markReportExportSucceeded,
  resolvePermissionKeys,
  writeAudit,
  type ReportExport,
} from '../models';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit-events';
import type { RequestMeta } from './context';
import { AUDIT_EXPORT_METRIC, renderAuditCsv } from './audit-export.service';
import { REPORT_METRICS, runReport, type ReportResult } from './report.service';

/**
 * Async report exports — docs/30 §3.1, §3.4, §4, §5, F-14.
 *
 * A period or ad-hoc analysis runs as a **job** and produces a **time-limited download**
 * (`§3.1`, R4), never blocking a request thread on an aggregate. The load-bearing rules:
 *
 *   - **Scoped by the requester's authorization (`R3`).** The job re-derives the caller's
 *     permissions at run time and runs the report *as them*, so an export can never exceed
 *     what they could see in the UI. A cross-team metric they may not read fails the job.
 *   - **Audited with filters (`R5`).** The request records the metric and the period; the
 *     completion records the result. Exfiltration is accountable.
 *   - **Time-limited.** The content expires; the view states when.
 *
 * **The CSV lives in object storage, not in a column** (`ADR-0004`, `docs/19` §7.1, closing the
 * `CR-0003` interim). The worker renders the file and writes it through the storage adapter,
 * persisting only the key; `s3` in production and `local` in development, chosen by
 * configuration. Two consequences that matter: an export produced by one instance is
 * downloadable from another, and a database dump is no longer a bulk data export.
 *
 * Download is limited to the **requester**: the export is scoped to them, so another user
 * downloading it could read data they cannot. When the driver can issue one, the download is a
 * short-lived signed URL; otherwise the API streams the file (`19` §7.3).
 */

/** Where a download's bytes come from once ownership and expiry have been checked. */
export type ReportDownloadTarget =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'stream';
      stream: Readable;
      contentType: string;
      filename: string;
      disposition: string;
    };

export interface ReportExportView {
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
    throw new ForbiddenError('Only a tenant member can export reports.');
  }
  return actor.organizationId;
}

function toView(row: ReportExport, now: Date): ReportExportView {
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
    downloadUrl: live ? `/api/v1/reports/jobs/${row.id}/download` : null,
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Renders a report to CSV, with the period, time zone and scope in the header (R2/R5). */
export function reportToCsv(report: ReportResult): { content: string; rowCount: number } {
  const lines = [
    `# metric,${report.metric}`,
    `# period_from,${report.period.from}`,
    `# period_to,${report.period.to}`,
    `# time_zone,${report.period.timeZone}`,
    `# scope,${report.scope}`,
    `# generated_at,${report.generatedAt}`,
    'category,key,value',
  ];
  let rowCount = 0;
  for (const [category, value] of Object.entries(report.figures)) {
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`${csvCell(category)},${csvCell(key)},${csvCell(inner)}`);
        rowCount += 1;
      }
    } else {
      lines.push(`${csvCell(category)},,${csvCell(value)}`);
      rowCount += 1;
    }
  }
  return { content: `${lines.join('\n')}\n`, rowCount };
}

/** Queues an export (`docs/30` §5) and audits the request with its filters (`R5`). */
export async function requestExport(
  actor: Principal,
  metric: string,
  params: { from?: string; to?: string },
  meta: RequestMeta,
): Promise<ReportExportView> {
  const organizationId = requireTenant(actor);
  assertPermission(actor, 'report:export');

  if (!(REPORT_METRICS as readonly string[]).includes(metric)) {
    throw new NotFoundError('Unknown report metric.');
  }

  const created = await createReportExport({
    organizationId,
    requestedById: actor.userId,
    metric,
    params,
    format: 'CSV',
  });

  await writeAudit({
    organizationId,
    actorId: actor.userId,
    actorType: 'USER',
    action: AUDIT_ACTION.REPORT_EXPORT_REQUESTED,
    entityType: AUDIT_ENTITY.REPORT_EXPORT,
    entityId: created.id,
    after: { metric, params },
    correlationId: meta.correlationId,
    sourceIp: meta.sourceIp ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return toView(created, new Date());
}

/** The requester's export, or `404` — an export is scoped to the user who asked for it. */
export async function getExport(actor: Principal, id: string): Promise<ReportExportView> {
  const row = await findReportExportById(id);
  if (!row || row.organizationId !== actor.organizationId || row.requestedById !== actor.userId) {
    throw new NotFoundError('Export not found.');
  }
  return toView(row, new Date());
}

/**
 * The export's bytes for download, enforcing ownership and expiry before any storage access.
 *
 * The order is deliberate: authorize, then read. Nothing touches the object store until the
 * caller has been proved to be the requester and the link is still live, so a guessed id or an
 * expired key cannot even cause a storage fetch.
 */
export async function downloadExport(actor: Principal, id: string): Promise<ReportDownloadTarget> {
  const row = await findReportExportById(id);
  if (!row || row.organizationId !== actor.organizationId || row.requestedById !== actor.userId) {
    throw new NotFoundError('Export not found.');
  }
  const now = new Date();
  if (row.status !== 'SUCCEEDED' || !row.storageKey) {
    throw new NotFoundError('Export is not ready.');
  }
  if (row.expiresAt !== null && row.expiresAt <= now) {
    // Expired links degrade; the report can be regenerated (`docs/30` §8). The object itself
    // is not deleted here — retention is a maintenance job (`19` §7.4), and a purge must not
    // be the side effect of one download attempt.
    throw new NotFoundError('Export has expired. Request a new export.');
  }

  const stamp = row.createdAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return openStoredExport(row, `${row.metric}-${stamp}.csv`);
}

/**
 * Opens an **already-authorised** export's bytes (`ADR-0004`, `docs/19` §7.3).
 *
 * Shared by the report and audit download paths, which differ only in which permission and
 * scope they check before calling this. Keeping the storage access in one place means the two
 * cannot drift into one redirecting a signed URL and the other streaming bytes — a difference
 * an operator would only discover from a support ticket.
 */
export async function openStoredExport(
  row: ReportExport,
  filename: string,
): Promise<ReportDownloadTarget> {
  if (!row.storageKey) {
    throw new NotFoundError('Export is not ready.');
  }
  const safe = sanitizeFilename(filename);
  const storage = fileStorage();

  const signed = await storage.signedDownloadUrl(row.storageKey);
  if (signed) return { kind: 'redirect', url: signed };

  const stream = await storage.open(row.storageKey);
  if (!stream) {
    throw new NotFoundError('Export not found.');
  }
  return {
    kind: 'stream',
    stream,
    contentType: 'text/csv; charset=utf-8',
    filename: safe,
    disposition: contentDisposition(safe, false),
  };
}

/**
 * Runs every queued export. Each row is claimed atomically, and a failure is recorded on
 * the export rather than thrown, so one bad job cannot stop the rest (`docs/30` §10).
 */
export async function processQueuedExports(
  limit: number = config.REPORT_EXPORT_BATCH_SIZE,
): Promise<{ processed: number; failed: number }> {
  const rows = await listQueuedReportExports(limit);
  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    if (!(await claimReportExport(row.id))) {
      continue;
    }
    try {
      const principal = await principalFor(row.requestedById);
      if (!principal) {
        await markReportExportFailed(row.id, 'The requesting user no longer exists.');
        failed += 1;
        continue;
      }

      const params = (row.params ?? {}) as Record<string, unknown>;
      // The shared job table carries two kinds of export; the metric selects the renderer
      // (`docs/30` §5, `docs/31` §10). Both apply the requester's own authorization.
      const isAuditExport = row.metric === AUDIT_EXPORT_METRIC;
      const { content, rowCount } = isAuditExport
        ? await renderAuditCsv(principal, params)
        : reportToCsv(
            await runReport(principal, row.metric, {
              ...(params.from ? { from: String(params.from) } : {}),
              ...(params.to ? { to: String(params.to) } : {}),
            }),
          );
      const expiresAt = new Date(Date.now() + config.REPORT_EXPORT_TTL_MINUTES * 60_000);

      // Bytes go to object storage, outside any transaction (`docs/33` §11), and only the key
      // is persisted. A storage failure fails the job and is recorded on the export, so the
      // requester sees a reason instead of a permanently QUEUED row.
      const storageKey = newStorageKey(row.organizationId);
      await fileStorage().put(storageKey, Buffer.from(content, 'utf8'), 'text/csv; charset=utf-8');

      await markReportExportSucceeded(row.id, { storageKey, rowCount, expiresAt });
      await writeAudit({
        organizationId: row.organizationId,
        actorId: row.requestedById,
        actorType: 'SYSTEM',
        action: isAuditExport
          ? AUDIT_ACTION.AUDIT_EXPORT_COMPLETED
          : AUDIT_ACTION.REPORT_EXPORT_COMPLETED,
        entityType: isAuditExport ? AUDIT_ENTITY.AUDIT_EXPORT : AUDIT_ENTITY.REPORT_EXPORT,
        entityId: row.id,
        after: { metric: row.metric, rowCount, expiresAt: expiresAt.toISOString() },
        correlationId: `export:${row.id}`,
        sourceIp: null,
        userAgent: null,
      });
      processed += 1;
    } catch (error) {
      // A cross-team metric the requester may not read fails the job (`docs/30` R3).
      await markReportExportFailed(
        row.id,
        error instanceof Error ? error.message : 'Export failed.',
      );
      failed += 1;
    }
  }

  return { processed, failed };
}

/** Rebuilds the principal for the requester so the export runs under their authorization. */
async function principalFor(userId: string): Promise<Principal | null> {
  const user = await findUserById(userId);
  if (!user) return null;
  const permissions = await resolvePermissionKeys(userId);
  return {
    userId: user.id,
    organizationId: user.organizationId,
    isActive: user.status === 'ACTIVE',
    permissions: new Set(permissions),
  };
}
