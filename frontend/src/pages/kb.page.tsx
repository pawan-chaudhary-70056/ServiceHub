import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  createArticle,
  listArticles,
  listArticleCategories,
  type ArticleListItem,
  type ArticleStatus,
  type ArticleVisibility,
} from '../api/kb.api';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';
import type { Tone } from '../themes/tokens';

/**
 * Knowledge base browse (docs/27 §9).
 *
 * The list is visibility-filtered **server-side** (rule K3); this screen never filters by
 * visibility itself, because a client-side filter is not a control. The authoring form is
 * shown only to a caller with `kb:article:author` — and the server re-checks it.
 */

const STATUS_TONE: Record<ArticleStatus, Tone> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'neutral',
};

const VISIBILITIES: ArticleVisibility[] = ['PUBLIC', 'INTERNAL', 'RESTRICTED'];

export function KbPage() {
  const { hasPermission } = useAuth();
  const canAuthor = hasPermission('kb:article:author');

  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<ArticleStatus | ''>('');
  const [showForm, setShowForm] = useState(false);

  const articles = useQuery({
    queryKey: ['kb-articles', { categoryId, status }],
    queryFn: ({ signal }) =>
      listArticles(
        {
          ...(categoryId ? { categoryId } : {}),
          ...(status ? { status } : {}),
        },
        signal,
      ),
  });

  const categories = useQuery({
    queryKey: ['kb-categories'],
    queryFn: ({ signal }) => listArticleCategories(signal),
  });

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="kb-heading"
        className="flex flex-wrap items-start justify-between gap-3"
      >
        <div>
          <h1 id="kb-heading" className="text-2xl font-semibold text-content">
            Knowledge base
          </h1>
          <p className="mt-2 max-w-3xl text-content-muted">
            Self-service articles. What you can see here is what the server decided you may read —
            published articles, filtered by their visibility class.
          </p>
        </div>
        {canAuthor && (
          <button
            type="button"
            onClick={() => setShowForm((open) => !open)}
            className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted"
          >
            {showForm ? 'Close editor' : 'New article'}
          </button>
        )}
      </section>

      {showForm && canAuthor && (
        <NewArticleForm
          categories={categories.data?.items ?? []}
          onCreated={() => {
            setShowForm(false);
          }}
        />
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-content-muted">Category</span>
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            <option value="">All</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({category.articleCount})
              </option>
            ))}
          </select>
        </label>
        {canAuthor && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-content-muted">Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ArticleStatus | '')}
              className="rounded border border-border bg-surface px-3 py-1.5 text-content"
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="IN_REVIEW">In review</option>
              <option value="PUBLISHED">Published</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </label>
        )}
      </div>

      {articles.isPending && (
        <p role="status" className="text-sm text-content-muted">
          Loading articles…
        </p>
      )}
      {articles.isError && (
        <p role="alert" className="text-sm text-danger">
          {messageFor(articles.error)}
        </p>
      )}
      {articles.isSuccess && articles.data.items.length === 0 && (
        <p className="text-sm text-content-muted">No articles match this filter.</p>
      )}

      {articles.isSuccess && articles.data.items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {articles.data.items.map((article: ArticleListItem) => (
            <li key={article.id}>
              <Link
                to={`/kb/${article.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium text-content">{article.title}</span>
                  {article.summary && (
                    <span className="mt-0.5 block truncate text-xs text-content-muted">
                      {article.summary}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-content-muted">
                    {article.category?.name ?? 'Uncategorised'} · v{article.version}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge tone="info">{article.visibility}</StatusBadge>
                  <StatusBadge tone={STATUS_TONE[article.status]}>{article.status}</StatusBadge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewArticleForm({
  categories,
  onCreated,
}: {
  categories: Array<{ id: string; name: string }>;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<ArticleVisibility>('INTERNAL');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createArticle({
        title,
        summary: summary || null,
        body,
        visibility,
        categoryId: categoryId || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
      setTitle('');
      setSummary('');
      setBody('');
      setError(null);
      onCreated();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-lg font-semibold text-content">New article</h2>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <label className="block text-sm">
        <span className="text-content-muted">Title</span>
        <input
          required
          minLength={3}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
        />
      </label>
      <label className="block text-sm">
        <span className="text-content-muted">Summary</span>
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 text-content"
        />
      </label>
      <label className="block text-sm">
        <span className="text-content-muted">
          Body (Markdown — raw HTML is rejected, docs/27 K2)
        </span>
        <textarea
          required
          rows={8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 font-mono text-content"
        />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="text-sm">
          <span className="text-content-muted">Visibility</span>
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as ArticleVisibility)}
            className="mt-1 block rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            {VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-content-muted">Category</span>
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="mt-1 block rounded border border-border bg-surface px-3 py-1.5 text-content"
          >
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="submit"
        disabled={create.isPending}
        className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted disabled:opacity-60"
      >
        {create.isPending ? 'Saving…' : 'Create draft'}
      </button>
    </form>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
