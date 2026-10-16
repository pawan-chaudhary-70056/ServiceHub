import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  fetchReportExportFile,
  getReportExport,
  requestReportExport,
  runReport,
  type ReportExport,
} from '../api/search.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Reports (docs/30 §3, §6).
 *
 * Each report states the period, time zone and scope it was run under (`docs/30` §3.2 R2):
 * a number without its scope is not a report. The server decides the scope from the
 * caller's grants, and a cross-team report the caller may not run is refused with a clear
 * message rather than quietly narrowed.
 */

const METRICS = [
  { key: 'requests.summary', label: 'Requests' },
  { key: 'requests.resolution', label: 'Request resolution' },
  { key: 'incidents.summary', label: 'Incidents' },
  { key: 'incidents.mttr', label: 'Incident MTTR' },
  { key: 'tasks.summary', label: 'Tasks' },
  { key: 'tasks.workload', label: 'Task workload' },
  { key: 'sla.attainment', label: 'SLA attainment' },
  { key: 'notifications.delivery', label: 'Notification delivery' },
  { key: 'approvals.turnaround', label: 'Approval turnaround' },
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Prompts the browser to save a fetched blob. The object URL is revoked immediately after
 * the click, so a large export is not retained in memory.
 */
async function saveExport(id: string): Promise<void> {
  const { filename, blob } = await fetchReportExportFile(id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const [metric, setMetric] = useState<string>('requests.summary');
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));

  const report = useQuery({
    queryKey: ['report', metric, from, to],
    queryFn: ({ signal }) =>
      runReport(
        metric,
        {
          from: new Date(`${from}T00:00:00.000Z`).toISOString(),
          to: new Date(`${to}T23:59:59.999Z`).toISOString(),
        },
        signal,
      ),
  });

  const [exportId, setExportId] = useState<string | null>(null);

  // An export is async (docs/30 §3.4): queue it, then poll the job until it settles.
  const exportJob = useMutation({
    mutationFn: () =>
      requestReportExport(metric, {
        from: new Date(`${from}T00:00:00.000Z`).toISOString(),
        to: new Date(`${to}T23:59:59.999Z`).toISOString(),
      }),
    onSuccess: (data) => setExportId(data.export.id),
  });

  const exportStatus = useQuery({
    queryKey: ['report-export', exportId],
    queryFn: ({ signal }) => getReportExport(exportId as string, signal),
    enabled: exportId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.export.status;
      return status === 'QUEUED' || status === 'RUNNING' ? 2000 : false;
    },
  });

  return (
    <div className="space-y-6">
      <section aria-labelledby="reports-heading">
        <h1 id="reports-heading" className="text-2xl font-semibold text-content">
          Reports
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Figures are computed from stored timestamps and scoped to what you are entitled to see.
        </p>
      </section>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">Report</span>
          <select
            value={metric}
            onChange={(event) => setMetric(event.target.value)}
            className="rounded border border-border bg-surface px-3 py-2 text-content"
          >
            {METRICS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">From</span>
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-content">To</span>
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="rounded border border-border bg-surface px-3 py-2 text-content"
          />
        </label>
        <button
          type="button"
          onClick={() => exportJob.mutate()}
          disabled={exportJob.isPending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {exportJob.isPending ? 'Queuing export…' : 'Export CSV'}
        </button>
      </div>

      <ExportStatus
        job={exportStatus.data?.export ?? null}
        error={exportJob.error ?? exportStatus.error}
      />

      {report.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Running report…
        </p>
      )}
      {report.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(report.error)}
        </p>
      )}

      {report.isSuccess && (
        <section aria-labelledby="report-result-heading" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="report-result-heading" className="text-lg font-semibold text-content">
              Result
            </h2>
            <StatusBadge tone="info">scope: {report.data.report.scope}</StatusBadge>
            <span className="text-xs text-content-muted">
              {new Date(report.data.report.period.from).toLocaleDateString()} –{' '}
              {new Date(report.data.report.period.to).toLocaleDateString()} (
              {report.data.report.period.timeZone})
            </span>
          </div>

          <ReportFigures metric={metric} figures={report.data.report.figures} />
        </section>
      )}
    </div>
  );
}

/**
 * The export job's progress and, on success, its time-limited download (docs/30 §5). The
 * link is only offered while the server says it is live, so an expired link is never shown.
 */
function ExportStatus({ job, error }: { job: ReportExport | null; error: unknown }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {messageFor(error)}
      </p>
    );
  }
  if (!job) return null;

  return (
    <section
      aria-labelledby="export-heading"
      className="space-y-2 rounded border border-border p-4"
    >
      <h2 id="export-heading" className="text-sm font-semibold text-content">
        CSV export
      </h2>
      <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
        <StatusBadge tone={job.status === 'FAILED' ? 'danger' : 'info'}>{job.status}</StatusBadge>
        {job.status === 'SUCCEEDED' && <span>{job.rowCount} rows</span>}
        {job.expiresAt && job.downloadUrl && (
          <span>Available until {new Date(job.expiresAt).toLocaleString()}</span>
        )}
      </div>
      {job.error && <p className="text-sm text-danger">{job.error}</p>}
      {job.downloadUrl && (
        <button
          type="button"
          onClick={() => void saveExport(job.id)}
          className="rounded border border-border px-3 py-1.5 text-sm text-content"
        >
          Download CSV
        </button>
      )}
    </section>
  );
}

