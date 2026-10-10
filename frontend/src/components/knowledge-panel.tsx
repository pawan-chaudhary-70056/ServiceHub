import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { linkArticle, listKnowledgeLinks, type KnowledgeEntityType } from '../api/kb.api';
import { search } from '../api/search.api';
import { StatusBadge } from './status-badge';
import { useAuth } from '../hooks/auth-context';

/**
 * Knowledge links on a record (docs/27 §9, rules K6/K7).
 *
 * This is the panel that makes the knowledge base a capability rather than a document
 * store: an article found while resolving a record is *attached to the record*, so the
 * resolution can be explained afterwards.
 *
 * Two properties come straight from the API and are shown, not recomputed:
 *
 *   - the link stores the **version applied at the time** (K6) — the reader sees what the
 *     resolver read, even after the article is edited or republished;
 *   - an archived article still resolves, flagged with a banner (K7), rather than the link
 *     rotting into a 404.
 */

export interface KnowledgePanelProps {
  entityType: KnowledgeEntityType;
  entityId: string;
}

export function KnowledgePanel({ entityType, entityId }: KnowledgePanelProps) {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canLink = hasPermission('kb:article:read');

  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState<string | null>(null);

  const links = useQuery({
    queryKey: ['knowledge-links', entityType, entityId],
    queryFn: ({ signal }) => listKnowledgeLinks(entityType, entityId, signal),
  });

  // Suggestions come from the same scoped search the rest of the app uses, so a
  // restricted article the caller may not read can never be suggested here (rule K3).
  const suggestions = useQuery({
    queryKey: ['knowledge-suggestions', submitted],
    queryFn: ({ signal }) => search({ q: submitted, types: ['ARTICLE'], limit: 5 }, signal),
    enabled: submitted.trim().length > 0,
  });

  const link = useMutation({
    mutationFn: (articleId: string) => linkArticle(entityType, entityId, articleId),
    onSuccess: () => {
      setError(null);
      setTerm('');
      setSubmitted('');
      void queryClient.invalidateQueries({ queryKey: ['knowledge-links', entityType, entityId] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const items = links.data?.items ?? [];
  const linkedIds = new Set(items.map((item) => item.articleId));
  const candidates = (suggestions.data?.items ?? []).filter((item) => !linkedIds.has(item.id));

  return (
    <section aria-labelledby="knowledge-heading" className="space-y-3">
      <h2 id="knowledge-heading" className="text-lg font-semibold text-content">
        Knowledge
      </h2>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {links.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading linked articles…
        </p>
      )}
      {links.isSuccess && items.length === 0 && (
        <p className="text-sm text-content-muted">No knowledge linked to this record yet.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border">
          {items.map((item) => (
            <li key={item.id} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  to={`/kb/${item.articleId}`}
                  className="text-sm font-medium text-brand underline"
                >
                  {item.title}
                </Link>
                <span className="flex items-center gap-2">
                  <StatusBadge tone="neutral">v{item.articleVersion}</StatusBadge>
                  {item.archived && <StatusBadge tone="warning">Archived</StatusBadge>}
                </span>
              </div>
              {item.linkedBody && (
                <details className="text-xs text-content-muted">
                  <summary className="cursor-pointer">What was applied at the time</summary>
                  <p className="mt-1 whitespace-pre-wrap">{item.linkedBody}</p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {canLink && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(term.trim());
          }}
        >
          <label className="min-w-64 flex-1 space-y-1 text-sm">
            <span className="block font-medium text-content">Link a knowledge article</span>
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search published articles"
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
          </label>
          <button
            type="submit"
            className="rounded border border-border px-4 py-2 text-sm text-content"
          >
            Find
          </button>
        </form>
      )}

      {submitted && suggestions.isSuccess && candidates.length === 0 && (
        <p className="text-sm text-content-muted">
          No readable published articles match that term.
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="text-sm text-content">{candidate.title}</span>
                {candidate.snippet && (
                  <span
                    className="mt-0.5 block text-xs text-content-muted"
                    // `ts_headline` markup is escaped by the server before it is stored;
                    // the snippet is rendered as text here, never as HTML.
                  >
                    {stripTags(candidate.snippet)}
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={link.isPending}
                onClick={() => link.mutate(candidate.id)}
                className="rounded border border-border px-3 py-1 text-xs text-content disabled:opacity-60"
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-content-muted">
        A link records the article version applied, so the record shows what was actually read.
      </p>
    </section>
  );
}

/**
 * `ts_headline` returns `<b>`-wrapped terms. The highlight is presentational, and the
 * snippet is a text node — so the tags are removed rather than rendered (docs/17).
 */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.errors.length > 0) {
      return `${error.message} (${error.errors.map((detail) => detail.message).join('; ')})`;
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
