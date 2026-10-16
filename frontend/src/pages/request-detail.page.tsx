import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  addComment,
  assignRequest,
  cancelRequest,
  getRequest,
  listComments,
  transitionRequest,
  type CommentVisibility,
  type RequestStatus,
} from '../api/requests.api';
import { ApprovalsPanel } from '../components/approvals-panel';
import { AttachmentPanel } from '../components/attachment-panel';
import { KnowledgePanel } from '../components/knowledge-panel';
import { RecordHistoryPanel } from '../components/record-history-panel';
import { SlaIndicator } from '../components/sla-indicator';
import { SlaOverrideForm } from '../components/sla-override-form';
import { StatusBadge } from '../components/status-badge';
import { TasksPanel } from '../components/tasks-panel';
import { useAuth } from '../hooks/auth-context';
import { priorityTone, statusTone } from '../utils/request-tones';

/**
 * Request detail (docs/22 §12). Actions are offered from the caller's permissions and the
 * current state, and the server is the authority on both: a transition the UI offers can
 * still be refused with `409 ILLEGAL_TRANSITION` or `403`, and that refusal is surfaced
 * rather than hidden.
 *
 * The audience of a comment is chosen explicitly before sending (docs/22 §6): the composer
 * never silently defaults an agent's note to public.
 */