function ReportFigures({ metric, figures }: { metric: string; figures: Record<string, unknown> }) {
  if (metric === 'sla.attainment') {
    return (
      <dl className="grid gap-4 sm:grid-cols-4">
        <Figure label="Clocks" value={figures.totalClocks} />
        <Figure label="Attained" value={figures.attained} />
        <Figure label="Breached" value={figures.breached} />
        <Figure label="Attainment" value={formatPercent(figures.attainmentPercent)} />
      </dl>
    );
  }

  if (metric === 'tasks.workload') {
    return (
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Figure label="Open" value={figures.open} />
          <Figure label="Overdue" value={figures.overdue} />
          <Figure label="Completed in period" value={figures.completedInWindow} />
          <Figure label="Overdue share" value={formatPercent(figures.overdueSharePercent)} />
        </dl>
        <CountTable title="Open by status" counts={figures.byStatus} />
      </div>
    );
  }

  if (metric === 'notifications.delivery') {
    return (
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Figure label="Delivered" value={figures.delivered} />
          <Figure label="Failed" value={figures.failed} />
          <Figure label="Dead-lettered" value={figures.deadLettered} />
          <Figure label="Failure rate" value={formatPercent(figures.failureRatePercent)} />
        </dl>
        <p className="text-sm text-content-muted">
          A skipped row is a recipient preference, not a delivery failure (`docs/29` §7), so it is
          counted separately and excluded from the failure rate.
        </p>
        <CountTable title="By status" counts={figures.byStatus} />
      </div>
    );
  }

  if (metric === 'requests.resolution') {
    return (
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Figure label="Resolved" value={figures.resolvedCount} />
          <Figure label="Mean (working)" value={formatMinutes(figures.meanMinutes)} />
          <Figure label="Median (working)" value={formatMinutes(figures.medianMinutes)} />
          <Figure label="Mean elapsed" value={formatMinutes(figures.meanElapsedMinutes)} />
          <Figure label="Median elapsed" value={formatMinutes(figures.medianElapsedMinutes)} />
        </dl>
        <p className="max-w-3xl text-sm text-content-muted">
          Working minutes are measured through each request's own SLA calendar, holidays and time
          zone excluded; elapsed minutes are the raw stored timestamps and never move. Calendars
          actually used are listed, because figures measured on different calendars are not
          comparable (ADR-0008).
        </p>
        <CountTable title="Calendars used" counts={figures.calendarsUsed} />
      </div>
    );
  }

  if (metric === 'incidents.mttr') {
    return (
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Figure label="Resolved" value={figures.resolvedCount} />
          <Figure label="Mean time to resolve" value={formatMinutes(figures.meanMinutes)} />
          <Figure label="Median time to resolve" value={formatMinutes(figures.medianMinutes)} />
          <Figure label="Major incidents" value={figures.majorCount} />
          <Figure label="Reopened" value={figures.reopenedCount} />
          <Figure label="Reopen rate" value={formatPercent(figures.reopenRatePercent)} />
        </dl>
        <p className="max-w-3xl text-sm text-content-muted">
          A reopened incident measures to its latest resolution, so the whole
          report-to-final-resolution time counts — the reopen rate beside it says how much of the
          average that represents.
        </p>
      </div>
    );
  }

  if (metric === 'approvals.turnaround') {
    return (
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Figure label="Decisions" value={figures.decisionCount} />
          <Figure label="Mean turnaround" value={formatMinutes(figures.meanMinutes)} />
          <Figure label="Median turnaround" value={formatMinutes(figures.medianMinutes)} />
          <Figure label="Awaiting decision" value={figures.pending} />
          <Figure label="Past deadline" value={figures.overdue} />
        </dl>
        <p className="max-w-3xl text-sm text-content-muted">
          Turnaround is measured from the step being raised to the decision. The backlog is a
          snapshot at the moment the report ran, not a figure over the period — how much is waiting
          right now is the question it answers.
        </p>
      </div>
    );
  }

  if (metric === 'incidents.summary') {
    return (
      <div className="space-y-4">
        <CountTable title="By status" counts={figures.byStatus} />
        <CountTable title="By priority" counts={figures.byPriority} />
        <dl className="grid gap-4 sm:grid-cols-4">
          <Figure label="Major incidents" value={figures.majorCount} />
        </dl>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CountTable title="By status" counts={figures.byStatus} />
      {figures.byPriority !== undefined && (
        <CountTable title="By priority" counts={figures.byPriority} />
      )}
    </div>
  );
}

function CountTable({ title, counts }: { title: string; counts: unknown }) {
  const map = (counts ?? {}) as Record<string, number>;
  const entries = Object.entries(map);
  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-content-muted">{title}</h3>
      {entries.length === 0 ? (
        <p className="mt-1 text-sm text-content-muted">No records in this period.</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-3">
          {entries.map(([key, count]) => (
            <li key={key} className="rounded border border-border px-3 py-1.5 text-sm">
              <span className="text-content-muted">{key}</span>{' '}
              <span className="font-semibold text-content">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded border border-border p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">{label}</dt>
      <dd className="text-xl font-semibold text-content">{formatValue(value)}</dd>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return String(value);
}

function formatPercent(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return `${String(value)}%`;
}

/** Durations arrive in minutes (one decimal); an em dash for the empty-set case. */
function formatMinutes(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return `${String(value)} min`;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
