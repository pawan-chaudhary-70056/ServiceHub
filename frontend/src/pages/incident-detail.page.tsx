import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  addComment,
  assignIncident,
  closeIncident,
  getIncident,
  listComments,
  reopenIncident,
  resolveIncident,
  setIncidentMajor,
  updateIncident,
  type CommentVisibility,
  type IncidentImpact,
  type IncidentPriority,
  type IncidentUrgency,
} from '../api/incidents.api';
import { StatusBadge } from '../components/status-badge';
import { TasksPanel } from '../components/tasks-panel';
import { useAuth } from '../hooks/auth-context';
import { incidentStatusTone, priorityTone } from '../utils/request-tones';

/**
 * Incident detail (docs/23 §11).
 *
 * Actions are offered from the caller's permissions and the current state, and the server
 * is the authority on both: a move the UI offers can still be refused (`409`, `403`, or
 * `422` for a missing reason), and that refusal is surfaced rather than hidden. The
 * major-incident banner is deliberately prominent so a major incident cannot be forgotten
 * (§11).
 */
export function IncidentDetailPage() {
  const { id = '' } = useParams();
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [resolving, setResolving] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [overridePriority, setOverridePriority] = useState<IncidentPriority | ''>('');
  const [overrideReason, setOverrideReason] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<CommentVisibility>('PUBLIC');

  const incident = useQuery({
    queryKey: ['incident', id],
    queryFn: ({ signal }) => getIncident(id, signal),
  });

  const comments = useQuery({
    queryKey: ['incident', id, 'comments'],
    queryFn: ({ signal }) => listComments(id, {}, signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['incident', id] });
    void queryClient.invalidateQueries({ queryKey: ['incidents'] });
  };

  const run = <TInput,>(mutation: (input: TInput) => Promise<unknown>) => ({
    mutationFn: mutation,
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (mutationError: unknown) => setError(messageFor(mutationError)),
  });

  const assign = useMutation(
    run((assigneeId: string | null) => assignIncident(id, { assigneeId })),
  );
  const resolve = useMutation(run((summary: string) => resolveIncident(id, summary)));
  const close = useMutation(run(() => closeIncident(id)));
  const reopen = useMutation(run((reason: string) => reopenIncident(id, reason || undefined)));
  const major = useMutation(run((value: boolean) => setIncidentMajor(id, value)));
  const patch = useMutation(
    run(
      (input: {
        impact?: IncidentImpact;
        urgency?: IncidentUrgency;
        priority?: IncidentPriority;
        reason?: string;
      }) => updateIncident(id, input),
    ),
  );
  const comment = useMutation({
    mutationFn: () => addComment(id, { body: commentBody, visibility: commentVisibility }),
    onSuccess: () => {
      setError(null);
      setCommentBody('');
      void queryClient.invalidateQueries({ queryKey: ['incident', id, 'comments'] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  if (incident.isPending) {
    return (
      <p role="status" className="text-sm text-content-muted">
        Loading incident…
      </p>
    );
  }
  if (incident.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {messageFor(incident.error)}
      </p>
    );
  }

  const data = incident.data.incident;
  const isReporter = data.reporter.id === user?.id;
  const canUpdate = hasPermission('incident:update.any');
  const canOverride = hasPermission('incident:priority:override');
  const terminal = data.status === 'CLOSED';

  return (
    <div className="space-y-8">
      {data.isMajor && (
        <div
          role="status"
          className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 font-semibold text-danger"
        >
          Major incident in progress — widen communication and post periodic updates until resolved.
        </div>
      )}

      <div>
        <Link to="/incidents" className="text-sm text-content-muted hover:text-content">
          ← All incidents
        </Link>
      </div>

      <section aria-labelledby="incident-heading" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-xs text-content-muted">{data.reference}</p>
            <h1 id="incident-heading" className="text-2xl font-semibold text-content">
              {data.title}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge tone={priorityTone(data.priority)}>{data.priority}</StatusBadge>
            <StatusBadge tone={incidentStatusTone(data.status)}>{data.status}</StatusBadge>
          </div>
        </div>
        <p className="max-w-3xl whitespace-pre-wrap text-content-muted">{data.description}</p>
        {data.reopenCount > 0 && (
          <p className="text-sm text-content-muted">Reopened {data.reopenCount} time(s).</p>
        )}
      </section>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <section aria-labelledby="facts-heading" className="rounded-lg border border-border p-4">
        <h2 id="facts-heading" className="sr-only">
          Details
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Impact" value={data.impact} />
          <Fact label="Urgency" value={data.urgency} />
          <Fact label="Reporter" value={data.reporter.displayName} />
          <Fact label="Assignee" value={data.assignee?.displayName ?? 'Unassigned'} />
          <Fact label="Team" value={data.team?.name ?? '—'} />
          <Fact label="SLA policy" value={data.slaPolicy.name} />
        </dl>
        {data.resolutionSummary && (
          <div className="mt-4 border-t border-border pt-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">
              Resolution
            </dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-content">
              {data.resolutionSummary}
            </dd>
          </div>
        )}
      </section>

      <section aria-labelledby="actions-heading" className="space-y-3">
        <h2 id="actions-heading" className="text-lg font-semibold text-content">
          Actions
        </h2>

        {!terminal && (
          <div className="flex flex-wrap gap-2">
            {canUpdate && !data.assignee && (
              <ActionButton label="Assign to me" onClick={() => assign.mutate(user?.id ?? null)} />
            )}
            {canUpdate && data.status === 'IN_PROGRESS' && (
              <ActionButton label="Resolve" onClick={() => setResolving((v) => !v)} />
            )}
            {data.status === 'RESOLVED' && (isReporter || canUpdate) && (
              <ActionButton label="Close" onClick={() => close.mutate()} />
            )}
            {(data.status === 'RESOLVED' || data.status === 'CLOSED') &&
              (isReporter || canUpdate) && (
                <ActionButton label="Reopen" onClick={() => setReopening((v) => !v)} />
              )}
            {canUpdate && (
              <ActionButton
                label={data.isMajor ? 'Clear major flag' : 'Declare major'}
                onClick={() => major.mutate(!data.isMajor)}
                variant={data.isMajor ? 'primary' : 'danger'}
              />
            )}
          </div>
        )}

        {resolving && (
          <form
            className="space-y-2 rounded border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (resolution.trim()) {
                resolve.mutate(resolution.trim());
                setResolving(false);
                setResolution('');
              }
            }}
          >
            <label className="block text-sm font-medium text-content">
              Resolution summary (required)
            </label>
            <textarea
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
              rows={3}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
            <button
              type="submit"
              disabled={!resolution.trim() || resolve.isPending}
              className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
            >
              Resolve incident
            </button>
          </form>
        )}

        {reopening && (
          <form
            className="space-y-2 rounded border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              reopen.mutate(reopenReason);
              setReopening(false);
              setReopenReason('');
            }}
          >
            <label className="block text-sm font-medium text-content">
              Reason (required only outside the reopen window)
            </label>
            <textarea
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              rows={2}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
            />
            <button
              type="submit"
              disabled={reopen.isPending}
              className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
            >
              Reopen incident
            </button>
          </form>
        )}

        {canOverride && canUpdate && data.status !== 'CLOSED' && (
          <form
            className="space-y-2 rounded border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (overridePriority) {
                patch.mutate({ priority: overridePriority, reason: overrideReason });
                setOverridePriority('');
                setOverrideReason('');
              }
            }}
          >
            <p className="text-sm font-medium text-content">Override derived priority</p>
            <p className="text-xs text-content-muted">
              Derived from impact and urgency; overriding requires a reason and is audited.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={overridePriority}
                onChange={(event) =>
                  setOverridePriority(event.target.value as IncidentPriority | '')
                }
                className="rounded border border-border bg-surface px-3 py-1.5 text-content"
              >
                <option value="">Choose a priority…</option>
                {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as IncidentPriority[]).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <input
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Reason (required)"
                className="min-w-64 flex-1 rounded border border-border bg-surface px-3 py-1.5 text-content"
              />
              <button
                type="submit"
                disabled={!overridePriority || !overrideReason.trim() || patch.isPending}
                className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
              >
                Override
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Child tasks (docs/24 §10) ---------------------------------------- */}
      <TasksPanel
        parentType="INCIDENT"
        parentId={data.id}
        canCreate={hasPermission('task:create')}
      />

      <section aria-labelledby="conversation-heading" className="space-y-3">
        <h2 id="conversation-heading" className="text-lg font-semibold text-content">
          Conversation
        </h2>

        {comments.isPending && (
          <p role="status" className="text-sm text-content-muted">
            Loading…
          </p>
        )}
        {comments.isSuccess && comments.data.items.length === 0 && (
          <p className="text-sm text-content-muted">No comments yet.</p>
        )}
        {comments.isSuccess && comments.data.items.length > 0 && (
          <ul className="space-y-3">
            {comments.data.items.map((item) => (
              <li key={item.id} className="rounded border border-border p-3">
                <p className="text-sm">
                  <span className="font-medium text-content">{item.author.displayName}</span>
                  <span className="ml-2 text-xs text-content-muted">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                  {item.visibility === 'INTERNAL' && (
                    <StatusBadge tone="warning">
                      <span className="ml-1">Internal</span>
                    </StatusBadge>
                  )}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-content">{item.body}</p>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (commentBody.trim()) comment.mutate();
          }}
        >
          <textarea
            aria-label="Add a comment"
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
            rows={3}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
          />
          <div className="flex flex-wrap items-center gap-3">
            {canUpdate && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-content-muted">Audience</span>
                <select
                  value={commentVisibility}
                  onChange={(event) =>
                    setCommentVisibility(event.target.value as CommentVisibility)
                  }
                  className="rounded border border-border bg-surface px-2 py-1 text-content"
                >
                  <option value="PUBLIC">Public (reporter sees this)</option>
                  <option value="INTERNAL">Internal (team only)</option>
                </select>
              </label>
            )}
            <button
              type="submit"
              disabled={comment.isPending || !commentBody.trim()}
              className="rounded bg-brand px-4 py-2 text-sm text-content-inverted disabled:opacity-60"
            >
              {comment.isPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-content-muted">{label}</dt>
      <dd className="text-sm text-content">{value}</dd>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  variant = 'primary',
}: {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        variant === 'danger'
          ? 'rounded border border-danger/40 px-3 py-1.5 text-sm text-danger'
          : 'rounded bg-brand px-3 py-1.5 text-sm text-content-inverted'
      }
    >
      {label}
    </button>
  );
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
