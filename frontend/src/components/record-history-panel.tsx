import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { getRecordHistory } from '../api/audit.api';
import { shortId } from '../utils/short-id';
import { AuditEntryDetail } from './audit-diff';

/**
 * Record history timeline (docs/31 §11, §5).
 *
 * The first of the four audit UI surfaces: a human-readable trail on a record. It reads the
 * generic projection `/audit/records/{entityType}/{entityId}`, which is authorised by the
 * **record's own visibility** — a caller looking at a record can see how it got here,
 * without holding an audit grant. Each record type resolves that visibility differently
 * (`ServiceRequest`/`Incident` by their own scope, `Task` through its parent, `Asset` by
 * holder, `Article` by visibility class), and the server owns that decision.
 *
 * Two rules from `docs/31` shape the rendering, and both are the server's decision, not
 * this component's:
 *
 *   - security-class entries never appear in a participant's view of a record (§5);
 *   - a withheld payload arrives redacted, and is shown as a redaction marker rather than
 *     an empty diff (§4).
 */

const LIMIT = 50;

export type RecordHistoryEntityType = 'ServiceRequest' | 'Incident' | 'Task' | 'Asset' | 'Article';

export interface RecordHistoryPanelProps {
  entityType: RecordHistoryEntityType;
  entityId: string;
  heading?: string;
  headingId?: string;
  /** Pass `null` to omit the explanatory line (e.g. when embedded in a list row). */
  description?: string | null;
}

export function RecordHistoryPanel({
  entityType,
  entityId,
  heading = 'History',
  headingId = 'history-heading',
  description = 'What changed, who changed it and when — the record’s own trail, newest first.',
}: RecordHistoryPanelProps) {
  const history = useQuery({
    queryKey: ['record-history', entityType, entityId],
    queryFn: ({ signal }) => getRecordHistory(entityType, entityId, { limit: LIMIT }, signal),
  });

  const entries = history.data?.history ?? [];

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-lg font-semibold text-content">
        {heading}
      </h2>
      {description && <p className="text-sm text-content-muted">{description}</p>}

      {history.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading history…
        </p>
      )}
      {history.isError && <p className="text-sm text-content-muted">{messageFor(history.error)}</p>}
      {history.isSuccess && entries.length === 0 && (
        <p className="text-sm text-content-muted">No recorded changes yet.</p>
      )}

      {entries.length > 0 && (
        <ol className="space-y-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="rounded border border-border px-3 py-2 text-sm"
              data-testid="record-history-entry"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-xs text-content">{entry.action}</span>
                <span className="text-xs text-content-muted">
                  {new Date(entry.occurredAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-content-muted">
                {entry.actorType} <span className="font-mono">{shortId(entry.actorId)}</span>
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-brand">Details</summary>
                <div className="mt-2">
                  <AuditEntryDetail entry={entry} />
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * A lazy disclosure around the panel, for embedding in a list (e.g. the task list).
 *
 * The panel is mounted only after the disclosure is first opened: a list of tasks must not
 * fire one history request each for rows nobody looked at.
 */
export function RecordHistoryDisclosure({
  entityType,
  entityId,
  label = 'History',
  heading = 'History',
}: {
  entityType: RecordHistoryEntityType;
  entityId: string;
  label?: string;
  heading?: string;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open) setOpened(true);
      }}
    >
      <summary className="cursor-pointer text-xs text-brand">{label}</summary>
      {opened && (
        <div className="mt-2">
          <RecordHistoryPanel
            entityType={entityType}
            entityId={entityId}
            heading={heading}
            headingId={`record-history-${entityId}`}
            description={null}
          />
        </div>
      )}
    </details>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'History is unavailable right now.';
}
