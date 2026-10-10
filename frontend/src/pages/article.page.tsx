import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  archiveArticle,
  getArticle,
  publishArticle,
  recordArticleFeedback,
  rejectArticle,
  submitArticle,
  unarchiveArticle,
  updateArticle,
  type ArticleStatus,
  type ArticleVisibility,
} from '../api/kb.api';
import { Markdown } from '../components/markdown';
import { AttachmentPanel } from '../components/attachment-panel';
import { RecordHistoryPanel } from '../components/record-history-panel';
import { StatusBadge } from '../components/status-badge';
import { useAuth } from '../hooks/auth-context';
import type { Tone } from '../themes/tokens';

/**
 * Article detail (docs/27 §9, §11).
 *
 * The screen shows what the server returned: a reader is served the **published snapshot**
 * (`servingPublishedVersion`), so an author's uncommitted edit cannot leak to them, and an
 * archived article still resolves with a banner rather than 404ing (§11).
 */

const STATUS_TONE: Record<ArticleStatus, Tone> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'neutral',
};

const VISIBILITIES: ArticleVisibility[] = ['PUBLIC', 'INTERNAL', 'RESTRICTED'];

export function ArticlePage() {
  const { id = '' } = useParams();
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const canAuthor = hasPermission('kb:article:author');
  const canPublish = hasPermission('kb:article:publish');

  const article = useQuery({
    queryKey: ['kb-article', id],
    queryFn: ({ signal }) => getArticle(id, signal),
    enabled: id !== '',
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['kb-article', id] });
    void queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
  }

  const action = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const feedback = useMutation({
    mutationFn: (helpful: boolean) => recordArticleFeedback(id, helpful),
    onSuccess: refresh,
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  if (article.isPending) {
    return (
      <p role="status" className="text-sm text-content-muted">
        Loading article…
      </p>
    );
  }
  if (article.isError) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-danger">
          {messageFor(article.error)}
        </p>
        <Link to="/kb" className="text-sm text-brand underline">
          Back to the knowledge base
        </Link>
      </div>
    );
  }

  const value = article.data.article;
  const isAuthor = value.authorId === user?.id;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/kb" className="text-xs text-content-muted underline">
            Knowledge base
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-content">{value.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[value.status]}>{value.status}</StatusBadge>
            <StatusBadge tone="info">{value.visibility}</StatusBadge>
            <StatusBadge tone="neutral">v{value.version}</StatusBadge>
            {value.category && <StatusBadge tone="neutral">{value.category.name}</StatusBadge>}
          </div>
        </div>
        {canAuthor && value.status !== 'ARCHIVED' && (
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            className="rounded border border-border px-3 py-2 text-sm text-content"
          >
            {editing ? 'Close editor' : 'Edit'}
          </button>
        )}
      </div>

      {value.archived && (
        <p
          role="status"
          className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          This article is archived. It no longer appears in search, but links to it still resolve so
          history stays intact.
        </p>
      )}

      {value.hasUnpublishedChanges && (
        <p
          role="status"
          className="rounded border border-info/40 bg-info/10 px-3 py-2 text-sm text-info"
        >
          There are unpublished changes. Readers still see version {value.version} until the article
          is republished.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {editing && (
        <EditForm
          articleId={id}
          initial={{
            title: value.title,
            summary: value.summary,
            body: value.body,
            visibility: value.visibility,
          }}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
          onError={setError}
        />
      )}

      <article className="rounded-lg border border-border p-4">
        {value.summary && <p className="mb-3 text-content-muted">{value.summary}</p>}
        <Markdown source={value.body} />
      </article>

      <section aria-labelledby="kb-feedback" className="space-y-2">
        <h2 id="kb-feedback" className="text-sm font-semibold text-content">
          Did this resolve your issue?
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => feedback.mutate(true)}
            className="rounded border border-border px-3 py-1.5 text-sm text-content"
          >
            Yes, that helped
          </button>
          <button
            type="button"
            onClick={() => feedback.mutate(false)}
            className="rounded border border-border px-3 py-1.5 text-sm text-content"
          >
            No, it did not
          </button>
        </div>
      </section>

      {(canAuthor || canPublish) && (
        <section aria-labelledby="kb-lifecycle" className="space-y-2">
          <h2 id="kb-lifecycle" className="text-sm font-semibold text-content">
            Lifecycle
          </h2>
          <div className="flex flex-wrap gap-2">
            {canAuthor && value.status === 'DRAFT' && (
              <button
                type="button"
                onClick={() => action.mutate(() => submitArticle(id))}
                className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted"
              >
                Submit for review
              </button>
            )}
            {canPublish && value.status === 'IN_REVIEW' && (
              <>
                <button
                  type="button"
                  onClick={() => action.mutate(() => publishArticle(id))}
                  disabled={isAuthor}
                  title={
                    isAuthor
                      ? 'Publishing requires a reviewer distinct from the author (docs/27 K1).'
                      : undefined
                  }
                  className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted disabled:opacity-50"
                >
                  Publish
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const reason = window.prompt('Why is this article being rejected?') ?? '';
                    if (reason.trim().length > 0) {
                      action.mutate(() => rejectArticle(id, reason));
                    }
                  }}
                  className="rounded border border-border px-3 py-2 text-sm text-content"
                >
                  Reject
                </button>
              </>
            )}
            {canPublish && value.status === 'PUBLISHED' && value.hasUnpublishedChanges && (
              <button
                type="button"
                onClick={() => action.mutate(() => publishArticle(id))}
                disabled={isAuthor}
                title={
                  isAuthor
                    ? 'Publishing requires a reviewer distinct from the author (docs/27 K1).'
                    : undefined
                }
                className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted disabled:opacity-50"
              >
                Publish changes
              </button>
            )}
            {canPublish && value.status !== 'ARCHIVED' && (
              <button
                type="button"
                onClick={() => {
                  const reason = window.prompt('Why is this article being archived?') ?? '';
                  action.mutate(() => archiveArticle(id, reason || undefined));
                }}
                className="rounded border border-border px-3 py-2 text-sm text-content"
              >
                Archive
              </button>
            )}
            {canPublish && value.status === 'ARCHIVED' && (
              <button
                type="button"
                onClick={() => action.mutate(() => unarchiveArticle(id))}
                className="rounded border border-border px-3 py-2 text-sm text-content"
              >
                Unarchive
              </button>
            )}
          </div>
          <p className="text-xs text-content-muted">
            Bodies are Markdown. Raw HTML is rejected on write and escaped on render.
          </p>
        </section>
      )}

      {/* Files on the article (docs/19 §7): an authoring grant is offered the upload,
          visibility still follows the article's own class (rule K3). */}
      <AttachmentPanel
        entityType="Article"
        entityId={value.id}
        canUpload={canAuthor || canPublish}
      />

      {/* Record history (docs/31 §11): the article's own audit trail, authorised by the
          article's visibility class (rule K3) rather than a blanket read permission. */}
      <RecordHistoryPanel entityType="Article" entityId={value.id} />
    </div>
  );
}

function EditForm({
  articleId,
  initial,
  onSaved,
  onError,
}: {
  articleId: string;
  initial: { title: string; summary: string | null; body: string; visibility: ArticleVisibility };
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [summary, setSummary] = useState(initial.summary ?? '');
  const [body, setBody] = useState(initial.body);
  const [visibility, setVisibility] = useState<ArticleVisibility>(initial.visibility);

  const save = useMutation({
    mutationFn: () =>
      updateArticle(articleId, { title, summary: summary || null, body, visibility }),
    onSuccess: onSaved,
    onError: (error) => onError(messageFor(error)),
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-sm font-semibold text-content">Edit working copy</h2>
      <label className="block text-sm">
        <span className="text-content-muted">Title</span>
        <input
          value={title}
          minLength={3}
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
        <span className="text-content-muted">Body</span>
        <textarea
          rows={10}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface px-3 py-1.5 font-mono text-content"
        />
      </label>
      <label className="block text-sm">
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
      <button
        type="submit"
        disabled={save.isPending}
        className="rounded bg-brand px-3 py-2 text-sm font-medium text-content-inverted disabled:opacity-60"
      >
        {save.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
