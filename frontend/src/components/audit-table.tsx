import type { AuditEntry } from '../api/audit.api';
import { shortId } from '../utils/short-id';
import { AuditEntryDetail } from './audit-diff';
import { StatusBadge } from './status-badge';

/**
 * Audit entry table (docs/31 §11).
 *
 * One row per entry, with the field-level diff behind a disclosure so a page of a hundred
 * entries stays scannable. The **Redacted** badge is part of the row, not only the detail:
 * a viewer scanning the log must be able to tell a withheld security entry from an entry
 * with nothing in it.
 */

export function AuditTable({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-content-muted">No audit entries match these filters.</p>;
  }

  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Audit log entries, newest first</caption>
      <thead>
        <tr className="border-b border-border text-left text-content-muted">
          <th scope="col" className="py-2 pr-4">
            Time
          </th>
          <th scope="col" className="py-2 pr-4">
            Action
          </th>
          <th scope="col" className="py-2 pr-4">
            Actor
          </th>
          <th scope="col" className="py-2 pr-4">
            Entity
          </th>
          <th scope="col" className="py-2">
            Details
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id} className="border-b border-border align-top">
            <td className="whitespace-nowrap py-2 pr-4 text-content-muted">
              {new Date(entry.occurredAt).toLocaleString()}
            </td>
            <td className="py-2 pr-4">
              <span className="font-mono text-xs text-content">{entry.action}</span>
              {entry.security && (
                <span className="ml-2 inline-flex">
                  {entry.redacted ? (
                    <StatusBadge tone="warning">Redacted</StatusBadge>
                  ) : (
                    <StatusBadge tone="info">Security</StatusBadge>
                  )}
                </span>
              )}
            </td>
            <td className="py-2 pr-4">
              <span className="block text-xs text-content-muted">{entry.actorType}</span>
              <span className="font-mono text-xs text-content" title={entry.actorId ?? undefined}>
                {shortId(entry.actorId)}
              </span>
            </td>
            <td className="py-2 pr-4">
              <span className="block text-xs text-content-muted">{entry.entityType}</span>
              <span className="font-mono text-xs text-content" title={entry.entityId ?? undefined}>
                {shortId(entry.entityId)}
              </span>
            </td>
            <td className="py-2">
              <details>
                <summary className="cursor-pointer text-xs text-brand">View</summary>
                <div className="mt-2">
                  <AuditEntryDetail entry={entry} />
                </div>
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
