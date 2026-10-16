import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { runReport } from '../api/search.api';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';
import { useHealth } from '../hooks/use-health';
import { cn } from '../utils/cn';

/**
 * Landing page (docs/16).
 *
 * Three jobs, in the order a visitor needs them:
 *
 *   1. **Say what this is**, and give the next action — sign in, or go to the work.
 *   2. **Show the work waiting for the signed-in caller**, read live from the reporting
 *      surface (`docs/30 §3.3`). Those are the server's figures, scoped to the caller, not
 *      counts this page invents: a landing page full of numbers no screen computed is the
 *      fastest way for a product to be trusted past its accuracy.
 *   3. **Map every implemented area** to the screen that serves it, with its owning
 *      document beside it.
 *
 * Availability is stated per caller (`docs/07 §3`): an area the caller cannot open is shown
 * as such rather than hidden, because "this exists but is not for you" and "this does not
 * exist" are different answers and only one of them is true. The badge is a hint, never a
 * control — the server re-checks every request.
 */

interface FeatureArea {
  name: string;
  /** Two-letter monogram, so the grid reads as a product rather than a list of links. */
  abbr: string;
  /** What the area does, in one line, from its owning document. */
  summary: string;
  /** The owning document, so a reader can go from the screen to its specification. */
  doc: string;
  path: string;
  /**
   * Permissions, any one of which admits the screen. Empty means every authenticated
   * member may use it. Mirrors the route guard in `routes/index.tsx` and the entry in
   * `components/app-shell.tsx`, so the three cannot tell a user three different stories.
   */
  anyPermission: readonly string[];
}

const FEATURE_AREAS: readonly FeatureArea[] = [
  {
    name: 'Service Catalog',
    abbr: 'SC',
    summary: 'Standard services people can order, each with its request form and approval rules.',
    doc: '21',
    path: '/catalog',
    anyPermission: ['catalog:read'],
  },
  {
    name: 'Service Requests',
    abbr: 'SR',
    summary: 'Raise, triage, approve and fulfil requests against a frozen SLA target.',
    doc: '22',
    path: '/requests',
    anyPermission: ['request:read.own', 'request:read.team', 'request:read.any'],
  },
  {
    name: 'Incident Management',
    abbr: 'IM',
    summary:
      'Report, triage, resolve and close incidents — priority derived from impact and urgency.',
    doc: '23',
    path: '/incidents',
    anyPermission: ['incident:read.own', 'incident:read.team', 'incident:read.any'],
  },
  {
    name: 'Task Management',
    abbr: 'TM',
    summary:
      'The work attached to requests and incidents, with owners, due dates and a closed state machine.',
    doc: '24',
    path: '/tasks',
    anyPermission: ['task:update.own', 'task:update.team', 'task:update.any'],
  },
  {
    name: 'SLA Management',
    abbr: 'SL',
    summary:
      'Business calendars, policies and clock targets — with pause, override and the breach sweep.',
    doc: '25',
    path: '/admin/sla',
    anyPermission: ['sla:policy:manage'],
  },
  {
    name: 'Approval Management',
    abbr: 'AM',
    summary:
      'Approval steps on gated work: designated approvers, insert-only decisions, recorded reasons.',
    doc: '26',
    path: '/approvals',
    anyPermission: ['approval:decide', 'approval:read.pending'],
  },
  {
    name: 'Knowledge Base',
    abbr: 'KB',
    summary: 'Published articles with review, versioning and links to the records they answer.',
    doc: '27',
    path: '/kb',
    anyPermission: ['kb:article:read'],
  },
  {
    name: 'Asset Management',
    abbr: 'AS',
    summary: 'The asset register: types, assignment history and the full lifecycle of every asset.',
    doc: '28',
    path: '/assets',
    anyPermission: ['asset:read.own', 'asset:read.any'],
  },
];

/** The cross-cutting surfaces the eight areas are recorded and reported through. */
const SHARED_AREAS: readonly FeatureArea[] = [
  {
    name: 'Notifications',
    abbr: 'NT',
    summary: 'In-app and email notifications from every domain event, with per-user preferences.',
    doc: '29',
    path: '/notifications',
    anyPermission: [],
  },
  {
    name: 'Search',
    abbr: 'SE',
    summary: 'One search across records, scoped by the server to what each caller may read.',
    doc: '30',
    path: '/search',
    anyPermission: [],
  },
  {
    name: 'Reporting',
    abbr: 'RP',
    summary: 'Metrics and CSV exports computed from the same timestamps as the records themselves.',
    doc: '30',
    path: '/reports',
    anyPermission: ['report:read'],
  },
  {
    name: 'Audit log',
    abbr: 'AU',
    summary:
      'Every mutation, written in the same transaction as the change — filterable and exportable.',
    doc: '31',
    path: '/audit',
    anyPermission: ['audit:read.team', 'audit:read.all'],
  },
  {
    name: 'Integrations',
    abbr: 'IN',
    summary: 'Outbound and inbound webhooks, roster sync, and the health of every delivery.',
    doc: '32',
    path: '/admin/integrations',
    anyPermission: ['integration:read'],
  },
];

