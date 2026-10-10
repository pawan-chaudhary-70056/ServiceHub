import type { AuditEntry } from '../api/audit.api';

/**
 * Audit diff viewer (docs/31 §11).
 *
 * The audit contract stores snapshots as JSON (`docs/31` §4), and two rules from that
 * section shape this rendering:
 *
 *   1. A **redacted** entry is rendered as a redaction marker, never as an empty diff.
 *      Showing "no changes" for a withheld payload would be a lie about what happened.
 *   2. An absent snapshot (`null`) is different from a payload whose fields are all null,
 *      so the two are labelled differently.
 *
 * Values are printed, never injected: an audit payload is attacker-influenced data (it
 * records what a user submitted), so it is rendered as text through React, which escapes
 * it, and never through `dangerouslySetInnerHTML`.
 */

/** Coerces a JSON snapshot into a flat-ish record, or `null` when there is no payload. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // A non-object snapshot still has a value worth showing under a single key.
  return { value };
}

function renderValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export interface AuditDiffProps {
  before: unknown;
  after: unknown;
  redacted: boolean;
}

export function AuditDiff({ before, after, redacted }: AuditDiffProps) {
  if (redacted) {
    return (
      <p className="text-xs text-content-muted">
        Redacted — reading this security-class entry requires{' '}
        <span className="font-mono">audit:read.security</span>.
      </p>
    );
  }

  const beforeFields = asRecord(before);
  const afterFields = asRecord(after);
  const keys = [
    ...new Set([...Object.keys(beforeFields ?? {}), ...Object.keys(afterFields ?? {})]),
  ].sort();

  if (keys.length === 0) {
    return <p className="text-xs text-content-muted">No field-level detail recorded.</p>;
  }

  return (
    <dl className="grid gap-1 text-xs" data-testid="audit-diff">
      {keys.map((key) => {
        const previous = beforeFields?.[key];
        const next = afterFields?.[key];
        const changed = JSON.stringify(previous) !== JSON.stringify(next);
        return (
          <div key={key} className="flex flex-wrap items-baseline gap-2">
            <dt className="font-mono text-content-muted">{key}</dt>
            <dd className={changed ? 'text-content' : 'text-content-muted'}>
              <span className="text-content-muted">{renderValue(previous)}</span>
              {changed && <span aria-hidden="true"> → </span>}
              {changed && <span className="font-medium">{renderValue(next)}</span>}
              {changed && <span className="sr-only">changed</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A single entry's detail block: the diff, plus the fields that make an entry
 * reconstructable (`docs/31` §7 — correlation id, actor type, reason).
 */
export function AuditEntryDetail({ entry }: { entry: AuditEntry }) {
  return (
    <div className="space-y-2 rounded border border-border bg-surface-muted p-3">
      <AuditDiff before={entry.before} after={entry.after} redacted={entry.redacted} />
      <dl className="grid gap-1 text-xs text-content-muted">
        <div className="flex gap-2">
          <dt className="font-medium">Correlation</dt>
          <dd className="font-mono">{entry.correlationId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">Actor type</dt>
          <dd>{entry.actorType}</dd>
        </div>
        {entry.reason && (
          <div className="flex gap-2">
            <dt className="font-medium">Reason</dt>
            <dd>{entry.reason}</dd>
          </div>
        )}
        {!entry.redacted && entry.sourceIp && (
          <div className="flex gap-2">
            <dt className="font-medium">Source</dt>
            <dd className="font-mono">{entry.sourceIp}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
