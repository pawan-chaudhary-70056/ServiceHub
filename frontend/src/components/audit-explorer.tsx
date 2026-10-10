import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  listAudit,
  listSecurityAudit,
  type AuditEntry,
  type AuditListParams,
} from '../api/audit.api';
import { ApiError } from '../api/client';
import { useAuth } from '../hooks/auth-context';
import { AuditExportPanel } from './audit-export-panel';
import { AuditTable } from './audit-table';

/**
 * Audit explorer (docs/31 §11).
 *
 * The same component backs two surfaces with different entitlements:
 *
 *   - **Audit explorer** (`/audit`) — `audit:read.team` or `audit:read.all`, with filters.
 *   - **Security activity** (`/audit/security`) — `audit:read.security`, the security class
 *     only, unfiltered because the endpoint accepts no filters.
 *
 * The component never resolves scope or redaction itself: the rows arrive already scoped
 * and already redacted, and a redacted entry renders as a marker rather than an odd gap.
 */

const PAGE_SIZE = 25;

/** A `datetime-local` value is a local instant; the API filter is an offset ISO string. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface AuditExplorerProps {
  source: 'audit' | 'security';
  headingId: string;
  heading: string;
  description: string;
}

export function AuditExplorer({ source, headingId, heading, description }: AuditExplorerProps) {
  const { hasPermission } = useAuth();
  const isSecuritySource = source === 'security';
  // The security-class filter narrows an already-scoped page; it is only meaningful (and
  // only accepted by the server) for a caller who holds the security grant.
  const canReadSecurity = hasPermission('audit:read.security');
  // Export is its own grant, distinct from reading (`docs/31` §9): a disclosure action, not
  // a page view. The panel is not rendered without it rather than shown-then-refused.
  const canExport = hasPermission('audit:export');

  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [securityOnly, setSecurityOnly] = useState(false);

  const fromIso = toIso(from);
  const toIsoValue = toIso(to);

  // `/audit/security` is validated strictly and accepts only pagination, so the security
  // surface sends nothing else; the explorer surface sends whichever filters are set.
  const filters: AuditListParams = isSecuritySource
    ? {}
    : {
        ...(action ? { action } : {}),
        ...(actorId ? { actorId } : {}),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        ...(fromIso ? { from: fromIso } : {}),
        ...(toIsoValue ? { to: toIsoValue } : {}),
        ...(securityOnly ? { securityOnly: true } : {}),
      };

  const query = useInfiniteQuery({
    queryKey: ['audit', source, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = { ...filters, limit: PAGE_SIZE, cursor: pageParam };
      return isSecuritySource
        ? listSecurityAudit(
            { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
            signal,
          )
        : listAudit(params, signal);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const entries: AuditEntry[] = query.data?.pages.flatMap((page) => page.items) ?? [];

  const reset = (): void => {
    setAction('');
    setActorId('');
    setEntityType('');
    setEntityId('');
    setFrom('');
    setTo('');
    setSecurityOnly(false);
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby={headingId}>
        <h1 id={headingId} className="text-2xl font-semibold text-content">
          {heading}
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">{description}</p>
        <p className="mt-2 max-w-3xl text-xs text-content-muted">
          Every view of this log is itself recorded, scoped to what you may read.
        </p>
      </section>

      {!isSecuritySource && (
        <form
          className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-content-muted">Action</span>
            <input
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder="request.status.change"
              className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-content"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-content-muted">Actor id</span>
            <input
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-content"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-content-muted">Entity type</span>
            <input
              value={entityType}
              onChange={(event) => setEntityType(event.target.value)}
              placeholder="ServiceRequest"
              className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-content"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-content-muted">Entity id</span>
            <input
              value={entityId}
              onChange={(event) => setEntityId(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-xs text-content"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-content-muted">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-1.5 text-content"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-content-muted">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-1.5 text-content"
            />
          </label>
          {canReadSecurity && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={securityOnly}
                onChange={(event) => setSecurityOnly(event.target.checked)}
              />
              <span className="text-content-muted">Security class only</span>
            </label>
          )}
          <div className="flex items-end">
            <button
              type="button"
              onClick={reset}
              className="rounded border border-border px-3 py-1.5 text-sm text-content-muted hover:text-content"
            >
              Reset filters
            </button>
          </div>
        </form>
      )}

      {!isSecuritySource && (
        <AuditExportPanel
          filters={filters}
          canExport={canExport}
          canReadSecurity={canReadSecurity}
        />
      )}

      {query.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading audit entries…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(query.error)}
        </p>
      )}
      {query.isSuccess && <AuditTable entries={entries} />}

      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="rounded border border-border px-3 py-2 text-sm text-content-muted hover:text-content disabled:opacity-60"
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