export function RequestDetailPage() {
  const { id = '' } = useParams();
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'FULFILL' | 'CANCEL' | null>(null);
  const [note, setNote] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<CommentVisibility>('PUBLIC');

  const request = useQuery({
    queryKey: ['request', id],
    queryFn: ({ signal }) => getRequest(id, signal),
  });

  const comments = useQuery({
    queryKey: ['request', id, 'comments'],
    queryFn: ({ signal }) => listComments(id, {}, signal),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['request', id] });
    void queryClient.invalidateQueries({ queryKey: ['requests'] });
  };

  const transition = useMutation({
    mutationFn: (input: { to: RequestStatus; fulfilmentNote?: string }) =>
      transitionRequest(id, input),
    onSuccess: () => {
      setError(null);
      setPending(null);
      setNote('');
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const assign = useMutation({
    mutationFn: () => assignRequest(id, { assigneeId: user?.id ?? null }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const cancel = useMutation({
    mutationFn: (reason: string) => cancelRequest(id, reason),
    onSuccess: () => {
      setError(null);
      setPending(null);
      setNote('');
      refresh();
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const comment = useMutation({
    mutationFn: () => addComment(id, { body: commentBody, visibility: commentVisibility }),
    onSuccess: () => {
      setError(null);
      setCommentBody('');
      void queryClient.invalidateQueries({ queryKey: ['request', id, 'comments'] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  if (request.isPending) {
    return (
      <p role="status" className="text-sm text-content-muted">
        Loading request…
      </p>
    );
  }
  if (request.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {messageFor(request.error)}
      </p>
    );
  }

  const data = request.data.request;
  const isRequester = data.requester.id === user?.id;
  const canWork = hasPermission('request:update.any') || hasPermission('request:update.assigned');
  const canCloseAny = hasPermission('request:close.any');
  const canSeeInternal = canWork || hasPermission('request:read.any');

  const terminal = data.status === 'CLOSED' || data.status === 'CANCELLED';

  return (
    <div className="space-y-8">
      <div>
        <Link to="/requests" className="text-sm text-content-muted hover:text-content">
          ← All requests
        </Link>
      </div>

      <section aria-labelledby="request-heading" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-xs text-content-muted">{data.reference}</p>
            <h1 id="request-heading" className="text-2xl font-semibold text-content">
              {data.title}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {/* docs/25 §12: the detail header carries the SLA state and the time remaining,
                because a state without a number is not actionable. */}
            <SlaIndicator sla={data.sla} />
            <StatusBadge tone={priorityTone(data.priority)}>{data.priority}</StatusBadge>
            <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
          </div>
        </div>
        {data.description && <p className="max-w-3xl text-content-muted">{data.description}</p>}
      </section>

      {error && (
        <p
          role="alert"
          className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {/* Facts -------------------------------------------------------------- */}
      <section aria-labelledby="facts-heading" className="rounded-lg border border-border p-4">
        <h2 id="facts-heading" className="sr-only">
          Details
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Service" value={data.catalogItem.name} />
          <Fact label="Requester" value={data.requester.displayName} />
          <Fact label="Assignee" value={data.assignee?.displayName ?? 'Unassigned'} />
          <Fact label="Team" value={data.team?.name ?? '—'} />
          <Fact label="SLA policy" value={data.slaPolicy.name} />
          {/* The target instant, so the countdown in the header can be checked against the
              policy arithmetic rather than trusted blindly (docs/25 §12). */}
          <Fact
            label="SLA target"
            value={data.sla ? new Date(data.sla.targetAt).toLocaleString() : 'No live clock'}
          />
        </dl>

        {/* The only way a deadline moves by hand (docs/25 §11): shown to a caller the server
            would accept, with the reason mandatory and recorded alongside the before and
            after instants. */}
        {data.sla && hasPermission('sla:clock:override') && (
          <div className="mt-4 border-t border-border pt-4">
            <SlaOverrideForm clock={data.sla} onOverridden={refresh} />
          </div>
        )}

        {data.fields.length > 0 && (
          <dl className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            {data.fields.map((field) => (
              <Fact key={field.key} label={field.label} value={formatValue(field.value)} />
            ))}
          </dl>
        )}
      </section>

      {/* Actions ------------------------------------------------------------ */}
      {!terminal && (
        <section aria-labelledby="actions-heading" className="space-y-3">
          <h2 id="actions-heading" className="text-lg font-semibold text-content">
            Actions
          </h2>
          <div className="flex flex-wrap gap-2">
            {canWork && !data.assignee && (
              <button
                type="button"
                onClick={() => assign.mutate()}
                disabled={assign.isPending}
                className="rounded border border-border px-3 py-1.5 text-sm text-content disabled:opacity-60"
              >
                Assign to me
              </button>
            )}

            {canWork && data.status === 'NEW' && (
              <ActionButton
                label="Start triage"
                onClick={() => transition.mutate({ to: 'TRIAGED' })}
              />
            )}
            {/* The approval workflow is instantiated **on entry to `APPROVAL_PENDING`**
                (`approval.service.ts`), and `TRIAGED → APPROVAL_PENDING` is the only edge
                that starts it. Without this control a service that requires approval
                produces requests nothing can ever approve, so the action is part of the
                lifecycle, not an optional extra. It is offered only when the catalog item
                declares the requirement; the server re-checks and rejects it otherwise
                (`request.service.ts`). */}
            {canWork && data.status === 'TRIAGED' && data.catalogItem.requiresApproval && (
              <ActionButton
                label="Send for approval"
                onClick={() => transition.mutate({ to: 'APPROVAL_PENDING' })}
              />
            )}
            {canWork &&
              (data.status === 'TRIAGED' || data.status === 'APPROVED') &&
              data.assignee && (
                <ActionButton
                  label="Start work"
                  onClick={() => transition.mutate({ to: 'IN_PROGRESS' })}
                />
              )}
            {canWork && data.status === 'IN_PROGRESS' && (
              <ActionButton label="Mark fulfilled" onClick={() => setPending('FULFILL')} />
            )}
            {data.status === 'FULFILLED' && (isRequester || canCloseAny) && (
              <ActionButton label="Close" onClick={() => transition.mutate({ to: 'CLOSED' })} />
            )}
            {(isRequester || canCloseAny) && (
              <ActionButton label="Cancel" onClick={() => setPending('CANCEL')} variant="danger" />
            )}
          </div>

          {pending && (
            <form
              className="space-y-2 rounded border border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (pending === 'FULFILL')
                  transition.mutate({ to: 'FULFILLED', fulfilmentNote: note });
                else cancel.mutate(note);
              }}
            >
              {/* `htmlFor`/`id` rather than a wrapping label: this label is a sibling of
                  its control, and without the association the textarea has no accessible
                  name at all (docs/16 §accessibility). */}
              <label htmlFor="transition-note" className="block text-sm font-medium text-content">
                {pending === 'FULFILL' ? 'Fulfilment note (required)' : 'Reason (optional)'}
              </label>
              <textarea
                id="transition-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                required={pending === 'FULFILL'}
                className="w-full rounded border border-border bg-surface px-3 py-2 text-content"
              />
              <button
                type="submit"
                disabled={
                  (pending === 'FULFILL' && !note.trim()) ||
                  transition.isPending ||
                  cancel.isPending
                }
                className="rounded bg-brand px-3 py-1.5 text-sm text-content-inverted disabled:opacity-60"
              >
                Confirm
              </button>
            </form>
          )}
        </section>
      )}

      {/* Approval progress (docs/26 §12) ---------------------------------- */}
      <ApprovalsPanel requestId={data.id} requesterId={data.requester.id} />

      {/* Child tasks (docs/24 §10) ---------------------------------------- */}
      <TasksPanel
        parentType="REQUEST"
        parentId={data.id}
        canCreate={hasPermission('task:create')}
      />

      {/* Linked knowledge (docs/27 §9): the articles applied while fulfilling the request,
          each shown at the version that was linked (rule K6). */}
      <KnowledgePanel entityType="REQUEST" entityId={data.id} />

      {/* Files (docs/19 §7): same parent record, same visibility — the panel uploads and
          lists, and the server inherits this request's authorization rule. */}
      <AttachmentPanel entityType="ServiceRequest" entityId={data.id} />

      {/* Record history (docs/31 §11): the request's own audit trail, authorised by the
          request's visibility rather than by an audit grant. */}
      <RecordHistoryPanel entityType="ServiceRequest" entityId={data.id} />

      {/* Conversation ------------------------------------------------------ */}
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
            {canSeeInternal && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-content-muted">Audience</span>
                <select
                  value={commentVisibility}
                  onChange={(event) =>
                    setCommentVisibility(event.target.value as CommentVisibility)
                  }
                  className="rounded border border-border bg-surface px-2 py-1 text-content"
                >
                  <option value="PUBLIC">Public (requester sees this)</option>
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

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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
