import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { search, type SearchEntityType, type SearchResultItem } from '../api/search.api';
import { StatusBadge } from '../components/status-badge';

/**
 * Unified search (docs/30 §6).
 *
 * Results are grouped by type, each with a "why this matched" snippet. What appears is
 * decided entirely by the server's visibility predicate (`docs/30` §2.3 S1); the page never
 * filters or fills gaps client-side, because doing so would imply the caller is entitled to
 * something the server withheld.
 */

const TYPE_LABEL: Record<SearchEntityType, string> = {
  REQUEST: 'Requests',
  INCIDENT: 'Incidents',
  CATALOG_ITEM: 'Catalog',
  USER: 'People',
  ARTICLE: 'Knowledge',
  ASSET: 'Assets',
};

const ORDER: SearchEntityType[] = [
  'REQUEST',
  'INCIDENT',
  'ARTICLE',
  'ASSET',
  'CATALOG_ITEM',
  'USER',
];

export function SearchPage() {
  const [term, setTerm] = useState('');
  const deferred = useDeferredValue(term.trim());

  const results = useQuery({
    queryKey: ['search', deferred],
    queryFn: ({ signal }) => search({ q: deferred }, signal),
    enabled: deferred.length > 0,
  });

  const grouped = new Map<SearchEntityType, SearchResultItem[]>();
  for (const item of results.data?.items ?? []) {
    grouped.set(item.entityType, [...(grouped.get(item.entityType) ?? []), item]);
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="search-heading">
        <h1 id="search-heading" className="text-2xl font-semibold text-content">
          Search
        </h1>
        <p className="mt-2 max-w-3xl text-content-muted">
          Search across the records you can see. You will never be shown a record you are not
          entitled to read — it is simply absent from the results.
        </p>
      </section>

      <label className="block max-w-xl space-y-1 text-sm">
        <span className="block font-medium text-content">Search terms</span>
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Reference, title, name…"
          className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
        />
      </label>

      {deferred.length === 0 && (
        <p className="text-sm text-content-muted">Enter at least a letter to search.</p>
      )}

      {results.isPending && deferred.length > 0 && (
        <p role="status" className="text-sm text-content-muted">
          Searching…
        </p>
      )}
      {results.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(results.error)}
        </p>
      )}

      {results.isSuccess && results.data.fallback === 'EXACT_ONLY' && (
        <p className="rounded border border-border bg-surface-muted px-3 py-2 text-sm text-content-muted">
          Very short queries match exact references only.
        </p>
      )}

      {results.isSuccess && deferred.length > 0 && results.data.items.length === 0 && (
        <p className="text-sm text-content-muted">No matching records.</p>
      )}

      {ORDER.filter((type) => (grouped.get(type) ?? []).length > 0).map((type) => (
        <section key={type} aria-labelledby={`group-${type}`} className="space-y-2">
          <h2
            id={`group-${type}`}
            className="text-sm font-semibold uppercase tracking-wide text-content-muted"
          >
            {TYPE_LABEL[type]}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(grouped.get(type) ?? []).map((item) => (
              <li key={`${item.entityType}:${item.id}`}>
                {item.href ? (
                  <Link to={item.href} className="block px-4 py-3 hover:bg-surface-muted">
                    <ResultBody item={item} />
                  </Link>
                ) : (
                  <div className="px-4 py-3">
                    <ResultBody item={item} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ResultBody({ item }: { item: SearchResultItem }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        {item.reference && (
          <span className="font-mono text-xs text-content-muted">{item.reference}</span>
        )}
        <span className="text-sm font-medium text-content">{item.title}</span>
        {item.status && <StatusBadge tone="neutral">{item.status}</StatusBadge>}
      </span>
      {item.snippet && (
        <span className="mt-0.5 block text-xs text-content-muted">{item.snippet}</span>
      )}
    </>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
