import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/auth-context';
import { NotificationBell } from './notification-bell';

/**
 * Application shell — the persistent frame around every route (docs/16).
 *
 * Landmarks are real landmarks (`banner`, `navigation`, `main`), not styled divs: a
 * screen-reader user navigates by landmark, and this is the cheapest accessibility win
 * in the whole application. The skip link is first in the DOM so a keyboard user can
 * bypass navigation without tabbing through it on every page.
 *
 * Navigation entries are added as each feature's document reaches `Approved`, and each
 * entry is visible only to a caller who may use it (docs/07) — navigation is a hint,
 * never a control.
 */
export interface AppShellProps {
  children: ReactNode;
}

const APP_NAME = import.meta.env.VITE_APP_NAME ?? 'ServiceHub';

export function AppShell({ children }: AppShellProps) {
  const { user, isAuthenticated, hasPermission, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async (): Promise<void> => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only rounded bg-brand px-3 py-2 text-content-inverted focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to main content
      </a>

      <header role="banner" className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-content">{APP_NAME}</span>
            <span className="hidden text-sm text-content-muted sm:inline">
              Enterprise service management
            </span>
          </div>

          <nav aria-label="Primary" className="flex items-center gap-4 text-sm">
            {isAuthenticated ? (
              <>
                {hasPermission('platform:organization:manage') && (
                  <Link to="/superadmin" className="text-content-muted hover:text-content">
                    Platform admin
                  </Link>
                )}
                {(hasPermission('request:read.own') ||
                  hasPermission('request:read.team') ||
                  hasPermission('request:read.any')) && (
                  <Link to="/requests" className="text-content-muted hover:text-content">
                    Requests
                  </Link>
                )}
                {(hasPermission('incident:read.own') ||
                  hasPermission('incident:read.team') ||
                  hasPermission('incident:read.any')) && (
                  <Link to="/incidents" className="text-content-muted hover:text-content">
                    Incidents
                  </Link>
                )}
                {(hasPermission('task:update.own') ||
                  hasPermission('task:update.team') ||
                  hasPermission('task:update.any')) && (
                  <Link to="/tasks" className="text-content-muted hover:text-content">
                    My tasks
                  </Link>
                )}
                {(hasPermission('approval:decide') || hasPermission('approval:read.pending')) && (
                  <Link to="/approvals" className="text-content-muted hover:text-content">
                    Approvals
                  </Link>
                )}
                <Link to="/search" className="text-content-muted hover:text-content">
                  Search
                </Link>
                {hasPermission('report:read') && (
                  <Link to="/reports" className="text-content-muted hover:text-content">
                    Reports
                  </Link>
                )}
                {hasPermission('catalog:read') && (
                  <Link to="/catalog" className="text-content-muted hover:text-content">
                    Catalog
                  </Link>
                )}
                {hasPermission('user:manage') && (
                  <Link to="/users" className="text-content-muted hover:text-content">
                    Users
                  </Link>
                )}
                {hasPermission('admin:config') && (
                  <Link
                    to="/admin/approval-templates"
                    className="text-content-muted hover:text-content"
                  >
                    Approval templates
                  </Link>
                )}
                <NotificationBell />
                <span className="text-content">{user?.displayName}</span>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="rounded border border-border px-3 py-1 text-content-muted hover:text-content"
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="text-content-muted hover:text-content">
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main id="main" role="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {children}
      </main>

      <footer className="border-t border-border bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-4 text-xs text-content-muted">
          Scaffold build — domain features are added as their documents reach{' '}
          <span className="font-mono">Approved</span> at the phase gate.
        </div>
      </footer>
    </div>
  );
}
