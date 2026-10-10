import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../components/require-auth';
import { AcceptInvitationPage } from '../pages/accept-invitation.page';
import { ApprovalTemplatesPage } from '../pages/approval-templates.page';
import { ApprovalsPage } from '../pages/approvals.page';
import { ArticlePage } from '../pages/article.page';
import { AssetDetailPage } from '../pages/asset-detail.page';
import { AuditPage } from '../pages/audit.page';
import { SecurityActivityPage } from '../pages/security-activity.page';
import { AssetsPage } from '../pages/assets.page';
import { CatalogPage } from '../pages/catalog.page';
import { KbPage } from '../pages/kb.page';
import { HomePage } from '../pages/home.page';
import { IncidentDetailPage } from '../pages/incident-detail.page';
import { IntegrationsPage } from '../pages/integrations.page';
import { IncidentsPage } from '../pages/incidents.page';
import { NotificationPreferencesPage } from '../pages/notification-preferences.page';
import { NotificationsPage } from '../pages/notifications.page';
import { LoginPage } from '../pages/login.page';
import { MyTasksPage } from '../pages/my-tasks.page';
import { NotFoundPage } from '../pages/not-found.page';
import { ReportsPage } from '../pages/reports.page';
import { RequestDetailPage } from '../pages/request-detail.page';
import { RequestsPage } from '../pages/requests.page';
import { SearchPage } from '../pages/search.page';
import { SecurityPage } from '../pages/security.page';
import { SuperAdminPage } from '../pages/superadmin.page';
import { TeamsPage } from '../pages/teams.page';
import { UsersPage } from '../pages/users.page';