// ---------------------------------------------------------------------------
// Live workload ("what is waiting on me")
// ---------------------------------------------------------------------------

/**
 * A workload tile reads one metric from the reporting surface. The count function takes
 * `unknown` because figures are a per-metric record: a tile returns `undefined` rather
 * than a wrong number when the shape it expects is not there.
 */
interface WorkloadTile {
  key: string;
  label: string;
  to: string;
  /** Permissions, any one of which admits both the report and the screen it links to. */
  anyPermission: readonly string[];
  count: (figures: Record<string, unknown>) => number | undefined;
}

const OPEN_STATUSES = {
  requests: ['NEW', 'TRIAGED', 'APPROVAL_PENDING', 'APPROVED', 'IN_PROGRESS'],
  incidents: ['NEW', 'IN_PROGRESS'],
  tasks: ['TODO', 'IN_PROGRESS', 'BLOCKED'],
} as const;

function openFromStatuses(figures: Record<string, unknown>, open: readonly string[]) {
  const byStatus = figures.byStatus;
  if (!byStatus || typeof byStatus !== 'object') {
    // The metric did not carry the shape this tile reads. An absent figure renders as a
    // dash rather than a plausible zero — a wrong number is worse than no number.
    return undefined;
  }
  return Object.entries(byStatus as Record<string, unknown>).reduce<number>(
    (total, [status, value]) =>
      typeof value === 'number' && open.includes(status) ? total + value : total,
    0,
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const WORKLOAD_TILES: readonly WorkloadTile[] = [
  {
    key: 'requests',
    label: 'Open requests',
    to: '/requests',
    anyPermission: ['request:read.own', 'request:read.team', 'request:read.any'],
    count: (figures) => openFromStatuses(figures, OPEN_STATUSES.requests),
  },
  {
    key: 'incidents',
    label: 'Open incidents',
    to: '/incidents',
    anyPermission: ['incident:read.own', 'incident:read.team', 'incident:read.any'],
    count: (figures) => openFromStatuses(figures, OPEN_STATUSES.incidents),
  },
  {
    key: 'tasks',
    label: 'Tasks assigned',
    to: '/tasks',
    anyPermission: ['task:update.own', 'task:update.team', 'task:update.any'],
    count: (figures) => openFromStatuses(figures, OPEN_STATUSES.tasks),
  },
  {
    key: 'approvals',
    label: 'Awaiting decision',
    to: '/approvals',
    anyPermission: ['approval:decide', 'approval:read.pending'],
    count: (figures) => positiveNumber(figures.pending),
  },
];

/**
 * The four counts, read once each. `docs/30 §3.4` caches them per tenant and invalidates on
 * write, so this strip is four short reads rather than a scan of the records.
 */
const WORKLOAD_METRICS = [
  { key: 'requests', metric: 'requests.summary' },
  { key: 'incidents', metric: 'incidents.summary' },
  { key: 'tasks', metric: 'tasks.summary' },
  { key: 'approvals', metric: 'approvals.turnaround' },
] as const;

export function HomePage() {
  const health = useHealth();
  const { isAuthenticated, hasPermission } = useAuth();

  /** Whether this caller can open the area's screen. A hint, not an authorization. */
  function isAvailable(area: FeatureArea): boolean {
    return area.anyPermission.length === 0 || area.anyPermission.some(hasPermission);
  }

  const mayReadReports = hasPermission('report:read');
  const requested = WORKLOAD_TILES.filter((tile) => tile.anyPermission.some(hasPermission));

  // Every metric goes through one query each, so a figure the caller's scope denies does
  // not take the page with it: the tile simply does not render.
  const reports = useQuery({
    queryKey: ['home', 'workload', requested.map((tile) => tile.key).join(',')],
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        WORKLOAD_METRICS.map(
          async ({ key, metric }) =>
            [key, (await runReport(metric, {}, signal)).report.figures] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<string, Record<string, unknown>>;
    },
    enabled: isAuthenticated && mayReadReports && requested.length > 0,
    staleTime: 60_000,
  });

  function renderArea(area: FeatureArea) {
    const available = isAvailable(area);

    return (
      <li
        key={area.path}
        className={cn(
          'rounded-lg border border-border bg-surface-raised p-4',
          !available && !isAuthenticated && 'opacity-90',
        )}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand/10 font-semibold text-brand"
          >
            {area.abbr}
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={area.path}
                className="font-medium text-content underline-offset-2 hover:underline"
              >
                {area.name}
              </Link>
              {!isAuthenticated ? (
                <StatusBadge tone="info">Sign in</StatusBadge>
              ) : available ? (
                <StatusBadge tone="success">Available</StatusBadge>
              ) : (
                <StatusBadge tone="warning">No access</StatusBadge>
              )}
            </div>
            <p className="mt-1 text-sm text-content-muted">{area.summary}</p>
            <p className="mt-1 font-mono text-xs text-content-muted">docs/{area.doc}</p>
          </div>
        </div>
      </li>
    );
  }

  return (
    <div className="space-y-10">
      {/* Hero ---------------------------------------------------------------- */}
      <section
        aria-labelledby="welcome-heading"
        className="rounded-xl border border-border bg-surface-raised px-6 py-10 sm:px-10"
      >
        <p className="text-sm font-semibold uppercase tracking-wide text-brand">
          Enterprise service management
        </p>
        <h1 id="welcome-heading" className="mt-2 text-3xl font-semibold text-content">
          ServiceHub
        </h1>
        <p className="mt-3 max-w-3xl text-content-muted">
          Service catalog, requests, incidents, tasks, SLA, approvals, knowledge and assets — with
          audit, notifications and reporting.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {isAuthenticated ? (
            <>
              <Link
                to="/requests"
                className="rounded bg-brand px-4 py-2 text-sm font-medium text-content-inverted"
              >
                Go to my work
              </Link>
              <Link
                to="/search"
                className="rounded border border-border px-4 py-2 text-sm text-content"
              >
                Search everything
              </Link>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded bg-brand px-4 py-2 text-sm font-medium text-content-inverted"
              >
                Sign in
              </Link>
              <Link
                to="/catalog"
                className="rounded border border-border px-4 py-2 text-sm text-content"
              >
                Browse the catalog
              </Link>
            </>
          )}
        </div>

        {/* System status sits with the hero so a visitor sees the answer before looking for
            it; the three states are distinguished because they need different action —
            unreachable means "check your connection", not ready means "a dependency is
            down", loading means "wait". Collapsing them into one error is how a
            service-desk ticket becomes unactionable. */}
        <div
          className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4 text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="text-content-muted">API status</span>

          {health.isPending && <StatusBadge tone="info">Checking…</StatusBadge>}

          {health.isSuccess && health.data.unreachable && (
            <StatusBadge tone="danger">API unreachable</StatusBadge>
          )}

          {health.isSuccess && !health.data.unreachable && health.data.ready && (
            <StatusBadge tone="success">Ready</StatusBadge>
          )}

          {health.isSuccess && !health.data.unreachable && !health.data.ready && (
            <StatusBadge tone="warning">Not ready — a dependency is down</StatusBadge>
          )}

          {health.isSuccess && !health.data.unreachable && health.data.checks.length > 0 && (
            <span className="text-content-muted">
              {health.data.checks.map((check) => (
                <span key={check.name} className="mr-3">
                  <span className="font-mono">{check.name}</span>: {check.status}
                </span>
              ))}
            </span>
          )}
        </div>
      </section>

      {/* Live workload ------------------------------------------------------- */}
      {isAuthenticated && mayReadReports && requested.length > 0 && (
        <section aria-labelledby="workload-heading">
          <h2 id="workload-heading" className="text-lg font-semibold text-content">
            Waiting on you
          </h2>
          <p className="mt-1 text-sm text-content-muted">
            Live figures for your scope, from the reporting surface — not a summary this page
            computed on its own.
          </p>

          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {requested.map((tile) => (
              <li key={tile.key} className="rounded-lg border border-border bg-surface-raised p-4">
                <Link to={tile.to} className="group">
                  <p className="text-sm text-content-muted">{tile.label}</p>
                  <p className="mt-1 text-3xl font-semibold text-content group-hover:text-brand">
                    {reports.isSuccess ? (tile.count(reports.data[tile.key] ?? {}) ?? '—') : '…'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Functional areas ---------------------------------------------------- */}
      <section aria-labelledby="scope-heading">
        <h2 id="scope-heading" className="text-lg font-semibold text-content">
          Functional areas
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-content-muted">
          Every area below is implemented and specified in its owning document. An area marked{' '}
          <span className="font-medium">No access</span> exists but is not available to your role —
          ask an administrator for the grant if you need it.
        </p>

        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURE_AREAS.map(renderArea)}
        </ul>
      </section>

      <section aria-labelledby="shared-heading">
        <h2 id="shared-heading" className="text-lg font-semibold text-content">
          Shared services
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-content-muted">
          Every action above is recorded in the audit log, delivered through notifications and
          reportable from the same data.
        </p>

        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SHARED_AREAS.map(renderArea)}
        </ul>
      </section>
    </div>
  );
}
