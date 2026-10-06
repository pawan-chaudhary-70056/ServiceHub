import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/auth-context';

/**
 * Route guard (docs/14, docs/16).
 *
 * A guard is a **convenience, not a control**: it prevents an unauthorised screen from
 * rendering against the API, which would otherwise show an error state or, worse, a
 * shell full of controls that all fail. The server independently rejects every request
 * the caller is not entitled to make, so a route that forgets this wrapper is a UX bug,
 * never a security hole (docs/07, docs/17).
 */
export interface RequireAuthProps {
  children: ReactNode;
  /**
   * Optional permission the route requires. Checked for a clearer message than a screen
   * of failing requests; the server remains the authority.
   */
  permission?: string;
  /**
   * Optional set of permissions, any one of which admits the route. Reads are commonly
   * expressed as scoped grants (`request:read.own | .team | .any`), so a reader holds
   * exactly one of them and a single-permission check would wrongly exclude them.
   */
  anyPermission?: readonly string[];
}

export function RequireAuth({ children, permission, anyPermission }: RequireAuthProps) {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-content-muted">
        Checking your session…
      </p>
    );
  }

  if (!isAuthenticated) {
    // Remember where the user was headed so login can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (permission && !hasPermission(permission)) {
    return <AccessDenied />;
  }

  if (
    anyPermission &&
    anyPermission.length > 0 &&
    !anyPermission.some((key) => hasPermission(key))
  ) {
    return <AccessDenied />;
  }

  return <>{children}</>;
}

function AccessDenied() {
  return (
    <section aria-labelledby="access-denied-heading" className="max-w-prose space-y-2">
      <h1 id="access-denied-heading" className="text-xl font-semibold text-content">
        Access denied
      </h1>
      <p className="text-content-muted">
        Your account does not have permission to view this page. If you believe this is a mistake,
        contact your administrator.
      </p>
    </section>
  );
}