/**
 * The route table (docs/14; navigation UX is `docs/16`).
 *
 * This module owns **route → component → required permission** mapping. Two rules:
 *
 *   1. A route guard is a *convenience*, not a control. It stops an authorised-looking
 *      screen from rendering; the server independently decides what data the caller may
 *      receive (docs/07, docs/17). A screen that hides a button but is backed by an
 *      unguarded endpoint is a defect, not a UI bug.
 *   2. Feature routes are added here as their documents reach `Approved`, each with its
 *      required permission declared alongside it so the requirement is visible at the
 *      surface and not only in the service.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />

      {/* Public identity routes: sign in, and the invitation link a new user follows
          to establish their first credential (docs/06 §11). */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />

      {/* Platform administration. Guarded for a clear message; the server enforces the
          permission independently (docs/07 §5, ADR-0012). */}
      <Route
        path="/superadmin"
        element={
          <RequireAuth permission="platform:organization:manage">
            <SuperAdminPage />
          </RequireAuth>
        }
      />

      {/* Service requests. Reading is one capability expressed as three scoped grants, so
          the guard admits any of them (docs/07 §3, §6). */}
      <Route
        path="/requests"
        element={
          <RequireAuth
            anyPermission={['request:read.own', 'request:read.team', 'request:read.any']}
          >
            <RequestsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/requests/:id"
        element={
          <RequireAuth
            anyPermission={['request:read.own', 'request:read.team', 'request:read.any']}
          >
            <RequestDetailPage />
          </RequireAuth>
        }
      />

      {/* Incidents. Reading is one capability expressed as three scoped grants, so the
          guard admits any of them (docs/07 §3, docs/23 §9). Reporting is open to any
          authenticated user. */}
      <Route
        path="/incidents"
        element={
          <RequireAuth
            anyPermission={['incident:read.own', 'incident:read.team', 'incident:read.any']}
          >
            <IncidentsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/incidents/:id"
        element={
          <RequireAuth
            anyPermission={['incident:read.own', 'incident:read.team', 'incident:read.any']}
          >
            <IncidentDetailPage />
          </RequireAuth>
        }
      />

      {/* Tasks. Reading a task inherits its parent's visibility, so the guard admits any
          caller who may work a task (docs/24 §8, rule T2). */}
      <Route
        path="/tasks"
        element={
          <RequireAuth anyPermission={['task:update.own', 'task:update.team', 'task:update.any']}>
            <MyTasksPage />
          </RequireAuth>
        }
      />

      {/* Approvals. The inbox is the caller's own pending decisions; the guard admits a
          caller who may decide or lead/admin who may view pending approvals (docs/26 §10). */}
      <Route
        path="/approvals"
        element={
          <RequireAuth anyPermission={['approval:decide', 'approval:read.pending']}>
            <ApprovalsPage />
          </RequireAuth>
        }
      />

      {/* Service catalog. Guarded by `catalog:read`, which every tenant member holds;
          manage controls are shown only to a caller with `catalog:manage` (docs/21 §6). */}
      <Route
        path="/catalog"
        element={
          <RequireAuth permission="catalog:read">
            <CatalogPage />
          </RequireAuth>
        }
      />

      {/* Tenant administration. Guarded by `user:manage`; the server enforces the
          permission and the tenant scope independently (docs/07 §5, §6). */}
      <Route
        path="/users"
        element={
          <RequireAuth permission="user:manage">
            <UsersPage />
          </RequireAuth>
        }
      />

      {/* Team administration (docs/07 §6). Reading the team list needs only `catalog:read`,
          but this screen also changes membership, which needs `user:manage` — the same
          grant that protects user administration, so it sits beside Users and the server
          re-checks both the permission and the tenant scope. */}
      <Route
        path="/teams"
        element={
          <RequireAuth permission="user:manage">
            <TeamsPage />
          </RequireAuth>
        }
      />

      {/* Notification centre and preferences (docs/29 §12/§13). Self-scoped: any
          authenticated user has exactly one centre, so no permission is required. */}
      <Route
        path="/notifications"
        element={
          <RequireAuth>
            <NotificationsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/me/notification-preferences"
        element={
          <RequireAuth>
            <NotificationPreferencesPage />
          </RequireAuth>
        }
      />

      {/* Account security (docs/06 §7). Self-scoped like the notification centre: the
          session list is keyed on the authenticated identity server-side, so a
          permission guard here would only hide a page the caller already owns. */}
      <Route
        path="/account/security"
        element={
          <RequireAuth>
            <SecurityPage />
          </RequireAuth>
        }
      />

      {/* Unified search (docs/30 §6). Any authenticated member may search; the server
          scopes each source, so no single route permission is correct here. */}
      <Route
        path="/search"
        element={
          <RequireAuth>
            <SearchPage />
          </RequireAuth>
        }
      />

      {/* Reports (docs/30 §6). Guarded by `report:read`; the server narrows the scope and
          reserves cross-team reports for leads and admins. */}
      <Route
        path="/reports"
        element={
          <RequireAuth permission="report:read">
            <ReportsPage />
          </RequireAuth>
        }
      />

      {/* Approval template administration. Guarded by `admin:config`; the server enforces
          the permission and the tenant scope independently (docs/26 §10). */}
      <Route
        path="/admin/approval-templates"
        element={
          <RequireAuth permission="admin:config">
            <ApprovalTemplatesPage />
          </RequireAuth>
        }
      />

      {/* Knowledge base (docs/27 §9). Any tenant member may read knowledge — self-service
          is the point — so the guard is `kb:article:read`, which every tenant role holds.
          The server applies the article's visibility class independently. */}
      <Route
        path="/kb"
        element={
          <RequireAuth permission="kb:article:read">
            <KbPage />
          </RequireAuth>
        }
      />
      <Route
        path="/kb/:id"
        element={
          <RequireAuth permission="kb:article:read">
            <ArticlePage />
          </RequireAuth>
        }
      />

      {/* Asset register (docs/28 §9). Reading is one capability expressed as two scoped
          grants: a holder sees their own, a manager/lead/admin/auditor sees the tenant. */}
      <Route
        path="/assets"
        element={
          <RequireAuth anyPermission={['asset:read.own', 'asset:read.any']}>
            <AssetsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/assets/:id"
        element={
          <RequireAuth anyPermission={['asset:read.own', 'asset:read.any']}>
            <AssetDetailPage />
          </RequireAuth>
        }
      />

      {/* Audit log (docs/31 §11). Reading is one capability expressed as two scoped
          grants, so the explorer admits either; the security-class view is a separate
          raised privilege and is guarded by `audit:read.security` alone. The server
          applies the scope as a query predicate and withholds the security class
          independently of these guards. */}
      <Route
        path="/audit"
        element={
          <RequireAuth anyPermission={['audit:read.team', 'audit:read.all']}>
            <AuditPage />
          </RequireAuth>
        }
      />
      <Route
        path="/audit/security"
        element={
          <RequireAuth permission="audit:read.security">
            <SecurityActivityPage />
          </RequireAuth>
        }
      />

      {/* Integration administration (docs/32 §13). Guarded by `integration:read`; the
          manage/retry controls are shown only to a caller who holds the corresponding
          grant, and the server enforces both independently (docs/32 §11). */}
      <Route
        path="/admin/integrations"
        element={
          <RequireAuth permission="integration:read">
            <IntegrationsPage />
          </RequireAuth>
        }
      />

      {/* Feature routes are registered here in phase-2/phase-3 order — docs/40 §3. */}

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
