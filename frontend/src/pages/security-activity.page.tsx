import { AuditExplorer } from '../components/audit-explorer';

/**
 * Security activity view (docs/31 §11).
 *
 * The security class only — authentication, authorization, denials and administrative
 * grants (`docs/31` §2). Guarded by `audit:read.security`, which no default tenant role
 * holds (`docs/07` §3): the class is a raised privilege, and the server refuses the request
 * for a caller without it rather than returning an empty page.
 */
export function SecurityActivityPage() {
  return (
    <AuditExplorer
      source="security"
      headingId="security-activity-heading"
      heading="Security activity"
      description="Authentication, authorization, access denials and administrative grants. This is the security class of the audit log, visible only to a role granted audit:read.security."
    />
  );
}
