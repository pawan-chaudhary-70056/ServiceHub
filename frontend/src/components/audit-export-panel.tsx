import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fetchAuditExportFile,
  getAuditExport,
  requestAuditExport,
  type AuditExportJob,
  type AuditListParams,
} from '../api/audit.api';
import { ApiError } from '../api/client';
import { StatusBadge } from './status-badge';

/**
 * Audit export control (`docs/31` §9/§10, `docs/30` §5).
 *
 * Exporting the log is a **disclosure action** under its own grant, so this panel is offered
 * only to a caller who holds `audit:export` and the button is hidden otherwise rather than
 * shown-then-refused. The export follows the async-job rule (`docs/30` §3.4): it is queued with
 * the filters currently on screen, polled until it settles, and the download link the server
 * returns is the only one offered — the client never builds a URL for a job it may not own.
 *
 * The filters are those of the explorer at the moment of the click, so an export is exactly
 * the view the caller was looking at, no wider. The server re-derives the caller's scope when
 * the job runs, so a queued export cannot outlive a permission change.
 */

const POLL_INTERVAL_MS = 2000;

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Prompts the browser to save the fetched CSV, revoking the object URL immediately. */
async function saveExport(id: string): Promise<void> {
  const { filename, blob } = await fetchAuditExportFile(id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface AuditExportPanelProps {
  /** The explorer's current filters; the export captures exactly this view. */
  filters: AuditListParams;
  /** `audit:export`, resolved by the caller; the panel is not rendered without it. */
  canExport: boolean;
  /** `audit:read.security`, needed only for a security-class-only export. */
  canReadSecurity: boolean;
}

export function AuditExportPanel({ filters, canExport, canReadSecurity }: AuditExportPanelProps) {
  const [exportId, setExportId] = useState<string | null>(null);

  const queue = useMutation({
    mutationFn: () => requestAuditExport(filters),
    onSuccess: (data) => setExportId(data.export.id),
  });

  const status = useQuery({
    queryKey: ['audit-export', exportId],
    queryFn: ({ signal }) => getAuditExport(exportId as string, signal),
    enabled: exportId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.export.status;
      return state === 'QUEUED' || state === 'RUNNING' ? POLL_INTERVAL_MS : false;
    },
  });

  if (!canExport) return null;

  const securityOnlyBlocked = filters.securityOnly === true && !canReadSecurity;

  return (
    <section
      aria-labelledby="audit-export-heading"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="audit-export-heading" className="text-sm font-semibold text-content">
            Export the log
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-content-muted">
            Exports run off the request path and cover exactly the filters above. The export is
            recorded in the log with those filters, and the file is available for a limited time.
          </p>
        </div>
        <button
          type="button"
          onClick={() => queue.mutate()}
          disabled={queue.isPending || securityOnlyBlocked}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {queue.isPending ? 'Queuing export…' : 'Export CSV'}
        </button>
      </div>

      {securityOnlyBlocked && (
        <p role="alert" className="text-sm text-danger">
          A security-class export needs the security-read grant, which this account does not hold.
        </p>
      )}
      {(queue.error || status.error) && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(queue.error ?? status.error)}
        </p>
      )}

      {status.data?.export && <ExportJobStatus job={status.data.export} />}
    </section>
  );
}

/**
 * The job's progress and, on success, its time-limited download. The link is offered only
 * while the server reports one, so an expired export is never presented as downloadable.
 */
function ExportJobStatus({ job }: { job: AuditExportJob }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
      <StatusBadge tone={job.status === 'FAILED' ? 'danger' : 'info'}>{job.status}</StatusBadge>
      {job.status === 'SUCCEEDED' && <span>{job.rowCount} rows</span>}
      {job.expiresAt && job.downloadUrl && (
        <span>Available until {new Date(job.expiresAt).toLocaleString()}</span>
      )}
      {job.error && <span className="text-danger">{job.error}</span>}
      {job.downloadUrl && (
        <button
          type="button"
          onClick={() => void saveExport(job.id)}
          className="rounded border border-border px-3 py-1.5 text-sm text-content"
        >
          Download CSV
        </button>
      )}
    </div>
  );
}
