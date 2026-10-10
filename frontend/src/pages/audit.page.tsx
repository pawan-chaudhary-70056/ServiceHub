import { AuditExplorer } from '../components/audit-explorer';

/**
 * Audit explorer (docs/31 §11).
 *
 * For leads and administrators: a filterable view of the log with a field-level diff. The
 * scope is the caller's (`audit:read.team` narrows to the team, `audit:read.all` is the
 * tenant), applied by the server as a query predicate — this screen never filters.
 */
export function AuditPage() {
  return (
    <AuditExplorer
      source="audit"
      headingId="audit-heading"
      heading="Audit log"
      description="Every change to a record, who made it and what it changed. What you can see here is scoped to your role, and viewing the log is itself recorded."
    />
  );
}
