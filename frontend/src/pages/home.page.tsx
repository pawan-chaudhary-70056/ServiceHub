import { StatusBadge } from '../components/status-badge';
import { useHealth } from '../hooks/use-health';

/**
 * Placeholder landing page for the scaffold.
 *
 * It shows the eight functional areas and the live API readiness state, which is
 * genuinely useful during setup: it proves the SPA, the API and the database are wired
 * together before any domain screen exists.
 *
 * It deliberately does not fake a dashboard. A home page full of invented numbers is
 * the fastest way for a scaffold to be mistaken for a working product.
 */
const FEATURES: { name: string; doc: string }[] = [
  { name: 'Service Catalog', doc: '21' },
  { name: 'Service Requests', doc: '22' },
  { name: 'Incident Management', doc: '23' },
  { name: 'Task Management', doc: '24' },
  { name: 'SLA Management', doc: '25' },
  { name: 'Approval Management', doc: '26' },
  { name: 'Knowledge Base', doc: '27' },
  { name: 'Asset Management', doc: '28' },
];

export function HomePage() {
  const health = useHealth();

  return (
    <div className="space-y-8">
      <section aria-labelledby="welcome-heading">
        <h1 id="welcome-heading" className="text-2xl font-semibold text-content">
          ServiceHub
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Enterprise service management: service catalog, requests, incidents, tasks, SLA,
          approvals, knowledge and assets — with audit, notifications and reporting.
        </p>
      </section>

      <section aria-labelledby="status-heading" className="rounded-lg border border-border p-4">
        <h2
          id="status-heading"
          className="text-sm font-semibold uppercase tracking-wide text-content-muted"
        >
          API status
        </h2>

        {/*
          The three states are distinguished because they need different user action:
          unreachable means "check your connection"; not ready means "the service is
          degraded"; loading means "wait". Collapsing them into one error is how a
          service-desk ticket becomes unactionable.
        */}
        <div className="mt-3" role="status" aria-live="polite">
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
        </div>

        {health.isSuccess && health.data.checks.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-content-muted">
            {health.data.checks.map((check) => (
              <li key={check.name}>
                <span className="font-mono">{check.name}</span>: {check.status}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="scope-heading">
        <h2 id="scope-heading" className="text-lg font-semibold text-content">
          Functional areas
        </h2>
        <p className="mt-1 text-sm text-content-muted">
          Each area is specified in its owning document and is implemented once that document is
          approved at the phase gate.
        </p>

        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <li key={feature.doc} className="rounded-lg border border-border p-4">
              <p className="font-medium text-content">{feature.name}</p>
              <p className="mt-1 font-mono text-xs text-content-muted">docs/{feature.doc}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
